import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  MenuItem,
  Slider,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import SaveIcon from '@mui/icons-material/Save';
import {
  fixtureLedCount,
  mapFixture,
  type Fixture,
  type FixtureGeometry,
  type Installation,
} from '@ewc/core';
import { useInstallation, useSaveInstallation } from '../api/stage.js';
import { useDevices } from '../api/devices.js';
import { md3 } from '../theme/tokens.js';

let idSeq = 0;
const newId = () => `fx-${Date.now().toString(36)}-${idSeq++}`;

function defaultGeometry(kind: FixtureGeometry['kind'], leds: number): FixtureGeometry {
  if (kind === 'matrix') {
    const w = Math.max(1, Math.round(Math.sqrt(leds)));
    return { kind: 'matrix', width: w, height: Math.max(1, Math.ceil(leds / w)), serpentine: true, origin: 'top-left' };
  }
  if (kind === 'points') return { kind: 'points', points: [] };
  return { kind: 'strip', count: leds };
}

function AddFixtureDialog({
  open,
  onClose,
  onAdd,
  devices,
}: {
  open: boolean;
  onClose: () => void;
  onAdd: (f: Fixture) => void;
  devices: { id: number; name: string; ledCount: number | null }[];
}) {
  const [deviceId, setDeviceId] = useState<number | ''>('');
  const [name, setName] = useState('');
  const [kind, setKind] = useState<FixtureGeometry['kind']>('strip');
  const [startIndex, setStartIndex] = useState(0);
  const dev = devices.find((d) => d.id === deviceId);
  const leds = dev?.ledCount ?? 60;

  const submit = () => {
    if (deviceId === '') return;
    onAdd({
      id: newId(),
      deviceId,
      name: name.trim() || `${dev?.name ?? 'Fixture'} run`,
      startIndex,
      geometry: defaultGeometry(kind, Math.max(1, leds - startIndex)),
      transform: { position: { x: 8, y: 4.5 }, rotationDeg: 0, size: { x: 8, y: kind === 'matrix' ? 4.5 : 1 } },
      enabled: true,
    });
    setName('');
    setStartIndex(0);
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>Add fixture</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 0.5 }}>
          <TextField select label="Device" value={deviceId} onChange={(e) => setDeviceId(Number(e.target.value))} fullWidth>
            {devices.map((d) => (
              <MenuItem key={d.id} value={d.id}>
                {d.name} ({d.ledCount ?? '?'} LEDs)
              </MenuItem>
            ))}
          </TextField>
          <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} fullWidth />
          <TextField select label="Geometry" value={kind} onChange={(e) => setKind(e.target.value as FixtureGeometry['kind'])} fullWidth>
            <MenuItem value="strip">Strip</MenuItem>
            <MenuItem value="matrix">Matrix</MenuItem>
          </TextField>
          <TextField
            type="number"
            label="Start LED index on device"
            value={startIndex}
            onChange={(e) => setStartIndex(Math.max(0, Number(e.target.value)))}
            helperText="Wire index where this fixture's first LED sits."
            fullWidth
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button color="inherit" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="contained" disabled={deviceId === ''} onClick={submit}>
          Add
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export function LayoutPage() {
  const { data: saved } = useInstallation();
  const save = useSaveInstallation();
  const { data: devices } = useDevices();

  const [inst, setInst] = useState<Installation | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [dirty, setDirty] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null);

  useEffect(() => {
    if (saved && !dirty) setInst(saved);
  }, [saved, dirty]);

  const deviceOpts = useMemo(
    () => (devices ?? []).map((d) => ({ id: d.id, name: d.name, ledCount: d.ledCount })),
    [devices],
  );

  if (!inst) return null;
  const selected = inst.fixtures.find((f) => f.id === selectedId) ?? null;

  const update = (next: Installation) => {
    setDirty(true);
    setInst(next);
  };
  const patchFixture = (id: string, patch: Partial<Fixture>) =>
    update({ ...inst, fixtures: inst.fixtures.map((f) => (f.id === id ? { ...f, ...patch } : f)) });
  const patchTransform = (id: string, t: Partial<Fixture['transform']>) => {
    const f = inst.fixtures.find((x) => x.id === id);
    if (f) patchFixture(id, { transform: { ...f.transform, ...t } });
  };

  const toCanvas = (evt: React.PointerEvent): { x: number; y: number } => {
    const svg = svgRef.current!;
    const rect = svg.getBoundingClientRect();
    return {
      x: ((evt.clientX - rect.left) / rect.width) * inst.canvas.width,
      y: ((evt.clientY - rect.top) / rect.height) * inst.canvas.height,
    };
  };

  const onFixturePointerDown = (evt: React.PointerEvent, f: Fixture) => {
    evt.stopPropagation();
    (evt.target as Element).setPointerCapture(evt.pointerId);
    setSelectedId(f.id);
    const p = toCanvas(evt);
    drag.current = { id: f.id, dx: f.transform.position.x - p.x, dy: f.transform.position.y - p.y };
  };
  const onPointerMove = (evt: React.PointerEvent) => {
    if (!drag.current) return;
    const p = toCanvas(evt);
    patchTransform(drag.current.id, {
      position: {
        x: clamp(p.x + drag.current.dx, 0, inst.canvas.width),
        y: clamp(p.y + drag.current.dy, 0, inst.canvas.height),
      },
    });
  };
  const onPointerUp = () => {
    drag.current = null;
  };

  const vb = `0 0 ${inst.canvas.width} ${inst.canvas.height}`;

  return (
    <Stack spacing={3}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" flexWrap="wrap" gap={1}>
        <Box>
          <Typography variant="h2">Layout</Typography>
          <Typography variant="body2" color="text.secondary">
            Place each fixture on the virtual canvas. Effects (milestone 4) render to this canvas.
          </Typography>
        </Box>
        <Stack direction="row" spacing={1}>
          <Button startIcon={<AddIcon />} variant="outlined" onClick={() => setAddOpen(true)} disabled={deviceOpts.length === 0}>
            Add fixture
          </Button>
          <Button
            startIcon={<SaveIcon />}
            variant="contained"
            disabled={!dirty || save.isPending}
            onClick={() =>
              save.mutate(inst, {
                onSuccess: () => {
                  setDirty(false);
                },
              })
            }
          >
            {save.isPending ? 'Saving…' : dirty ? 'Save' : 'Saved'}
          </Button>
        </Stack>
      </Stack>

      {deviceOpts.length === 0 && <Alert severity="info">Add a device first, then place its fixtures here.</Alert>}

      <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', md: '1fr 320px' } }}>
        <Card>
          <CardContent sx={{ p: 1 }}>
            <Box
              component="svg"
              ref={svgRef}
              viewBox={vb}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerLeave={onPointerUp}
              // Fixture handlers stopPropagation, so this only fires for the
              // empty canvas.
              onPointerDown={() => setSelectedId(null)}
              sx={{
                width: '100%',
                aspectRatio: `${inst.canvas.width} / ${inst.canvas.height}`,
                bgcolor: md3.surfaceContainerLowest,
                borderRadius: 2,
                touchAction: 'none',
              }}
            >
              <defs>
                <pattern id="grid" width="1" height="1" patternUnits="userSpaceOnUse">
                  <path d="M1 0 L0 0 0 1" fill="none" stroke={md3.outlineVariant} strokeWidth="0.02" />
                </pattern>
              </defs>
              <rect x={0} y={0} width={inst.canvas.width} height={inst.canvas.height} fill="url(#grid)" />

              {inst.fixtures.map((f) => {
                const leds = mapFixture(f, inst.canvas);
                const isSel = f.id === selectedId;
                const xs = leds.map((l) => l.x * inst.canvas.width);
                const ys = leds.map((l) => l.y * inst.canvas.height);
                const cx = xs.length ? (Math.min(...xs) + Math.max(...xs)) / 2 : f.transform.position.x;
                const labelY = (ys.length ? Math.max(...ys) : f.transform.position.y) + 0.42;
                return (
                  <g key={f.id} onPointerDown={(e) => onFixturePointerDown(e, f)} style={{ cursor: 'grab' }}>
                    <g transform={`translate(${f.transform.position.x} ${f.transform.position.y}) rotate(${f.transform.rotationDeg})`}>
                      <rect
                        x={-f.transform.size.x / 2}
                        y={-f.transform.size.y / 2}
                        width={f.transform.size.x}
                        height={f.transform.size.y}
                        rx={0.15}
                        fill={isSel ? `${md3.primary}22` : `${md3.onSurfaceVariant}14`}
                        stroke={isSel ? md3.primary : md3.outline}
                        strokeWidth={isSel ? 0.06 : 0.03}
                      />
                    </g>
                    {leds.map((l, i) => (
                      <circle
                        key={i}
                        cx={l.x * inst.canvas.width}
                        cy={l.y * inst.canvas.height}
                        r={0.07}
                        fill={i === 0 ? md3.primary : md3.onSurface}
                        opacity={f.enabled ? 0.9 : 0.3}
                      />
                    ))}
                    <text
                      x={cx}
                      y={labelY}
                      textAnchor="middle"
                      dominantBaseline="hanging"
                      fontSize={0.4}
                      fontWeight={600}
                      fill={isSel ? md3.primary : md3.onSurface}
                      opacity={f.enabled ? 0.85 : 0.4}
                      style={{ paintOrder: 'stroke', stroke: md3.surfaceContainerLowest, strokeWidth: 0.12 }}
                    >
                      {f.name}
                    </text>
                  </g>
                );
              })}
            </Box>
          </CardContent>
        </Card>

        <Card>
          <CardContent>
            {!selected ? (
              <Typography variant="body2" color="text.secondary">
                {inst.fixtures.length === 0 ? 'No fixtures yet.' : 'Select a fixture to edit it.'}
              </Typography>
            ) : (
              <Stack spacing={2}>
                <TextField
                  label="Name"
                  size="small"
                  value={selected.name}
                  onChange={(e) => patchFixture(selected.id, { name: e.target.value })}
                />
                <Typography variant="caption" color="text.secondary">
                  Device #{selected.deviceId} · LEDs {selected.startIndex}–
                  {selected.startIndex + fixtureLedCount(selected.geometry) - 1}
                </Typography>

                {selected.geometry.kind === 'strip' && (
                  <TextField
                    type="number"
                    size="small"
                    label="LED count"
                    value={selected.geometry.count}
                    onChange={(e) =>
                      patchFixture(selected.id, { geometry: { kind: 'strip', count: Math.max(0, Number(e.target.value)) } })
                    }
                  />
                )}
                {selected.geometry.kind === 'matrix' && (
                  <Stack direction="row" spacing={1}>
                    <TextField
                      type="number" size="small" label="W"
                      value={selected.geometry.width}
                      onChange={(e) =>
                        patchFixture(selected.id, {
                          geometry: { ...(selected.geometry as Extract<FixtureGeometry, { kind: 'matrix' }>), width: Math.max(1, Number(e.target.value)) },
                        })
                      }
                    />
                    <TextField
                      type="number" size="small" label="H"
                      value={selected.geometry.height}
                      onChange={(e) =>
                        patchFixture(selected.id, {
                          geometry: { ...(selected.geometry as Extract<FixtureGeometry, { kind: 'matrix' }>), height: Math.max(1, Number(e.target.value)) },
                        })
                      }
                    />
                  </Stack>
                )}

                <Divider />
                <Box>
                  <Typography variant="subtitle2">Rotation · {Math.round(selected.transform.rotationDeg)}°</Typography>
                  <Slider
                    min={0} max={360}
                    value={selected.transform.rotationDeg}
                    onChange={(_, v) => patchTransform(selected.id, { rotationDeg: v as number })}
                  />
                </Box>
                <Stack direction="row" spacing={1}>
                  <TextField
                    type="number" size="small" label="Width (canvas)"
                    value={round(selected.transform.size.x)}
                    onChange={(e) => patchTransform(selected.id, { size: { ...selected.transform.size, x: Number(e.target.value) } })}
                  />
                  <TextField
                    type="number" size="small" label="Height (canvas)"
                    value={round(selected.transform.size.y)}
                    onChange={(e) => patchTransform(selected.id, { size: { ...selected.transform.size, y: Number(e.target.value) } })}
                  />
                </Stack>

                <Divider />
                <Stack direction="row" justifyContent="space-between" alignItems="center">
                  <Button
                    size="small"
                    onClick={() => patchFixture(selected.id, { enabled: !selected.enabled })}
                  >
                    {selected.enabled ? 'Disable' : 'Enable'}
                  </Button>
                  <IconButton
                    color="error"
                    onClick={() => {
                      update({ ...inst, fixtures: inst.fixtures.filter((f) => f.id !== selected.id) });
                      setSelectedId(null);
                    }}
                  >
                    <DeleteOutlineIcon />
                  </IconButton>
                </Stack>
              </Stack>
            )}

            <Divider sx={{ my: 2 }} />
            <Typography variant="subtitle2" gutterBottom>
              Canvas
            </Typography>
            <Stack direction="row" spacing={1}>
              <TextField
                type="number" size="small" label="Width"
                value={inst.canvas.width}
                onChange={(e) => update({ ...inst, canvas: { ...inst.canvas, width: Math.max(1, Number(e.target.value)) } })}
              />
              <TextField
                type="number" size="small" label="Height"
                value={inst.canvas.height}
                onChange={(e) => update({ ...inst, canvas: { ...inst.canvas, height: Math.max(1, Number(e.target.value)) } })}
              />
            </Stack>
          </CardContent>
        </Card>
      </Box>

      <AddFixtureDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        devices={deviceOpts}
        onAdd={(f) => {
          update({ ...inst, fixtures: [...inst.fixtures, f] });
          setSelectedId(f.id);
        }}
      />
    </Stack>
  );
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const round = (n: number) => Math.round(n * 100) / 100;

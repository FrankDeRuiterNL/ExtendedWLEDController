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
  shapeIsSquare,
  type Fixture,
  type FixtureGeometry,
  type FixtureShape,
  type Installation,
  type ShapeKind,
  type Vec2,
} from '@ewc/core';
import { useInstallation, useSaveInstallation } from '../api/stage.js';
import { useDevices } from '../api/devices.js';
import { md3 } from '../theme/tokens.js';

let idSeq = 0;
const newId = () => `fx-${Date.now().toString(36)}-${idSeq++}`;

const SHAPE_KINDS: ShapeKind[] = ['line', 'rectangle', 'square', 'triangle', 'diamond', 'circle'];
type GeomChoice = 'strip' | 'matrix' | ShapeKind | 'custom';

/** Rotate (x,y) by `deg` about the origin. */
function rot(x: number, y: number, deg: number): Vec2 {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return { x: x * c - y * s, y: x * s + y * c };
}

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
  /** Active custom-shape drawing: fixture + vertices so far (CANVAS units) + whether the path loops. */
  const [draw, setDraw] = useState<{ id: string; points: Vec2[]; closed: boolean } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null);
  const resize = useRef<
    | { id: string; rotationDeg: number; center: Vec2; lockAspect: boolean }
    | null
  >(null);
  const drawActions = useRef({ commit: () => {}, cancel: () => {} });

  useEffect(() => {
    if (saved && !dirty && !draw) setInst(saved);
  }, [saved, dirty, draw]);

  useEffect(() => {
    if (!draw) return;
    // Drop focus from whatever control started the draw (e.g. the Shape select)
    // so it can't swallow Enter/Escape.
    (document.activeElement as HTMLElement | null)?.blur?.();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); drawActions.current.commit(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); drawActions.current.cancel(); }
    };
    // Capture phase so it beats any focused widget's own key handling.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [draw]);

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

  /** Switch a fixture's geometry to a strip / matrix / preset shape / custom draw. */
  const setGeomChoice = (id: string, choice: GeomChoice) => {
    const f = inst.fixtures.find((x) => x.id === id);
    if (!f) return;
    const count = Math.max(1, fixtureLedCount(f.geometry));

    if (choice === 'strip') {
      patchFixture(id, { geometry: { kind: 'strip', count } });
      return;
    }
    if (choice === 'matrix') {
      const w = Math.max(1, Math.round(Math.sqrt(count)));
      patchFixture(id, {
        geometry: { kind: 'matrix', width: w, height: Math.max(1, Math.ceil(count / w)), serpentine: true, origin: 'top-left' },
      });
      return;
    }
    if (choice === 'custom') {
      // Seed the draw with any existing custom vertices, projected back to canvas
      // space through the fixture's current transform.
      let existing: Vec2[] = [];
      if (f.geometry.kind === 'shape' && f.geometry.shape.type === 'custom') {
        const t = f.transform;
        existing = f.geometry.shape.points.map((p) => {
          const r = rot((p.x - 0.5) * t.size.x, (p.y - 0.5) * t.size.y, t.rotationDeg);
          return { x: t.position.x + r.x, y: t.position.y + r.y };
        });
      }
      setSelectedId(id);
      setDraw({
        id,
        points: existing,
        closed: f.geometry.kind === 'shape' && f.geometry.shape.type === 'custom' && !!f.geometry.shape.closed,
      });
      return;
    }
    // preset shape
    const geometry: FixtureGeometry = { kind: 'shape', count, shape: { type: choice } };
    const patch: Partial<Fixture> = { geometry };
    if (shapeIsSquare(geometry)) {
      const s = Math.max(f.transform.size.x, f.transform.size.y);
      patch.transform = { ...f.transform, size: { x: s, y: s } };
    }
    patchFixture(id, patch);
  };

  const commitDrawWith = (points: Vec2[], closed: boolean) => {
    if (!draw) return;
    const f = inst.fixtures.find((x) => x.id === draw.id);
    if (f && points.length >= 2) {
      // Fit an axis-aligned box around the drawn (canvas-space) vertices; the
      // fixture takes that box as its transform and stores the points normalised.
      const xs = points.map((p) => p.x);
      const ys = points.map((p) => p.y);
      const minX = Math.min(...xs);
      const minY = Math.min(...ys);
      const w = Math.max(0.5, Math.max(...xs) - minX);
      const h = Math.max(0.5, Math.max(...ys) - minY);
      const local = points.map((p) => ({ x: (p.x - minX) / w, y: (p.y - minY) / h }));
      const count = Math.max(1, fixtureLedCount(f.geometry));
      const shape: Extract<FixtureShape, { type: 'custom' }> = { type: 'custom', points: local };
      if (closed && local.length >= 3) shape.closed = true;
      patchFixture(draw.id, {
        geometry: { kind: 'shape', count, shape },
        transform: {
          position: { x: minX + w / 2, y: minY + h / 2 },
          rotationDeg: 0,
          size: { x: round(w), y: round(h) },
        },
      });
    }
    setDraw(null);
  };
  const commitDraw = () => draw && commitDrawWith(draw.points, draw.closed);
  const cancelDraw = () => setDraw(null);
  drawActions.current = { commit: commitDraw, cancel: cancelDraw };

  const toCanvasXY = (clientX: number, clientY: number): Vec2 => {
    const rect = svgRef.current!.getBoundingClientRect();
    return {
      x: ((clientX - rect.left) / rect.width) * inst.canvas.width,
      y: ((clientY - rect.top) / rect.height) * inst.canvas.height,
    };
  };
  const toCanvas = (evt: { clientX: number; clientY: number }): Vec2 => toCanvasXY(evt.clientX, evt.clientY);

  const onFixturePointerDown = (evt: React.PointerEvent, f: Fixture) => {
    if (draw) return;
    evt.stopPropagation();
    (evt.target as Element).setPointerCapture(evt.pointerId);
    setSelectedId(f.id);
    const p = toCanvas(evt);
    drag.current = { id: f.id, dx: f.transform.position.x - p.x, dy: f.transform.position.y - p.y };
  };

  const onResizeHandleDown = (evt: React.PointerEvent, f: Fixture) => {
    evt.stopPropagation();
    (evt.target as Element).setPointerCapture(evt.pointerId);
    setSelectedId(f.id);
    resize.current = {
      id: f.id,
      rotationDeg: f.transform.rotationDeg,
      center: { ...f.transform.position },
      lockAspect: shapeIsSquare(f.geometry),
    };
  };

  const onPointerMove = (evt: React.PointerEvent) => {
    if (resize.current) {
      const r = resize.current;
      const p = toCanvas(evt);
      // Pointer offset from centre, un-rotated into the fixture's local frame.
      const local = rot(p.x - r.center.x, p.y - r.center.y, -r.rotationDeg);
      let w = clamp(Math.abs(local.x) * 2, 0.2, inst.canvas.width * 2);
      let h = clamp(Math.abs(local.y) * 2, 0.2, inst.canvas.height * 2);
      if (r.lockAspect) w = h = Math.max(w, h);
      patchTransform(r.id, { size: { x: round(w), y: round(h) } });
      return;
    }
    if (drag.current) {
      const p = toCanvas(evt);
      patchTransform(drag.current.id, {
        position: {
          x: clamp(p.x + drag.current.dx, 0, inst.canvas.width),
          y: clamp(p.y + drag.current.dy, 0, inst.canvas.height),
        },
      });
    }
  };
  const onPointerUp = () => {
    drag.current = null;
    resize.current = null;
  };

  const addDrawVertex = (clientX: number, clientY: number) => {
    if (!draw) return;
    const c = toCanvasXY(clientX, clientY);
    const p = { x: clamp(c.x, 0, inst.canvas.width), y: clamp(c.y, 0, inst.canvas.height) };
    // Clicking back on the first vertex (with 3+ points down) closes the loop and commits.
    const first = draw.points[0];
    const snap = Math.max(0.3, Math.min(inst.canvas.width, inst.canvas.height) * 0.035);
    if (first && draw.points.length >= 3 && Math.hypot(p.x - first.x, p.y - first.y) <= snap) {
      commitDrawWith(draw.points, true);
      return;
    }
    setDraw({ ...draw, points: [...draw.points, p] });
  };

  const onCanvasContextMenu = (e: React.MouseEvent) => {
    if (!draw) return;
    e.preventDefault();
    addDrawVertex(e.clientX, e.clientY);
  };

  const vb = `0 0 ${inst.canvas.width} ${inst.canvas.height}`;

  return (
    <Stack spacing={3}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" flexWrap="wrap" gap={1}>
        <Box>
          <Typography variant="h2">Layout</Typography>
          <Typography variant="body2" color="text.secondary">
            Place, resize and shape each fixture on the virtual canvas. Effects render to this canvas.
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

      {draw && (
        <Alert
          severity="info"
          action={
            <Stack direction="row" spacing={1}>
              <Button color="inherit" size="small" onClick={commitDraw} disabled={draw.points.length < 2}>
                Finish ({draw.points.length})
              </Button>
              <Button color="inherit" size="small" onClick={cancelDraw}>
                Cancel
              </Button>
            </Stack>
          }
        >
          Drawing a custom shape. <strong>Click</strong> (or right-click) to drop points — the first
          is LED 0, then it runs point to point. <strong>Enter</strong> finishes it as an open line;
          click back <strong>on point 0</strong> to close it into a loop. <strong>Esc</strong>{' '}
          cancels.
        </Alert>
      )}

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
              onContextMenu={onCanvasContextMenu}
              // While drawing, every left click places a vertex; otherwise a
              // click on the empty canvas clears the selection.
              onClick={(e: React.MouseEvent) => {
                if (draw) addDrawVertex(e.clientX, e.clientY);
              }}
              onPointerDown={(e: React.PointerEvent) => {
                if (!draw && e.button === 0) setSelectedId(null);
              }}
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

                    {isSel && !draw && (() => {
                      const hs = Math.max(0.5, Math.min(inst.canvas.width, inst.canvas.height) * 0.028);
                      return (
                        <g transform={`translate(${f.transform.position.x} ${f.transform.position.y}) rotate(${f.transform.rotationDeg})`}>
                          {([[-1, -1], [1, -1], [1, 1], [-1, 1]] as const).map(([sx, sy]) => (
                            <rect
                              key={`${sx}${sy}`}
                              x={(sx * f.transform.size.x) / 2 - hs / 2}
                              y={(sy * f.transform.size.y) / 2 - hs / 2}
                              width={hs}
                              height={hs}
                              rx={hs * 0.25}
                              fill={md3.primary}
                              stroke={md3.surfaceContainerLowest}
                              strokeWidth={hs * 0.12}
                              style={{ cursor: 'nwse-resize' }}
                              onPointerDown={(e) => onResizeHandleDown(e, f)}
                            />
                          ))}
                        </g>
                      );
                    })()}
                  </g>
                );
              })}

              {draw && (() => {
                const pts = draw.points;
                const r = Math.max(0.18, Math.min(inst.canvas.width, inst.canvas.height) * 0.012);
                const canClose = pts.length >= 3;
                const line = pts.map((p) => `${p.x},${p.y}`).join(' ');
                return (
                  <g pointerEvents="none">
                    {pts.length >= 2 && (
                      <polyline
                        points={draw.closed && canClose ? `${line} ${pts[0]!.x},${pts[0]!.y}` : line}
                        fill="none"
                        stroke={md3.primary}
                        strokeWidth={r * 0.35}
                        strokeDasharray={`${r} ${r * 0.8}`}
                      />
                    )}
                    {pts.map((p, i) => (
                      <g key={i}>
                        {i === 0 && canClose && (
                          <circle cx={p.x} cy={p.y} r={r * 2.4} fill="none" stroke={md3.primary} strokeWidth={r * 0.2} strokeDasharray={`${r * 0.5} ${r * 0.4}`} />
                        )}
                        <circle
                          cx={p.x}
                          cy={p.y}
                          r={r}
                          fill={i === 0 ? md3.primary : md3.surfaceContainerHighest}
                          stroke={md3.primary}
                          strokeWidth={r * 0.25}
                        />
                        <text
                          x={p.x}
                          y={p.y - r * 1.8}
                          textAnchor="middle"
                          fontSize={r * 2}
                          fill={md3.primary}
                          fontWeight={700}
                        >
                          {i}
                        </text>
                      </g>
                    ))}
                  </g>
                );
              })()}
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

                <TextField
                  select
                  size="small"
                  label="Shape"
                  value={geomChoiceOf(selected.geometry)}
                  onChange={(e) => setGeomChoice(selected.id, e.target.value as GeomChoice)}
                >
                  <MenuItem value="strip">Strip (straight line)</MenuItem>
                  <MenuItem value="matrix">Matrix</MenuItem>
                  <Divider />
                  {SHAPE_KINDS.map((s) => (
                    <MenuItem key={s} value={s} sx={{ textTransform: 'capitalize' }}>
                      {s}
                    </MenuItem>
                  ))}
                  <MenuItem value="custom">Custom shape…</MenuItem>
                </TextField>

                {(selected.geometry.kind === 'strip' || selected.geometry.kind === 'shape') && (
                  <TextField
                    type="number"
                    size="small"
                    label="LED count"
                    value={selected.geometry.count}
                    onChange={(e) => {
                      const count = Math.max(0, Number(e.target.value));
                      patchFixture(selected.id, {
                        geometry:
                          selected.geometry.kind === 'shape'
                            ? { ...selected.geometry, count }
                            : { kind: 'strip', count },
                      });
                    }}
                  />
                )}
                {selected.geometry.kind === 'shape' && selected.geometry.shape.type === 'custom' && (
                  <Button size="small" variant="outlined" onClick={() => setGeomChoice(selected.id, 'custom')}>
                    Redraw custom shape
                  </Button>
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

/** Current value for the inspector's Shape dropdown. */
function geomChoiceOf(g: FixtureGeometry): GeomChoice {
  if (g.kind === 'strip') return 'strip';
  if (g.kind === 'matrix') return 'matrix';
  if (g.kind === 'points') return 'custom';
  return g.shape.type === 'custom' ? 'custom' : g.shape.type;
}

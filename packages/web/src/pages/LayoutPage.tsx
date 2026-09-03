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
  Switch,
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
  type FloorplanRef,
  type Installation,
  type MatrixOrigin,
  type ShapeKind,
  type Vec2,
} from '@ewc/core';
import {
  floorplanUrl,
  useDeleteFloorplan,
  useInstallation,
  useSaveInstallation,
  useUploadFloorplan,
} from '../api/stage.js';
import { useDevices } from '../api/devices.js';
import { md3 } from '../theme/tokens.js';

let idSeq = 0;
const newId = () => `fx-${Date.now().toString(36)}-${idSeq++}`;

const SHAPE_KINDS: ShapeKind[] = ['line', 'rectangle', 'square', 'triangle', 'diamond', 'circle'];
type GeomChoice = 'strip' | 'matrix' | ShapeKind | 'custom';

type MatrixGeometry = Extract<FixtureGeometry, { kind: 'matrix' }>;

/** How the LED strip snakes through the grid — `columnMajor` × `serpentine`. */
type MatrixWiring = 'h-zigzag' | 'h-oneway' | 'v-zigzag' | 'v-oneway';
const MATRIX_WIRING: {
  value: MatrixWiring;
  label: string;
  columnMajor: boolean;
  serpentine: boolean;
}[] = [
  { value: 'h-zigzag', label: 'Horizontal zigzag', columnMajor: false, serpentine: true },
  { value: 'h-oneway', label: 'Horizontal, one-way', columnMajor: false, serpentine: false },
  { value: 'v-zigzag', label: 'Vertical zigzag', columnMajor: true, serpentine: true },
  { value: 'v-oneway', label: 'Vertical, one-way', columnMajor: true, serpentine: false },
];
const wiringOf = (g: MatrixGeometry): MatrixWiring =>
  g.columnMajor
    ? g.serpentine
      ? 'v-zigzag'
      : 'v-oneway'
    : g.serpentine
      ? 'h-zigzag'
      : 'h-oneway';

const MATRIX_ORIGINS: { value: MatrixOrigin; label: string }[] = [
  { value: 'bottom-left', label: 'Bottom-left' },
  { value: 'bottom-right', label: 'Bottom-right' },
  { value: 'top-left', label: 'Top-left' },
  { value: 'top-right', label: 'Top-right' },
];

/** WLED matrices are usually wired pixel 0 at a bottom corner, snaking across rows. */
const DEFAULT_MATRIX = { serpentine: true, columnMajor: false, origin: 'bottom-left' } as const;

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
    return { kind: 'matrix', width: w, height: Math.max(1, Math.ceil(leds / w)), ...DEFAULT_MATRIX };
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
  const upload = useUploadFloorplan();
  const removeFp = useDeleteFloorplan();
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
  const fpDrag = useRef<{ dx: number; dy: number } | null>(null);
  const fpResize = useRef<{ center: Vec2; aspect: number } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const drawActions = useRef({ commit: () => {}, cancel: () => {} });

  const [showFloorplan, setShowFloorplan] = useState(() => {
    try {
      return localStorage.getItem('ewc.layout.showFloorplan') !== '0';
    } catch {
      return true;
    }
  });
  const toggleFloorplan = (on: boolean) => {
    setShowFloorplan(on);
    try {
      localStorage.setItem('ewc.layout.showFloorplan', on ? '1' : '0');
    } catch {
      /* private mode — no persistence */
    }
  };

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
      // Keep the wiring the fixture already had if it's staying a matrix.
      const prev = f.geometry.kind === 'matrix' ? f.geometry : null;
      patchFixture(id, {
        geometry: {
          kind: 'matrix',
          width: prev?.width ?? w,
          height: prev?.height ?? Math.max(1, Math.ceil(count / w)),
          serpentine: prev?.serpentine ?? DEFAULT_MATRIX.serpentine,
          columnMajor: prev?.columnMajor ?? DEFAULT_MATRIX.columnMajor,
          origin: prev?.origin ?? DEFAULT_MATRIX.origin,
        },
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

  const updateFloorplan = (patch: Partial<FloorplanRef>) => {
    if (!inst.floorplan) return;
    update({ ...inst, floorplan: { ...inst.floorplan, ...patch } });
  };

  const doUpload = (file: File) =>
    upload.mutate(file, {
      onSuccess: (i) => setInst((cur) => (cur ? { ...cur, floorplan: i.floorplan } : i)),
    });
  const doRemoveFloorplan = () =>
    removeFp.mutate(undefined, {
      onSuccess: () =>
        setInst((cur) => {
          if (!cur) return cur;
          const next = { ...cur };
          delete next.floorplan;
          return next;
        }),
    });

  const onFloorplanPointerDown = (evt: React.PointerEvent) => {
    if (draw || !inst.floorplan) return;
    evt.stopPropagation();
    (evt.target as Element).setPointerCapture(evt.pointerId);
    setSelectedId(null);
    const p = toCanvas(evt);
    fpDrag.current = { dx: inst.floorplan.position.x - p.x, dy: inst.floorplan.position.y - p.y };
  };
  const onFloorplanResizeDown = (evt: React.PointerEvent) => {
    if (!inst.floorplan) return;
    evt.stopPropagation();
    (evt.target as Element).setPointerCapture(evt.pointerId);
    setSelectedId(null);
    fpResize.current = {
      center: { ...inst.floorplan.position },
      aspect: inst.floorplan.naturalWidth / inst.floorplan.naturalHeight || 1,
    };
  };

  const onPointerMove = (evt: React.PointerEvent) => {
    if (fpResize.current && inst.floorplan) {
      const r = fpResize.current;
      const p = toCanvas(evt);
      // Symmetric about centre; keep the image's natural aspect ratio.
      const half = Math.max(Math.abs(p.x - r.center.x), Math.abs(p.y - r.center.y) * r.aspect);
      const w = clamp(half * 2, 0.5, inst.canvas.width * 3);
      updateFloorplan({ size: { x: round(w), y: round(w / r.aspect) } });
      return;
    }
    if (fpDrag.current && inst.floorplan) {
      const p = toCanvas(evt);
      updateFloorplan({
        position: {
          x: clamp(p.x + fpDrag.current.dx, 0, inst.canvas.width),
          y: clamp(p.y + fpDrag.current.dy, 0, inst.canvas.height),
        },
      });
      return;
    }
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
    fpDrag.current = null;
    fpResize.current = null;
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

              {showFloorplan && inst.floorplan && (
                <image
                  href={floorplanUrl(inst.floorplan)}
                  x={inst.floorplan.position.x - inst.floorplan.size.x / 2}
                  y={inst.floorplan.position.y - inst.floorplan.size.y / 2}
                  width={inst.floorplan.size.x}
                  height={inst.floorplan.size.y}
                  opacity={0.5}
                  preserveAspectRatio="none"
                  style={{ cursor: !selectedId && !draw ? 'grab' : 'default' }}
                  onPointerDown={!selectedId && !draw ? onFloorplanPointerDown : undefined}
                />
              )}

              <rect
                x={0}
                y={0}
                width={inst.canvas.width}
                height={inst.canvas.height}
                fill="url(#grid)"
                pointerEvents="none"
              />

              {showFloorplan && inst.floorplan && !selectedId && !draw && (() => {
                const fp = inst.floorplan;
                const hs = Math.max(0.5, Math.min(inst.canvas.width, inst.canvas.height) * 0.028);
                return (
                  <g>
                    <rect
                      x={fp.position.x - fp.size.x / 2}
                      y={fp.position.y - fp.size.y / 2}
                      width={fp.size.x}
                      height={fp.size.y}
                      fill="none"
                      stroke={md3.outline}
                      strokeWidth={0.03}
                      strokeDasharray="0.22 0.16"
                      pointerEvents="none"
                    />
                    {([[-1, -1], [1, -1], [1, 1], [-1, 1]] as const).map(([sx, sy]) => (
                      <rect
                        key={`${sx}${sy}`}
                        x={fp.position.x + (sx * fp.size.x) / 2 - hs / 2}
                        y={fp.position.y + (sy * fp.size.y) / 2 - hs / 2}
                        width={hs}
                        height={hs}
                        rx={hs * 0.25}
                        fill={md3.primary}
                        stroke={md3.surfaceContainerLowest}
                        strokeWidth={hs * 0.12}
                        style={{ cursor: 'nwse-resize' }}
                        onPointerDown={onFloorplanResizeDown}
                      />
                    ))}
                  </g>
                );
              })()}

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
                    {isSel && f.geometry.kind === 'matrix' && leds.length > 1 && (
                      <polyline
                        points={leds
                          .map((l) => `${l.x * inst.canvas.width},${l.y * inst.canvas.height}`)
                          .join(' ')}
                        fill="none"
                        stroke={md3.primary}
                        strokeWidth={0.04}
                        strokeOpacity={0.45}
                        strokeLinejoin="round"
                        strokeLinecap="round"
                        pointerEvents="none"
                      />
                    )}
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
            <Stack direction="row" alignItems="center" spacing={1} sx={{ px: 1, pt: 0.5 }}>
              <Switch
                size="small"
                checked={showFloorplan && !!inst.floorplan}
                disabled={!inst.floorplan}
                onChange={(e) => toggleFloorplan(e.target.checked)}
              />
              <Typography variant="body2" color="text.secondary">
                Show floorplan
              </Typography>
            </Stack>
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
                {selected.geometry.kind === 'matrix' && (() => {
                  const g = selected.geometry;
                  const patchMatrix = (p: Partial<MatrixGeometry>) =>
                    patchFixture(selected.id, { geometry: { ...g, ...p } });
                  return (
                    <>
                      <Stack direction="row" spacing={1}>
                        <TextField
                          type="number" size="small" label="Columns"
                          value={g.width}
                          onChange={(e) => patchMatrix({ width: Math.max(1, Number(e.target.value)) })}
                        />
                        <TextField
                          type="number" size="small" label="Rows"
                          value={g.height}
                          onChange={(e) => patchMatrix({ height: Math.max(1, Number(e.target.value)) })}
                        />
                      </Stack>
                      <TextField
                        select size="small" label="Wiring"
                        value={wiringOf(g)}
                        helperText="How the strip snakes through the grid."
                        onChange={(e) => {
                          const w = MATRIX_WIRING.find((x) => x.value === e.target.value);
                          if (w) patchMatrix({ columnMajor: w.columnMajor, serpentine: w.serpentine });
                        }}
                      >
                        {MATRIX_WIRING.map((w) => (
                          <MenuItem key={w.value} value={w.value}>{w.label}</MenuItem>
                        ))}
                      </TextField>
                      <TextField
                        select size="small" label="First LED (pixel 0)"
                        value={g.origin}
                        helperText="Which corner the wire starts from."
                        onChange={(e) => patchMatrix({ origin: e.target.value as MatrixOrigin })}
                      >
                        {MATRIX_ORIGINS.map((o) => (
                          <MenuItem key={o.value} value={o.value}>{o.label}</MenuItem>
                        ))}
                      </TextField>
                    </>
                  );
                })()}

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

            {!selected && (
              <>
                <Divider sx={{ my: 2 }} />
                <Typography variant="subtitle2" gutterBottom>
                  Floorplan
                </Typography>
                <input
                  ref={fileInput}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  hidden
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) doUpload(f);
                    e.target.value = '';
                  }}
                />
                <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                  <Button
                    size="small"
                    variant="outlined"
                    onClick={() => fileInput.current?.click()}
                    disabled={upload.isPending}
                  >
                    {upload.isPending ? 'Uploading…' : inst.floorplan ? 'Replace image' : 'Upload image'}
                  </Button>
                  {inst.floorplan && (
                    <Button size="small" color="error" onClick={doRemoveFloorplan} disabled={removeFp.isPending}>
                      Remove
                    </Button>
                  )}
                </Stack>
                {upload.isError && (
                  <Alert severity="error" sx={{ mt: 1 }}>
                    {(upload.error as Error).message}
                  </Alert>
                )}
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                  A room plan to place fixtures against — shown at 50% opacity below the grid. With no
                  fixture selected, drag it to move and use the corners to scale. Preview only; never
                  sent to the LEDs.
                </Typography>
              </>
            )}
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

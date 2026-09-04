import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Divider,
  IconButton,
  MenuItem,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import BrushIcon from '@mui/icons-material/Brush';
import ColorizeIcon from '@mui/icons-material/Colorize';
import BackspaceIcon from '@mui/icons-material/Backspace';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import { fixtureLedCount, matrixCell, type PixelScene } from '@ewc/core';
import { useDevices } from '../api/devices.js';
import { useInstallation, useStartPaintStream, useStopStream, useStreamStatus } from '../api/stage.js';
import { useBake } from '../api/paint.js';
import {
  fetchPixelScene,
  useCreatePixelScene,
  useDeletePixelScene,
  usePixelScenes,
  useUpdatePixelScene,
} from '../api/pixelScenes.js';
import { CommittedSlider } from '../components/CommittedSlider.js';
import { md3 } from '../theme/tokens.js';

type Tool = 'paint' | 'erase' | 'pick';

/** `#rrggbb` → `RRGGBB` (no hash), for the wire / storage. */
const bare = (hex: string) => hex.replace(/^#/, '').toUpperCase();

export function PaintPage() {
  const { data: installation } = useInstallation();
  const { data: devices } = useDevices();

  const fixtures = useMemo(
    () => (installation?.fixtures ?? []).filter((f) => f.enabled),
    [installation?.fixtures],
  );

  const [fixtureId, setFixtureId] = useState<string | null>(null);
  const fixture = fixtures.find((f) => f.id === fixtureId) ?? fixtures[0] ?? null;

  const device = devices?.find((d) => d.id === fixture?.deviceId) ?? null;
  const deviceId = fixture?.deviceId ?? null;
  const ledCount = fixture ? fixtureLedCount(fixture.geometry) : 0;
  /** First LED of this fixture in the device's whole-strip wire index space. */
  const wireStart = fixture?.startIndex ?? 0;

  const isWholeDevice =
    !!device && device.ledCount != null && wireStart === 0 && ledCount === device.ledCount;
  const sharesDevice =
    !!fixture && fixtures.filter((f) => f.deviceId === fixture.deviceId).length > 1;

  // Matrix fixtures paint as a 2-D grid in their real wiring order. `matrixCell`
  // takes a **fixture-local** wire index (0..ledCount-1) — the device offset is
  // added later, once, via the stream's `segStart`.
  const matrixGeom = fixture?.geometry.kind === 'matrix' ? fixture.geometry : null;
  const matrixGrid = useMemo(() => {
    if (!matrixGeom) return null;
    const w = Math.max(1, Math.floor(matrixGeom.width));
    const h = Math.max(1, Math.floor(matrixGeom.height));
    const grid: number[][] = Array.from({ length: h }, () => Array<number>(w).fill(-1));
    for (let localIndex = 0; localIndex < w * h; localIndex++) {
      const { col, row } = matrixCell(localIndex, matrixGeom);
      if (row >= 0 && row < h && col >= 0 && col < w) grid[row]![col] = localIndex;
    }
    return { w, h, grid };
  }, [matrixGeom]);

  const { data: streamStatus } = useStreamStatus();
  const startPaintStream = useStartPaintStream();
  const stopStream = useStopStream();

  const { data: pixelScenes } = usePixelScenes();
  const createScene = useCreatePixelScene();
  const updateScene = useUpdatePixelScene();
  const deleteScene = useDeletePixelScene();
  const bake = useBake(deviceId ?? 0);

  // One entry per fixture LED (wire order): a `#rrggbb` string when lit, `null` = off.
  const [cells, setCells] = useState<Array<string | null>>([]);
  const [color, setColor] = useState('#ff8800');
  const [tool, setTool] = useState<Tool>('paint');
  const [brightness, setBrightness] = useState(160);

  const [sceneName, setSceneName] = useState('');
  const [bakePreset, setBakePreset] = useState('');
  const [loadedSceneId, setLoadedSceneId] = useState<number | null>(null);
  const [confirmLoad, setConfirmLoad] = useState<{ id: number; name: string } | null>(null);
  const [confirmScene, setConfirmScene] = useState(false);
  const [sceneAck, setSceneAck] = useState(false);
  const [loadNote, setLoadNote] = useState<string | null>(null);

  /** True once the user has touched this canvas — keeps the live stream fed. */
  const [live, setLive] = useState(false);

  // Reset everything when the target fixture changes. Keyed on the id **and** the
  // LED count: a Layout edit can resize a fixture's geometry without changing its
  // id, and the canvas has to follow.
  useEffect(() => {
    setCells(Array.from({ length: ledCount }, () => null));
    setLoadedSceneId(null);
    setLoadNote(null);
    setLive(false);
    setSceneAck(false);
  }, [fixture?.id, ledCount]);

  const dragging = useRef(false);
  useEffect(() => {
    const up = () => (dragging.current = false);
    window.addEventListener('mouseup', up);
    return () => window.removeEventListener('mouseup', up);
  }, []);

  const streamingThisDevice =
    streamStatus?.mode === 'paint' &&
    streamStatus.running &&
    streamStatus.paint?.deviceId === deviceId;

  const sceneStreaming = streamStatus?.mode === 'scene' && streamStatus.running;

  // --- live push queue (coalesced + serialized) --------------------------
  // Everything the push needs is read through a ref so `doPush` stays identity-
  // stable — otherwise react-query's mutation object flipping isPending would
  // re-fire the debounce effect in a loop.
  const pushArgs = useRef({ deviceId, wireStart, brightness, cells });
  pushArgs.current = { deviceId, wireStart, brightness, cells };
  const startPaintRef = useRef(startPaintStream);
  startPaintRef.current = startPaintStream;
  const push = useRef({ inFlight: false, pending: false });

  const doPush = useCallback(() => {
    const { deviceId: id, wireStart: ss, brightness: bri, cells: cs } = pushArgs.current;
    if (!id) return;
    if (push.current.inFlight) {
      push.current.pending = true;
      return;
    }
    push.current.inFlight = true;
    startPaintRef.current
      .mutateAsync({
        deviceId: id,
        segStart: ss,
        brightness: bri,
        pixels: cs.map((c) => (c ? bare(c) : null)),
      })
      .catch(() => undefined)
      .finally(() => {
        push.current.inFlight = false;
        if (push.current.pending) {
          push.current.pending = false;
          doPush();
        }
      });
  }, []);

  // Debounced: any canvas / brightness change while "live" streams to the device.
  useEffect(() => {
    if (!live || !deviceId) return;
    if (sceneStreaming && !sceneAck) {
      setConfirmScene(true);
      return;
    }
    const t = setTimeout(doPush, 80);
    return () => clearTimeout(t);
  }, [cells, brightness, live, deviceId, sceneStreaming, sceneAck, doPush]);

  const touchCell = (i: number) => {
    if (i < 0) return;
    setLoadNote(null);
    setLive(true);
    setCells((prev) => {
      if (i >= prev.length) return prev;
      if (tool === 'pick') {
        if (prev[i]) setColor(prev[i]!);
        return prev;
      }
      const next = prev.slice();
      next[i] = tool === 'erase' ? null : color;
      return next;
    });
  };

  const litCount = cells.reduce((n, c) => (c ? n + 1 : n), 0);

  const fillAll = () => {
    setLoadNote(null);
    setLive(true);
    setCells((p) => p.map(() => color));
  };
  const fillBlack = () => {
    setLoadNote(null);
    setLive(true);
    setCells((p) => p.map(() => '#000000'));
  };
  const clearCanvas = () => {
    setLoadNote(null);
    setLive(true);
    setCells((p) => p.map(() => null));
  };

  const stopAndRelease = () => {
    setLive(false);
    stopStream.mutate();
  };

  // --- pixel scenes -----------------------------------------------------
  const currentScene = (): PixelScene => ({
    width: ledCount,
    brightness,
    pixels: cells.map((c) => (c ? bare(c) : null)),
  });

  const saveAsNew = () => {
    const name = sceneName.trim() || `Pixel scene ${(pixelScenes?.length ?? 0) + 1}`;
    createScene.mutate(
      { name, scene: currentScene() },
      {
        onSuccess: (s) => {
          setLoadedSceneId(s.id);
          setSceneName(s.name);
        },
      },
    );
  };

  const overwrite = () => {
    if (loadedSceneId == null) return;
    const name = sceneName.trim() || `Pixel scene ${loadedSceneId}`;
    updateScene.mutate({ id: loadedSceneId, name, scene: currentScene() });
  };

  const doLoad = async (id: number) => {
    const dto = await fetchPixelScene(id);
    const s = dto.scene;
    setCells(
      Array.from({ length: ledCount }, (_, i) => {
        const p = s.pixels[i];
        return p ? `#${p.toLowerCase()}` : null;
      }),
    );
    setBrightness(Math.max(1, Math.min(255, s.brightness)));
    setLoadedSceneId(dto.id);
    setSceneName(dto.name);
    setLive(true);
    setLoadNote(
      s.width !== ledCount
        ? `“${dto.name}” was painted for ${s.width} LEDs; mapped onto this ${ledCount}-LED fixture by index.`
        : null,
    );
  };

  const requestLoad = (id: number, name: string) => {
    if (streamingThisDevice || litCount > 0) setConfirmLoad({ id, name });
    else void doLoad(id);
  };

  // --- bake -----------------------------------------------------------
  // Bake writes the **whole device** (`seg.n` + the Image effect on segment 0),
  // so it's only offered for a fixture that covers its entire strip and isn't a
  // 2-D matrix (a baked GIF is a 1-D row).
  const canBake = isWholeDevice && !matrixGeom;
  const bakeBlockedReason = !fixture
    ? null
    : !device
      ? 'This fixture’s device is offline.'
      : matrixGeom
        ? 'Baking a matrix fixture isn’t supported yet — a baked GIF is a 1-D row.'
        : !isWholeDevice
          ? `“${fixture.name}” is LEDs ${wireStart}–${wireStart + ledCount} of ${device.name}. ` +
            'Baking writes the whole device, so it’s only available for a fixture that covers its entire strip.'
          : null;

  const presetSlot = () => {
    const n = Number(bakePreset);
    return Number.isInteger(n) && n >= 1 && n <= 250 ? n : undefined;
  };
  const bakeCanvas = () => {
    if (!deviceId || litCount === 0 || !canBake) return;
    bake.mutate({
      segId: 0,
      preset: presetSlot(),
      name: sceneName.trim() ? sceneName.trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 20) : 'canvas',
      pixels: cells.map((c) => (c ? bare(c) : null)),
    });
  };
  const bakeScene = (id: number) => {
    if (!deviceId || !canBake) return;
    bake.mutate({ segId: 0, preset: presetSlot(), sceneId: id });
  };

  const fixtureLabel = (f: (typeof fixtures)[number]) => {
    const dev = devices?.find((d) => d.id === f.deviceId);
    const n = fixtureLedCount(f.geometry);
    const geom =
      f.geometry.kind === 'matrix' ? `${f.geometry.width}×${f.geometry.height}` : `${n} LED${n === 1 ? '' : 's'}`;
    return `${f.name} · ${dev?.name ?? `device ${f.deviceId}`} · ${geom}`;
  };

  if (fixtures.length === 0) {
    return (
      <Stack spacing={2}>
        <Box>
          <Typography variant="h3">Pixel painter</Typography>
          <Typography variant="body2" color="text.secondary">
            Paint the LEDs of a fixture directly and stream the result to its device.
          </Typography>
        </Box>
        <Alert
          severity="info"
          action={
            <Button component={RouterLink} to="/layout" size="small" color="inherit">
              Open Layout
            </Button>
          }
        >
          No fixtures yet. Define your fixtures on the <strong>Layout</strong> page first — the
          painter works per fixture.
        </Alert>
      </Stack>
    );
  }

  const cellBox = (localIndex: number, key: string | number) => {
    const c = localIndex >= 0 ? cells[localIndex] ?? null : null;
    const off = localIndex < 0;
    return (
      <Box
        key={key}
        title={off ? 'unwired' : `LED ${localIndex}${c ? ` · ${bare(c)}` : ' · off'}`}
        onMouseDown={
          off
            ? undefined
            : () => {
                dragging.current = true;
                touchCell(localIndex);
              }
        }
        onMouseEnter={off ? undefined : () => dragging.current && touchCell(localIndex)}
        sx={{
          width: 16,
          height: 16,
          borderRadius: '3px',
          cursor: off ? 'default' : 'crosshair',
          bgcolor: off ? md3.surfaceContainerHigh : c ?? 'transparent',
          opacity: off ? 0.4 : 1,
          border: c && !off ? '1px solid rgba(255,255,255,0.25)' : `1px dashed ${md3.outline}`,
        }}
      />
    );
  };

  return (
    <Stack spacing={2}>
      <Box>
        <Typography variant="h3">Pixel painter</Typography>
        <Typography variant="body2" color="text.secondary">
          Pick a fixture, paint its LEDs, and the moment you touch the canvas its device switches to
          a live stream from this page — every edit shows on the strip in real time. “Stop &amp;
          Release” ends the stream and the device returns to its effect. Save a canvas as a{' '}
          <strong>Pixel Scene</strong> to reload it later.
        </Typography>
      </Box>

      <Card>
        <CardContent>
          <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap alignItems="center">
            <TextField
              select
              label="Fixture"
              size="small"
              value={fixture?.id ?? ''}
              onChange={(e) => setFixtureId(e.target.value)}
              sx={{ minWidth: 280 }}
            >
              {fixtures.map((f) => (
                <MenuItem key={f.id} value={f.id}>
                  {fixtureLabel(f)}
                </MenuItem>
              ))}
            </TextField>

            {streamingThisDevice && (
              <Chip size="small" color="success" label="Streaming to this device" />
            )}
          </Stack>

          {sharesDevice && fixture && device && (
            <Alert severity="info" sx={{ mt: 2 }}>
              Painting <strong>{fixture.name}</strong> takes over its whole device (
              {device.name}) — the other{' '}
              {fixtures.filter((f) => f.deviceId === fixture.deviceId).length - 1} fixture(s) on it go
              dark until you Stop &amp; Release.
            </Alert>
          )}

          {!device && fixture && (
            <Alert severity="warning" sx={{ mt: 2 }}>
              Device {fixture.deviceId} for this fixture isn’t in the registry — nothing to stream to.
            </Alert>
          )}
        </CardContent>
      </Card>

      {ledCount > 0 && (
        <Card>
          <CardContent>
            <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap alignItems="center">
              <ToggleButtonGroup
                size="small"
                exclusive
                value={tool}
                onChange={(_, v: Tool | null) => v && setTool(v)}
              >
                <ToggleButton value="paint">
                  <BrushIcon fontSize="small" sx={{ mr: 0.5 }} /> Paint
                </ToggleButton>
                <ToggleButton value="erase">
                  <BackspaceIcon fontSize="small" sx={{ mr: 0.5 }} /> Erase
                </ToggleButton>
                <ToggleButton value="pick">
                  <ColorizeIcon fontSize="small" sx={{ mr: 0.5 }} /> Pick
                </ToggleButton>
              </ToggleButtonGroup>

              <Box
                component="input"
                type="color"
                value={color}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setColor(e.target.value)}
                sx={{ width: 44, height: 36, border: 'none', bgcolor: 'transparent', cursor: 'pointer' }}
              />

              <Button size="small" variant="outlined" onClick={fillAll}>
                Fill all
              </Button>
              <Button size="small" variant="outlined" onClick={fillBlack}>
                Fill black
              </Button>
              <Button size="small" variant="outlined" onClick={clearCanvas} disabled={litCount === 0}>
                Clear
              </Button>
            </Stack>

            <Box sx={{ mt: 2, maxWidth: 320 }}>
              <Typography variant="caption" color="text.secondary">
                Brightness
              </Typography>
              <CommittedSlider min={1} max={255} value={brightness} onCommit={(v) => setBrightness(v)} />
            </Box>

            <Divider sx={{ my: 2 }} />

            {matrixGrid ? (
              <Box sx={{ overflowX: 'auto', pb: 1 }}>
                <Box
                  sx={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '3px',
                    width: 'max-content',
                    userSelect: 'none',
                  }}
                  onMouseLeave={() => (dragging.current = false)}
                >
                  {matrixGrid.grid.map((rowIdx, row) => (
                    <Box key={row} sx={{ display: 'flex', gap: '3px' }}>
                      {rowIdx.map((localIndex, col) => cellBox(localIndex, `${row}:${col}`))}
                    </Box>
                  ))}
                </Box>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                  {matrixGrid.w}×{matrixGrid.h} matrix, shown in its wiring order (first LED, serpentine
                  and orientation from Layout).
                </Typography>
              </Box>
            ) : (
              <Box
                sx={{ display: 'flex', flexWrap: 'wrap', gap: '3px', userSelect: 'none' }}
                onMouseLeave={() => (dragging.current = false)}
              >
                {cells.map((_, i) => cellBox(i, i))}
              </Box>
            )}

            {loadNote && (
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                {loadNote}
              </Typography>
            )}

            <Divider sx={{ my: 2 }} />

            <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap alignItems="center">
              <Button
                variant="outlined"
                onClick={stopAndRelease}
                disabled={!streamingThisDevice || stopStream.isPending}
              >
                Stop &amp; Release
              </Button>
              <Typography variant="body2" color="text.secondary">
                {litCount} / {ledCount} lit
                {streamingThisDevice ? ' · live' : ''}
              </Typography>
            </Stack>

            {startPaintStream.isError && (
              <Alert severity="error" sx={{ mt: 2 }}>
                {(startPaintStream.error as Error).message}
              </Alert>
            )}
          </CardContent>
        </Card>
      )}

      {ledCount > 0 && (
        <Card>
          <CardContent>
            <Typography variant="h5" gutterBottom>
              Pixel Scenes
            </Typography>
            <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap alignItems="center">
              <TextField
                size="small"
                label="Name"
                value={sceneName}
                onChange={(e) => setSceneName(e.target.value)}
                sx={{ minWidth: 220 }}
              />
              <Button
                variant="contained"
                onClick={saveAsNew}
                disabled={createScene.isPending || litCount === 0}
              >
                Save as new
              </Button>
              {loadedSceneId != null && (
                <Button
                  variant="outlined"
                  onClick={overwrite}
                  disabled={updateScene.isPending || litCount === 0}
                >
                  Update “{sceneName.trim() || 'scene'}”
                </Button>
              )}
            </Stack>

            {createScene.isError && (
              <Alert severity="error" sx={{ mt: 2 }}>
                {(createScene.error as Error).message}
              </Alert>
            )}

            <Divider sx={{ my: 2 }} />

            {(pixelScenes ?? []).length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                No saved pixel scenes yet.
              </Typography>
            ) : (
              <Stack spacing={1}>
                {(pixelScenes ?? []).map((s) => (
                  <Stack
                    key={s.id}
                    direction="row"
                    spacing={2}
                    alignItems="center"
                    sx={{
                      p: 1,
                      borderRadius: 1,
                      bgcolor: s.id === loadedSceneId ? md3.surfaceContainerHigh : 'transparent',
                    }}
                  >
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Typography variant="body2" noWrap>
                        {s.name}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {s.paintedCount} / {s.width} lit · {new Date(s.updatedAt).toLocaleString()}
                      </Typography>
                    </Box>
                    <Button size="small" variant="outlined" onClick={() => requestLoad(s.id, s.name)}>
                      Load
                    </Button>
                    <Button
                      size="small"
                      variant="outlined"
                      onClick={() => bakeScene(s.id)}
                      disabled={bake.isPending || !canBake}
                    >
                      Bake
                    </Button>
                    <IconButton
                      size="small"
                      aria-label="delete pixel scene"
                      onClick={() => deleteScene.mutate(s.id)}
                    >
                      <DeleteOutlineIcon fontSize="small" />
                    </IconButton>
                  </Stack>
                ))}
              </Stack>
            )}
          </CardContent>
        </Card>
      )}

      {ledCount > 0 && (
        <Card>
          <CardContent>
            <Typography variant="h5" gutterBottom>
              Bake to device
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Write the canvas to the device as a one-frame GIF and play it with the Image effect —
              runs on the device with no stream. Add a preset slot to also save it as a preset that
              survives a reboot. The GIF filename is reused (overwritten) per bake.
            </Typography>
            {bakeBlockedReason ? (
              <Alert severity="info">{bakeBlockedReason}</Alert>
            ) : (
              <>
                <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap alignItems="center">
                  <TextField
                    size="small"
                    label="Preset slot (optional)"
                    type="number"
                    value={bakePreset}
                    onChange={(e) => setBakePreset(e.target.value)}
                    slotProps={{ htmlInput: { min: 1, max: 250 } }}
                    sx={{ width: 180 }}
                  />
                  <Button
                    variant="contained"
                    onClick={bakeCanvas}
                    disabled={bake.isPending || litCount === 0}
                  >
                    Bake canvas
                  </Button>
                </Stack>
                {bake.isError && (
                  <Alert severity="error" sx={{ mt: 2 }}>
                    {(bake.error as Error).message}
                  </Alert>
                )}
                {bake.isSuccess && !bake.isPending && (
                  <Alert severity="success" sx={{ mt: 2 }}>
                    Baked <code>{bake.data.filename}</code> ({bake.data.bytes} B)
                    {bake.data.preset != null ? `, saved as preset ${bake.data.preset}` : ''}
                    {bake.data.freeKbAfter != null ? ` · ${bake.data.freeKbAfter} KB free` : ''}.
                  </Alert>
                )}
              </>
            )}
          </CardContent>
        </Card>
      )}

      {fixture && ledCount === 0 && (
        <Alert severity="warning">
          “{fixture.name}” has no LEDs. Check its geometry on the Layout page.
        </Alert>
      )}

      <Dialog open={confirmLoad != null} onClose={() => setConfirmLoad(null)}>
        <DialogTitle>Replace the current painting?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {streamingThisDevice
              ? `Painting is currently streaming to this device. Loading “${confirmLoad?.name}” will stop that stream and start it again with the loaded scene.`
              : `The canvas has unsaved pixels. Loading “${confirmLoad?.name}” will replace them.`}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmLoad(null)}>Cancel</Button>
          <Button
            variant="contained"
            onClick={async () => {
              const target = confirmLoad!;
              setConfirmLoad(null);
              if (streamingThisDevice) {
                setLive(false);
                try {
                  await stopStream.mutateAsync();
                } catch {
                  /* load anyway */
                }
              }
              await doLoad(target.id);
            }}
          >
            Yes, I Understand
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={confirmScene} onClose={() => setConfirmScene(false)}>
        <DialogTitle>A scene is streaming</DialogTitle>
        <DialogContent>
          <DialogContentText>
            The scene{streamStatus?.scene ? ` “${streamStatus.scene.name}”` : ''} is currently
            streaming. Painting here will stop that stream and take over the selected device.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => {
              setConfirmScene(false);
              setLive(false);
            }}
          >
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={() => {
              setSceneAck(true);
              setConfirmScene(false);
            }}
          >
            Yes, I Understand
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}

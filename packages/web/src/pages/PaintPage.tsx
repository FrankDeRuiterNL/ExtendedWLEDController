import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import type { PixelScene, WledSegment, WledState } from '@ewc/core';
import { useDevice, useDevices } from '../api/devices.js';
import { useStartPaintStream, useStopStream, useStreamStatus } from '../api/stage.js';
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
  const { data: devices } = useDevices();
  const [deviceId, setDeviceId] = useState<number | null>(null);

  const effectiveId = deviceId ?? devices?.[0]?.id ?? null;
  const { data: device } = useDevice(effectiveId ?? 0);

  const { data: streamStatus } = useStreamStatus();
  const startPaintStream = useStartPaintStream();
  const stopStream = useStopStream();

  const { data: pixelScenes } = usePixelScenes();
  const createScene = useCreatePixelScene();
  const updateScene = useUpdatePixelScene();
  const deleteScene = useDeletePixelScene();

  const state: WledState = device?.state ?? {};
  const segments = useMemo(
    () => state.seg?.filter((s) => (s.stop ?? 0) > (s.start ?? 0) || s.id === state.mainseg) ?? [],
    [state.seg, state.mainseg],
  );
  const [segId, setSegId] = useState<number | null>(null);
  const activeSegId = segId ?? state.mainseg ?? segments[0]?.id ?? 0;
  const segment: WledSegment = segments.find((s) => s.id === activeSegId) ?? { id: activeSegId };
  const segStart = segment.start ?? 0;
  const segStop = segment.stop ?? device?.ledCount ?? 0;
  const segLen = Math.max(0, segStop - segStart);

  // One entry per segment-relative LED: a `#rrggbb` string when lit, `null` = off.
  const [cells, setCells] = useState<Array<string | null>>([]);
  const [color, setColor] = useState('#ff8800');
  const [tool, setTool] = useState<Tool>('paint');
  const [brightness, setBrightness] = useState(160);

  const [sceneName, setSceneName] = useState('');
  const [loadedSceneId, setLoadedSceneId] = useState<number | null>(null);
  const [confirmLoad, setConfirmLoad] = useState<{ id: number; name: string } | null>(null);
  const [confirmScene, setConfirmScene] = useState(false);
  const [sceneAck, setSceneAck] = useState(false);
  const [loadNote, setLoadNote] = useState<string | null>(null);

  /** True once the user has touched this canvas — keeps the live stream fed. */
  const [live, setLive] = useState(false);

  // Reset everything when the target strip changes.
  useEffect(() => {
    setCells(Array.from({ length: segLen }, () => null));
    setLoadedSceneId(null);
    setLoadNote(null);
    setLive(false);
    setSceneAck(false);
  }, [segLen, activeSegId, effectiveId]);

  const dragging = useRef(false);
  useEffect(() => {
    const up = () => (dragging.current = false);
    window.addEventListener('mouseup', up);
    return () => window.removeEventListener('mouseup', up);
  }, []);

  const streamingThisDevice =
    streamStatus?.mode === 'paint' &&
    streamStatus.running &&
    streamStatus.paint?.deviceId === effectiveId;

  const sceneStreaming = streamStatus?.mode === 'scene' && streamStatus.running;

  // --- live push queue (coalesced + serialized) --------------------------
  // Everything the push needs is read through a ref so `doPush` stays identity-
  // stable — otherwise react-query's mutation object flipping isPending would
  // re-fire the debounce effect in a loop.
  const pushArgs = useRef({ effectiveId, segStart, brightness, cells });
  pushArgs.current = { effectiveId, segStart, brightness, cells };
  const startPaintRef = useRef(startPaintStream);
  startPaintRef.current = startPaintStream;
  const push = useRef({ inFlight: false, pending: false });

  const doPush = useCallback(() => {
    const { effectiveId: id, segStart: ss, brightness: bri, cells: cs } = pushArgs.current;
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
    if (!live || !effectiveId) return;
    if (sceneStreaming && !sceneAck) {
      setConfirmScene(true);
      return;
    }
    const t = setTimeout(doPush, 80);
    return () => clearTimeout(t);
  }, [cells, brightness, live, effectiveId, sceneStreaming, sceneAck, doPush]);

  const touchCell = (i: number) => {
    setLoadNote(null);
    setLive(true);
    setCells((prev) => {
      if (i < 0 || i >= prev.length) return prev;
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
    width: segLen,
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
      Array.from({ length: segLen }, (_, i) => {
        const p = s.pixels[i];
        return p ? `#${p.toLowerCase()}` : null;
      }),
    );
    setBrightness(Math.max(1, Math.min(255, s.brightness)));
    setLoadedSceneId(dto.id);
    setSceneName(dto.name);
    setLive(true);
    setLoadNote(
      s.width !== segLen
        ? `“${dto.name}” was painted for ${s.width} LEDs; mapped onto this ${segLen}-LED segment by index.`
        : null,
    );
  };

  const requestLoad = (id: number, name: string) => {
    if (streamingThisDevice || litCount > 0) setConfirmLoad({ id, name });
    else void doLoad(id);
  };

  return (
    <Stack spacing={2}>
      <Box>
        <Typography variant="h3">Pixel painter</Typography>
        <Typography variant="body2" color="text.secondary">
          Paint LEDs directly. The moment you touch the canvas the selected device switches to a
          live stream from this page — every edit shows on the strip in real time. “Stop &amp;
          Release” ends the stream and the device returns to its effect. Save a canvas as a{' '}
          <strong>Pixel Scene</strong> to reload it later.
        </Typography>
      </Box>

      <Card>
        <CardContent>
          <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap alignItems="center">
            <TextField
              select
              label="Device"
              size="small"
              value={effectiveId ?? ''}
              onChange={(e) => {
                setDeviceId(Number(e.target.value));
                setSegId(null);
              }}
              sx={{ minWidth: 200 }}
            >
              {(devices ?? []).map((d) => (
                <MenuItem key={d.id} value={d.id}>
                  {d.name}
                </MenuItem>
              ))}
            </TextField>

            {segments.length > 1 ? (
              <TextField
                select
                label="Segment"
                size="small"
                value={activeSegId}
                onChange={(e) => setSegId(Number(e.target.value))}
                sx={{ minWidth: 160 }}
              >
                {segments.map((s) => (
                  <MenuItem key={s.id} value={s.id}>
                    {s.n || `Segment ${s.id}`} ({s.start ?? 0}–{s.stop ?? 0})
                  </MenuItem>
                ))}
              </TextField>
            ) : (
              <Chip
                size="small"
                variant="outlined"
                label={`Segment ${activeSegId} · ${segStart}–${segStop} (${segLen} LED${segLen === 1 ? '' : 's'})`}
              />
            )}

            {streamingThisDevice && (
              <Chip size="small" color="success" label="Streaming to this device" />
            )}
          </Stack>

          {device?.matrix && (
            <Alert severity="info" sx={{ mt: 2 }}>
              This device is a {device.matrix.w}×{device.matrix.h} matrix. The painter treats it as a
              1-D strip in wire order — a real 2-D grid needs the pixel mapping verified on a panel
              first.
            </Alert>
          )}
        </CardContent>
      </Card>

      {segLen > 0 && (
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

            <Box
              sx={{ display: 'flex', flexWrap: 'wrap', gap: '3px', userSelect: 'none' }}
              onMouseLeave={() => (dragging.current = false)}
            >
              {cells.map((c, i) => (
                <Box
                  key={i}
                  title={`LED ${i}${c ? ` · ${bare(c)}` : ' · off'}`}
                  onMouseDown={() => {
                    dragging.current = true;
                    touchCell(i);
                  }}
                  onMouseEnter={() => dragging.current && touchCell(i)}
                  sx={{
                    width: 16,
                    height: 16,
                    borderRadius: '3px',
                    cursor: 'crosshair',
                    bgcolor: c ?? 'transparent',
                    border: c ? '1px solid rgba(255,255,255,0.25)' : `1px dashed ${md3.outline}`,
                  }}
                />
              ))}
            </Box>

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
                {litCount} / {segLen} lit
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

      {segLen > 0 && (
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

      {effectiveId && segLen === 0 && (
        <Alert severity="warning">
          This device reports no addressable segment. Check that it is online and has LEDs
          configured.
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
            The Studio scene{streamStatus?.scene ? ` “${streamStatus.scene.name}”` : ''} is currently
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

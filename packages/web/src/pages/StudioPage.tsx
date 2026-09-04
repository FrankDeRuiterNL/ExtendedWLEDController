import { useEffect, useMemo, useRef, useState } from 'react';
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
  LinearProgress,
  Link,
  Menu,
  MenuItem,
  Stack,
  Switch,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import FormatBoldIcon from '@mui/icons-material/FormatBold';
import FormatItalicIcon from '@mui/icons-material/FormatItalic';
import StrikethroughSIcon from '@mui/icons-material/StrikethroughS';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import PauseIcon from '@mui/icons-material/Pause';
import StopIcon from '@mui/icons-material/Stop';
import RepeatIcon from '@mui/icons-material/Repeat';
import SaveIcon from '@mui/icons-material/Save';
import { Slider } from '@mui/material';
import {
  BLEND_MODES,
  EMPTY_SCENE,
  FULL_RECT,
  defaultMediaPlayback,
  effectDefaults,
  fitMediaRect,
  getEffect,
  kelvinToRgbGain,
  listEffects,
  makeLayer,
  makeMediaLayer,
  makeTextLayer,
  resolveMediaPositionMs,
  textRasterStale,
  textRenderHash,
  TEXT_FONTS,
  type BlendMode,
  type Layer,
  type LayerRect,
  type MediaLayerSpec,
  type MediaPlaybackType,
  type Scene,
  type TextLayerSpec,
} from '@ewc/core';
import { CanvasPreview } from '../components/CanvasPreview.js';
import { ParamControl, hexToRgb, rgbToHex } from '../components/ParamControl.js';
import { customEffectsMap, useCustomEffects } from '../api/customEffects.js';
import { mediaUrl, useUploadMedia, type UploadedMedia } from '../api/media.js';
import { rasterizeAndUploadText } from '../api/text.js';
import {
  useCreateScene,
  useDeleteScene,
  useScene,
  useScenes,
  useStartScene,
  useUpdateScene,
} from '../api/scenes.js';
import { useStopStream, useStreamStatus } from '../api/stage.js';
import { useInstallation } from '../api/stage.js';
import { useDevices } from '../api/devices.js';
import { md3 } from '../theme/tokens.js';
import { clearStudioDraft, loadStudioDraft, saveStudioDraft } from './studioDraft.js';

let seq = 0;
const newLayerId = () => `l-${Date.now().toString(36)}-${seq++}`;

/**
 * A restored draft can be minutes old, so every video layer's wall-clock
 * transport anchor is stale. Rebuild it from the persisted `playbackType` —
 * the same thing a freshly loaded saved scene does — so `loop` clips run and
 * `hold` / `hide` clips sit at the start instead of restoring "already ended".
 */
function reviveDraftTransport(scene: Scene): Scene {
  const now = Date.now();
  for (const l of scene.layers) {
    if (l.media?.kind === 'video') {
      l.media.playback = defaultMediaPlayback(l.media.playbackType, now);
    }
  }
  return scene;
}

const pct = (n: number) => Math.round(n * 100);
const isFullRect = (r: LayerRect) => r.x <= 0 && r.y <= 0 && r.w >= 1 && r.h >= 1 && !r.rot;

/** Fold degrees into (-180, 180]. */
const normDeg = (n: number) => {
  const m = ((n % 360) + 360) % 360;
  return m > 180 ? m - 360 : m;
};

function RectField({
  label,
  value,
  onCommit,
  unit = '%',
}: {
  label: string;
  value: number;
  onCommit: (value: number) => void;
  unit?: string;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const n = Number(text);
    if (text.trim() === '' || !Number.isFinite(n)) {
      setText(String(value)); // revert
      return;
    }
    onCommit(n);
  };
  return (
    <TextField
      type="number"
      size="small"
      label={label}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      InputProps={{ endAdornment: <Typography variant="caption" color="text.secondary">{unit}</Typography> }}
      sx={{ flex: 1 }}
    />
  );
}

function RegionEditor({ rect, onChange }: { rect: LayerRect; onChange: (r: LayerRect) => void }) {
  const field = (key: 'x' | 'y' | 'w' | 'h', label: string) => (
    <RectField
      label={label}
      value={pct(rect[key])}
      onCommit={(v) => onChange({ ...rect, [key]: v / 100 })}
    />
  );
  return (
    <Stack spacing={1}>
      <Stack direction="row" spacing={1}>
        {field('x', 'Left')}
        {field('y', 'Top')}
      </Stack>
      <Stack direction="row" spacing={1}>
        {field('w', 'Width')}
        {field('h', 'Height')}
      </Stack>
      <Stack direction="row" spacing={1} alignItems="center">
        <RectField
          label="Rotation"
          value={Math.round(rect.rot ?? 0)}
          onCommit={(v) => onChange({ ...rect, rot: normDeg(v) || undefined })}
          unit="°"
        />
        <Button size="small" disabled={!rect.rot} onClick={() => onChange({ ...rect, rot: undefined })}>
          0°
        </Button>
      </Stack>
      <Button
        size="small"
        disabled={isFullRect(rect)}
        onClick={() => onChange({ ...FULL_RECT })}
      >
        Fill canvas
      </Button>
      <Typography variant="caption" color="text.secondary">
        The effect fills this box; LEDs outside it fall through to the layers below. Drag the box on
        the preview to move it, corners to resize, the top handle to rotate (hold Shift to snap 15°).
      </Typography>
    </Stack>
  );
}

const PLAYBACK_TYPES: { value: MediaPlaybackType; label: string }[] = [
  { value: 'loop', label: 'Loop indefinitely' },
  { value: 'hold', label: 'Play + hold last frame' },
  { value: 'hide', label: 'Play + hide when stopped' },
];

/** `123456` → `2:03.4` */
function fmtClock(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${rest.toFixed(1).padStart(4, '0')}`;
}

/** Transport + trim for a **video** media layer. */
function MediaPlaybackControls({
  media,
  onPatch,
}: {
  media: MediaLayerSpec;
  onPatch: (m: MediaLayerSpec) => void;
}) {
  const duration = Math.max(0, media.durationMs ?? 0);
  const trimIn = Math.min(media.trimInMs ?? 0, duration);
  const trimOut = Math.min(media.trimOutMs ?? duration, duration);
  const type = media.playbackType ?? 'loop';
  const state = (media.playback ?? defaultMediaPlayback(type, Date.now())).state;

  const [trim, setTrim] = useState<[number, number]>([trimIn, trimOut]);
  const dragging = useRef(false);
  useEffect(() => {
    if (!dragging.current) setTrim([trimIn, trimOut]);
  }, [trimIn, trimOut]);

  const setState = (next: 'playing' | 'paused' | 'stopped') => {
    const now = Date.now();
    const head = next === 'stopped' ? 0 : resolveMediaPositionMs(media, duration, now) ?? 0;
    onPatch({ ...media, playback: { state: next, anchorMs: now, headMs: head } });
  };
  const setType = (next: MediaPlaybackType) => {
    // Re-anchor so playback keeps its current position under the new rule.
    const now = Date.now();
    const head = resolveMediaPositionMs(media, duration, now) ?? 0;
    const curState = (media.playback ?? defaultMediaPlayback(type, now)).state;
    onPatch({
      ...media,
      playbackType: next,
      playback: { state: curState === 'stopped' && next === 'loop' ? 'playing' : curState, anchorMs: now, headMs: head },
    });
  };
  const commitTrim = ([a, b]: number[]) => {
    dragging.current = false;
    const lo = Math.min(a!, b!);
    const hi = Math.max(a!, b!);
    onPatch({
      ...media,
      trimInMs: lo <= 0 ? undefined : lo,
      trimOutMs: hi >= duration ? undefined : hi,
    });
  };

  return (
    <>
      <Divider>
        <Typography variant="caption" color="text.secondary">
          Playback
        </Typography>
      </Divider>

      <TextField
        select
        size="small"
        label="Playback type"
        value={type}
        onChange={(e) => setType(e.target.value as MediaPlaybackType)}
      >
        {PLAYBACK_TYPES.map((p) => (
          <MenuItem key={p.value} value={p.value}>
            {p.label}
          </MenuItem>
        ))}
      </TextField>

      {duration > 0 && (
        <Box>
          <Stack direction="row" justifyContent="space-between">
            <Typography variant="body2">Trim</Typography>
            <Typography variant="caption" color="text.secondary">
              {fmtClock(trim[0])} – {fmtClock(trim[1])}
            </Typography>
          </Stack>
          <Box sx={{ px: 0.5 }}>
            <Slider
              size="small"
              min={0}
              max={duration}
              step={50}
              value={trim}
              valueLabelDisplay="auto"
              valueLabelFormat={fmtClock}
              onChange={(_, v) => {
                dragging.current = true;
                setTrim(v as [number, number]);
              }}
              onChangeCommitted={(_, v) => commitTrim(v as number[])}
              disableSwap
            />
          </Box>
        </Box>
      )}

      <Stack direction="row" spacing={0.5} alignItems="center">
        <Tooltip title={state === 'playing' ? 'Playing' : 'Play'}>
          <span>
            <IconButton
              size="small"
              color={state === 'playing' ? 'primary' : 'default'}
              disabled={state === 'playing'}
              onClick={() => setState('playing')}
            >
              <PlayArrowIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title="Pause">
          <span>
            <IconButton
              size="small"
              color={state === 'paused' ? 'primary' : 'default'}
              disabled={state !== 'playing'}
              onClick={() => setState('paused')}
            >
              <PauseIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title="Stop (back to start)">
          <span>
            <IconButton
              size="small"
              color={state === 'stopped' ? 'primary' : 'default'}
              disabled={state === 'stopped'}
              onClick={() => setState('stopped')}
            >
              <StopIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <Box sx={{ flex: 1 }} />
        <Tooltip title={type === 'loop' ? 'Looping' : 'Loop'}>
          <IconButton
            size="small"
            color={type === 'loop' ? 'primary' : 'default'}
            onClick={() => setType(type === 'loop' ? 'hold' : 'loop')}
          >
            <RepeatIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>
      <Typography variant="caption" color="text.secondary">
        Transport drives the preview and the live stream. It is not saved with the scene —
        on reload the clip {type === 'loop' ? 'starts looping' : 'waits at the start'}.
      </Typography>
    </>
  );
}

function MediaLayerInspector({
  layer,
  canvas,
  onPatch,
  onUploaded,
}: {
  layer: Layer;
  canvas: { width: number; height: number };
  onPatch: (p: Partial<Layer>) => void;
  onUploaded: (m: UploadedMedia) => void;
}) {
  const upload = useUploadMedia();
  const fileInput = useRef<HTMLInputElement>(null);
  const media = layer.media ?? null;
  const isVideo = media?.kind === 'video';

  const pick = () => fileInput.current?.click();
  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (f) upload.mutate(f, { onSuccess: onUploaded });
  };

  const pct100 = Math.round(upload.progress * 100);

  return (
    <Card>
      <CardContent>
        <Stack spacing={1.5}>
          <TextField
            size="small"
            label="Layer name"
            placeholder={media?.filename ?? 'Media layer'}
            value={layer.name ?? ''}
            onChange={(e) => onPatch({ name: e.target.value })}
            InputLabelProps={{ shrink: true }}
          />

          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,video/quicktime"
            hidden
            onChange={onFile}
          />

          {media ? (
            <Stack direction="row" spacing={1.5} alignItems="center">
              <Box
                component={isVideo ? 'video' : 'img'}
                src={mediaUrl(media.assetId)}
                {...(isVideo ? { muted: true, loop: true, autoPlay: true, playsInline: true } : { alt: '' })}
                sx={{
                  width: 64,
                  height: 64,
                  objectFit: 'contain',
                  borderRadius: 1,
                  border: `1px solid ${md3.outline}`,
                  bgcolor: '#000',
                }}
              />
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography variant="body2" noWrap title={media.filename}>
                  {media.filename}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {isVideo ? 'Video · ' : ''}
                  {media.naturalWidth}×{media.naturalHeight}
                </Typography>
                <Button size="small" onClick={pick} disabled={upload.isPending} sx={{ display: 'block', mt: 0.5 }}>
                  {upload.isPending ? 'Uploading…' : isVideo ? 'Replace video' : 'Replace media'}
                </Button>
              </Box>
            </Stack>
          ) : (
            <Button variant="outlined" onClick={pick} disabled={upload.isPending}>
              {upload.isPending ? 'Uploading…' : 'Upload image or video'}
            </Button>
          )}
          {upload.isPending && upload.progress > 0 && (
            <Box>
              <LinearProgress variant="determinate" value={pct100} />
              <Typography variant="caption" color="text.secondary">
                Uploading video… {pct100}% — transcoding starts when the upload finishes.
              </Typography>
            </Box>
          )}
          {upload.isError && (
            <Alert severity="error">{(upload.error as Error).message}</Alert>
          )}
          <Typography variant="caption" color="text.secondary">
            {isVideo
              ? 'Fixtures under the box take their colour from the video frame playing now.'
              : 'Fixtures under the box take their colour from the media. Images are still; upload an .mp4 / .mov for motion.'}
          </Typography>

          {isVideo && media && (
            <MediaPlaybackControls media={media} onPatch={(m) => onPatch({ media: m })} />
          )}

          <Divider>
            <Typography variant="caption" color="text.secondary">
              Blend
            </Typography>
          </Divider>
          <TextField
            select
            size="small"
            label="Blend"
            value={layer.blend}
            onChange={(e) => onPatch({ blend: e.target.value as BlendMode })}
          >
            {BLEND_MODES.map((b) => (
              <MenuItem key={b.value} value={b.value}>
                {b.label}
              </MenuItem>
            ))}
          </TextField>
          <Box>
            <Stack direction="row" justifyContent="space-between">
              <Typography variant="body2">Opacity</Typography>
              <Typography variant="caption" color="text.secondary">
                {Math.round(layer.opacity * 100)}%
              </Typography>
            </Stack>
            <Box sx={{ px: 0.5 }}>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={layer.opacity}
                onChange={(e) => onPatch({ opacity: Number(e.target.value) })}
                style={{ width: '100%' }}
              />
            </Box>
          </Box>

          <Divider>
            <Typography variant="caption" color="text.secondary">
              Canvas region
            </Typography>
          </Divider>
          <RegionEditor
            rect={layer.rect ?? FULL_RECT}
            onChange={(rect) => onPatch({ rect })}
          />
          {media && (
            <Button
              size="small"
              onClick={() =>
                onPatch({ rect: fitMediaRect(media.naturalWidth, media.naturalHeight, canvas) })
              }
            >
              Reset box to {isVideo ? 'video' : 'image'} aspect
            </Button>
          )}
        </Stack>
      </CardContent>
    </Card>
  );
}

const TEXT_DEFAULT: TextLayerSpec = { value: 'Text', fontId: TEXT_FONTS[0]!.id, sizePx: 96, color: [255, 255, 255] };

function TextLayerInspector({
  layer,
  canvas,
  onPatch,
}: {
  layer: Layer;
  canvas: { width: number; height: number };
  onPatch: (p: Partial<Layer>) => void;
}) {
  const spec = layer.text ?? TEXT_DEFAULT;
  const [error, setError] = useState<string | null>(null);
  const [rendering, setRendering] = useState(false);
  const hash = textRenderHash(spec);
  const stale = textRasterStale(spec);

  // Rasterise the string (real fonts, in the browser) and upload it as an image
  // asset whenever a render-affecting field settles. Debounced so a burst of
  // keystrokes makes one asset, not one per character.
  useEffect(() => {
    if (!stale) {
      setRendering(false);
      return;
    }
    let cancelled = false;
    setRendering(true);
    const timer = setTimeout(() => {
      rasterizeAndUploadText(spec)
        .then((r) => {
          if (cancelled) return;
          setError(null);
          onPatch({
            text: {
              ...spec,
              assetId: r.assetId,
              naturalWidth: r.naturalWidth,
              naturalHeight: r.naturalHeight,
              renderHash: r.renderHash,
            },
            // Only fit the box on the very first raster (no asset yet). After
            // that the user owns the box — editing the text or colour must not
            // yank it back to a centred default. "Reset box to text aspect"
            // re-fits on demand.
            ...(spec.assetId ? {} : { rect: fitMediaRect(r.naturalWidth, r.naturalHeight, canvas) }),
          });
        })
        .catch((e) => {
          if (!cancelled) setError((e as Error).message);
        })
        .finally(() => {
          if (!cancelled) setRendering(false);
        });
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hash]);

  const set = (p: Partial<TextLayerSpec>) => onPatch({ text: { ...spec, ...p } });
  const styles: string[] = [
    ...(spec.bold ? ['bold'] : []),
    ...(spec.italic ? ['italic'] : []),
    ...(spec.strikethrough ? ['strike'] : []),
  ];
  const colorHex = rgbToHex(spec.color ?? [255, 255, 255]);

  return (
    <Card>
      <CardContent>
        <Stack spacing={1.5}>
          <TextField
            size="small"
            label="Layer name"
            placeholder="Text layer"
            value={layer.name ?? ''}
            onChange={(e) => onPatch({ name: e.target.value })}
            InputLabelProps={{ shrink: true }}
          />
          <TextField
            size="small"
            label="Text value"
            placeholder="Type the words to show…"
            value={spec.value}
            onChange={(e) => set({ value: e.target.value })}
            multiline
            minRows={1}
            maxRows={4}
            InputLabelProps={{ shrink: true }}
          />

          <TextField
            select
            size="small"
            label="Font"
            value={spec.fontId}
            onChange={(e) => set({ fontId: e.target.value })}
          >
            {TEXT_FONTS.map((f) => (
              <MenuItem key={f.id} value={f.id} sx={{ fontFamily: f.stack }}>
                {f.label}
              </MenuItem>
            ))}
          </TextField>

          <Stack direction="row" spacing={1.5} alignItems="center">
            <ToggleButtonGroup
              size="small"
              value={styles}
              onChange={(_, next: string[]) =>
                set({
                  bold: next.includes('bold'),
                  italic: next.includes('italic'),
                  strikethrough: next.includes('strike'),
                })
              }
            >
              <ToggleButton value="bold" aria-label="Bold">
                <FormatBoldIcon fontSize="small" />
              </ToggleButton>
              <ToggleButton value="italic" aria-label="Italic">
                <FormatItalicIcon fontSize="small" />
              </ToggleButton>
              <ToggleButton value="strike" aria-label="Strikethrough">
                <StrikethroughSIcon fontSize="small" />
              </ToggleButton>
            </ToggleButtonGroup>
            <TextField
              size="small"
              type="number"
              label="Size (px)"
              value={spec.sizePx}
              onChange={(e) => {
                const n = Math.round(Number(e.target.value));
                if (Number.isFinite(n)) set({ sizePx: Math.min(400, Math.max(8, n)) });
              }}
              inputProps={{ min: 8, max: 400, step: 4 }}
              sx={{ width: 108 }}
            />
            <Stack alignItems="center" spacing={0.25}>
              <Typography variant="caption" color="text.secondary">
                Colour
              </Typography>
              <input
                type="color"
                value={colorHex}
                onChange={(e) => set({ color: hexToRgb(e.target.value) })}
                style={{ width: 40, height: 28, background: 'none', border: 'none', padding: 0 }}
              />
            </Stack>
          </Stack>

          {error ? (
            <Alert severity="error" onClose={() => setError(null)}>
              {error}
            </Alert>
          ) : (
            <Typography variant="caption" color="text.secondary">
              {rendering || stale
                ? 'Rendering the text…'
                : 'Fixtures under the box take their colour from the rendered text. The box re-centres to fit the text each time you edit it.'}
            </Typography>
          )}

          <Divider>
            <Typography variant="caption" color="text.secondary">
              Blend
            </Typography>
          </Divider>
          <TextField
            select
            size="small"
            label="Blend"
            value={layer.blend}
            onChange={(e) => onPatch({ blend: e.target.value as BlendMode })}
          >
            {BLEND_MODES.map((b) => (
              <MenuItem key={b.value} value={b.value}>
                {b.label}
              </MenuItem>
            ))}
          </TextField>
          <Box>
            <Stack direction="row" justifyContent="space-between">
              <Typography variant="body2">Opacity</Typography>
              <Typography variant="caption" color="text.secondary">
                {Math.round(layer.opacity * 100)}%
              </Typography>
            </Stack>
            <Box sx={{ px: 0.5 }}>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={layer.opacity}
                onChange={(e) => onPatch({ opacity: Number(e.target.value) })}
                style={{ width: '100%' }}
              />
            </Box>
          </Box>

          <Divider>
            <Typography variant="caption" color="text.secondary">
              Canvas region
            </Typography>
          </Divider>
          <RegionEditor rect={layer.rect ?? FULL_RECT} onChange={(rect) => onPatch({ rect })} />
          {spec.naturalWidth && spec.naturalHeight && (
            <Button
              size="small"
              onClick={() =>
                onPatch({ rect: fitMediaRect(spec.naturalWidth!, spec.naturalHeight!, canvas) })
              }
            >
              Reset box to text aspect
            </Button>
          )}
        </Stack>
      </CardContent>
    </Card>
  );
}

export function StudioPage() {
  const { data: sceneList } = useScenes();
  const { data: installation } = useInstallation();
  const { data: customEffectRows } = useCustomEffects();
  const customEffects = useMemo(() => customEffectsMap(customEffectRows), [customEffectRows]);
  const { data: devices } = useDevices();
  const { data: stream } = useStreamStatus();
  const create = useCreateScene();
  const update = useUpdateScene();
  const del = useDeleteScene();
  const startScene = useStartScene();
  const stopStream = useStopStream();

  /** An unsaved editor state stashed before the user navigated away — restored
   *  here so leaving Scenes (even mid-stream) no longer throws the scene out. */
  const restored = useRef(loadStudioDraft());

  const [sceneId, setSceneId] = useState<number | null>(() => restored.current?.sceneId ?? null);
  /** Set only when the user explicitly picks a scene to load, so a save (which
   *  also updates the cached scene) never clobbers the editor or drops live-sync. */
  const [pendingLoad, setPendingLoad] = useState<number | null>(null);
  const { data: loaded } = useScene(sceneId);
  const [scene, setScene] = useState<Scene>(() =>
    restored.current
      ? reviveDraftTransport(structuredClone(restored.current.scene))
      : structuredClone(EMPTY_SCENE),
  );
  const [selectedId, setSelectedId] = useState<string | null>(
    () => restored.current?.selectedLayerId ?? null,
  );
  const [dirty, setDirty] = useState(() => restored.current?.dirty ?? false);
  /** True once this editor's scene has been pushed to the stream — every later
   *  edit then hot-swaps the live stream so the wall tracks the preview. A
   *  restored draft keeps it optimistically; the reconcile effect below drops it
   *  if the wire turns out to be running something else (e.g. a Rundown cue). */
  const [liveSync, setLiveSync] = useState(() => restored.current?.liveSync ?? false);

  /** Floorplan overlay on the preview — independent of the Layout page's toggle. */
  const [showFloorplan, setShowFloorplan] = useState(() => {
    try {
      return localStorage.getItem('ewc.studio.showFloorplan') === '1';
    } catch {
      return false;
    }
  });
  const toggleFloorplan = (on: boolean) => {
    setShowFloorplan(on);
    try {
      localStorage.setItem('ewc.studio.showFloorplan', on ? '1' : '0');
    } catch {
      /* private mode — no persistence */
    }
  };

  /** "As-output" preview: black canvas, fixtures lit with their real colour.
   *  Preview-only — the stream keeps running unchanged. */
  const [showOutput, setShowOutput] = useState(() => {
    try {
      return localStorage.getItem('ewc.studio.showOutput') === '1';
    } catch {
      return false;
    }
  });
  const toggleOutput = (on: boolean) => {
    setShowOutput(on);
    try {
      localStorage.setItem('ewc.studio.showOutput', on ? '1' : '0');
    } catch {
      /* private mode — no persistence */
    }
  };

  /** Pending scene switch awaiting confirmation (only shown while streaming). */
  const [confirmLoad, setConfirmLoad] = useState<{ id: number | null } | null>(null);

  /** Anchor for the "+ Add" layer-type menu. */
  const [addAnchor, setAddAnchor] = useState<null | HTMLElement>(null);

  const loadScene = (id: number | null) => {
    setSceneId(id);
    setPendingLoad(id);
    if (id == null) {
      setScene({ ...structuredClone(EMPTY_SCENE), name: 'New scene' });
      setSelectedId(null);
      setDirty(true);
      setLiveSync(false);
    }
  };


  useEffect(() => {
    if (pendingLoad != null && loaded && loaded.id === pendingLoad) {
      const fresh = structuredClone(loaded.scene);
      // Transport state isn't persisted — reconstruct it from the playback type
      // so a "Loop indefinitely" clip runs and the others wait at the start.
      const now = Date.now();
      for (const l of fresh.layers) {
        if (l.media?.kind === 'video' && !l.media.playback) {
          l.media.playback = defaultMediaPlayback(l.media.playbackType, now);
        }
      }
      setScene(fresh);
      setDirty(false);
      setLiveSync(false); // a freshly loaded scene isn't the one on the wire
      setSelectedId(fresh.layers[0]?.id ?? null);
      setPendingLoad(null);
    }
  }, [loaded, pendingLoad]);

  const patch = (next: Partial<Scene>) => {
    setScene((s) => ({ ...s, ...next }));
    setDirty(true);
  };
  const patchLayer = (id: string, p: Partial<Layer>) => {
    setScene((s) => ({ ...s, layers: s.layers.map((l) => (l.id === id ? { ...l, ...p } : l)) }));
    setDirty(true);
  };
  const move = (id: string, dir: -1 | 1) => {
    setScene((s) => {
      const i = s.layers.findIndex((l) => l.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= s.layers.length) return s;
      const layers = [...s.layers];
      [layers[i], layers[j]] = [layers[j]!, layers[i]!];
      return { ...s, layers };
    });
    setDirty(true);
  };
  const addLayer = (effectId: string) => {
    const l = makeLayer(newLayerId(), effectId);
    setScene((s) => ({ ...s, layers: [...s.layers, l] }));
    setSelectedId(l.id);
    setDirty(true);
  };
  const addMediaLayer = () => {
    const l = makeMediaLayer(newLayerId());
    setScene((s) => ({ ...s, layers: [...s.layers, l] }));
    setSelectedId(l.id);
    setDirty(true);
  };
  const addTextLayer = () => {
    const l = makeTextLayer(newLayerId());
    setScene((s) => ({ ...s, layers: [...s.layers, l] }));
    setSelectedId(l.id);
    setDirty(true);
  };
  const setLayerMedia = (id: string, m: UploadedMedia) => {
    const isVideo = m.kind === 'video';
    patchLayer(id, {
      media: {
        assetId: m.assetId,
        filename: m.filename,
        kind: m.kind ?? 'image',
        naturalWidth: m.naturalWidth,
        naturalHeight: m.naturalHeight,
        ...(isVideo
          ? {
              durationMs: m.durationMs,
              playbackType: 'loop' as const,
              playback: defaultMediaPlayback('loop', Date.now()),
            }
          : {}),
      },
      rect: fitMediaRect(m.naturalWidth, m.naturalHeight, {
        width: installation?.canvas.width ?? 16,
        height: installation?.canvas.height ?? 9,
      }),
    });
  };
  const removeLayer = (id: string) => {
    setScene((s) => ({ ...s, layers: s.layers.filter((l) => l.id !== id) }));
    setSelectedId((cur) => (cur === id ? null : cur));
    setDirty(true);
  };

  const selected = scene.layers.find((l) => l.id === selectedId) ?? null;
  const selectedIsText = !!selected && selected.text != null;
  const selectedIsMedia = !!selected && !selectedIsText && selected.media !== undefined;
  const selectedDef =
    selected && !selectedIsMedia && !selectedIsText
      ? getEffect(selected.effectId) ?? customEffects.get(selected.effectId)
      : undefined;
  const selectedIsCustomEffect = !!selected?.effectId.startsWith('custom:');

  const running = stream?.running ?? false;
  const sceneRunning = running && stream?.mode === 'scene';
  const streamingThis = sceneRunning && liveSync;

  /** Switch scenes — but confirm first if a stream is running. Re-picking the
   *  current scene is a no-op unless the editor holds unsaved changes, in which
   *  case it reloads the saved version (i.e. discards the restored draft). */
  const requestLoadScene = (id: number | null) => {
    if (id === sceneId && !dirty) return;
    if (sceneRunning) setConfirmLoad({ id });
    else loadScene(id);
  };

  /**
   * Live-stream push queue. While `enabled`, every scene edit is pushed to the
   * server (which hot-swaps the compositor). Coalesced + serialized: at most one
   * push in flight, always carrying the newest scene. `stopSync()` disables it
   * and drops any queued push; `inFlight` lets a stop wait out a push already on
   * the wire so it can't resurrect the stream after `/stream/stop`.
   */
  const push = useRef<{ enabled: boolean; inFlight: boolean; pending: Scene | null }>({
    enabled: false,
    inFlight: false,
    pending: null,
  });
  const drainPush = useRef<() => void>(() => {});
  drainPush.current = () => {
    const q = push.current;
    if (q.inFlight || !q.pending) return;
    q.inFlight = true;
    const s = q.pending;
    q.pending = null;
    startScene
      .mutateAsync({ scene: s })
      .catch(() => {})
      .finally(() => {
        q.inFlight = false;
        if (q.enabled && q.pending) drainPush.current();
      });
  };
  const queuePush = (s: Scene) => {
    push.current.pending = s;
    drainPush.current();
  };
  const startSync = (s: Scene) => {
    push.current.enabled = true;
    queuePush(s);
    setLiveSync(true);
  };
  const stopSync = () => {
    push.current.enabled = false;
    push.current.pending = null;
    setLiveSync(false);
  };

  // Stream ended (or switched away from scene mode) elsewhere → drop live-sync.
  // Wait for the first real status: on a fresh mount `stream` is undefined, and
  // a restored draft must not be torn down before we know what's on the wire.
  useEffect(() => {
    if (stream && !sceneRunning) stopSync();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stream, sceneRunning]);

  // Reconcile a restored draft against the live stream, once, when the first
  // status arrives. If the wire is running this scene, re-arm the hot-swap push
  // queue; if it's running something else (a Rundown cue keeps `mode === 'scene'`
  // without claiming the editor), drop live-sync so we don't overwrite it.
  const reconciled = useRef(!restored.current?.liveSync);
  useEffect(() => {
    if (reconciled.current || !stream) return;
    reconciled.current = true;
    const mine =
      stream.mode === 'scene' &&
      !!stream.scene &&
      stream.scene.name === scene.name &&
      stream.scene.layerCount === scene.layers.length;
    if (mine) push.current.enabled = true;
    else stopSync();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stream]);

  useEffect(() => {
    if (!liveSync || !sceneRunning) return;
    const id = setTimeout(() => queuePush(scene), 90);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene, liveSync, sceneRunning]);

  // Stash the editor across navigation whenever it holds something worth keeping
  // — unsaved edits, or a scene that's on the wire — and clear it once saved and
  // idle so a clean revisit starts empty.
  useEffect(() => {
    if (dirty || liveSync) {
      saveStudioDraft({ scene, sceneId, dirty, liveSync, selectedLayerId: selectedId });
    } else {
      clearStudioDraft();
    }
  }, [scene, sceneId, dirty, liveSync, selectedId]);

  const deviceGains = useMemo(() => {
    const m: Record<number, readonly [number, number, number]> = {};
    for (const d of stream?.devices ?? []) {
      if (d.whiteBalance?.enabled) m[d.deviceId] = kelvinToRgbGain(d.whiteBalance.kelvin);
    }
    return m;
  }, [stream?.devices]);

  const orphanFixtures = useMemo(() => {
    if (!installation || !devices) return [];
    const known = new Set(devices.map((d) => d.id));
    return installation.fixtures.filter((f) => f.enabled && !known.has(f.deviceId)).map((f) => f.name);
  }, [installation, devices]);

  const save = () => {
    if (sceneId != null) update.mutate({ id: sceneId, name: scene.name, scene }, { onSuccess: () => setDirty(false) });
    else
      create.mutate(
        { name: scene.name, scene },
        { onSuccess: (s) => { setSceneId(s.id); setDirty(false); } },
      );
  };


  return (
    <Stack spacing={3}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" flexWrap="wrap" gap={1}>
        <Box>
          <Typography variant="h2">Scenes</Typography>
          <Typography variant="body2" color="text.secondary">
            Stack effect and media layers on the shared canvas. Preview here, then stream it to the fixtures.
          </Typography>
        </Box>
        <Stack direction="row" spacing={1} alignItems="center">
          {!streamingThis && (
            <Button
              variant="contained"
              startIcon={<PlayArrowIcon />}
              disabled={scene.layers.length === 0}
              onClick={() => startSync(scene)}
            >
              Stream this scene
            </Button>
          )}
          {sceneRunning && (
            <Button
              variant="outlined"
              color="error"
              startIcon={<StopIcon />}
              onClick={() => {
                stopSync();
                stopStream.mutate();
              }}
            >
              Stop &amp; release
            </Button>
          )}
          {streamingThis ? (
            <Chip color="success" size="small" label="live · tracking preview" />
          ) : (
            sceneRunning && (
              <Chip color="warning" size="small" variant="outlined" label={`streaming · ${stream?.scene?.name ?? ''}`} />
            )
          )}
        </Stack>
      </Stack>

      {stream?.scene?.unknownEffects?.length ? (
        <Alert severity="warning">
          The running scene uses effects this build doesn&apos;t know: {stream.scene.unknownEffects.join(', ')}. Those
          layers are skipped.
        </Alert>
      ) : null}

      {orphanFixtures.length > 0 && (
        <Alert severity="warning">
          {orphanFixtures.length === 1 ? 'Fixture' : 'Fixtures'} <b>{orphanFixtures.join(', ')}</b> on the Layout point
          at a device that no longer exists — those LEDs will stay dark. Fix the fixture on the Layout page.
        </Alert>
      )}

      <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', md: '1fr 360px' } }}>
        {/* preview + scene management */}
        <Stack spacing={2}>
          <Card>
            <CardContent sx={{ p: 1, '&:last-child': { pb: 1 } }}>
              <CanvasPreview
                scene={scene}
                installation={installation}
                playing
                editable={!showOutput}
                showFloorplan={showFloorplan}
                showOutputOnly={showOutput}
                deviceGains={deviceGains}
                customEffects={customEffects}
                epochMs={streamingThis ? stream?.epochMs ?? null : null}
                selectedLayerId={selectedId}
                onSelectLayer={setSelectedId}
                onLayerRect={(id, rect) => patchLayer(id, { rect })}
              />
            </CardContent>
          </Card>
          <Stack direction="row" alignItems="center" spacing={2} sx={{ px: 0.5 }} flexWrap="wrap" useFlexGap>
            <Stack direction="row" alignItems="center" spacing={1}>
              <Switch
                size="small"
                checked={showOutput}
                onChange={(e) => toggleOutput(e.target.checked)}
              />
              <Typography variant="body2" color="text.secondary">
                Show output
              </Typography>
            </Stack>
            {installation?.floorplan && (
              <Stack direction="row" alignItems="center" spacing={1}>
                <Switch
                  size="small"
                  checked={showFloorplan}
                  onChange={(e) => toggleFloorplan(e.target.checked)}
                />
                <Typography variant="body2" color="text.secondary">
                  Show floorplan
                </Typography>
              </Stack>
            )}
          </Stack>
          {showOutput && (
            <Typography variant="caption" color="text.secondary" sx={{ px: 0.5, mt: -1 }}>
              Preview only — the fixtures show their live output colour over a black canvas (the
              floorplan still shows if enabled). The stream keeps running unchanged.
            </Typography>
          )}
          <Card>
            <CardContent>
              <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap alignItems="center">
                <TextField
                  size="small"
                  label="Scene name"
                  value={scene.name}
                  onChange={(e) => patch({ name: e.target.value })}
                  sx={{ flex: 1, minWidth: 180 }}
                />
                <Button startIcon={<SaveIcon />} variant="contained" disabled={!dirty} onClick={save}>
                  {sceneId == null ? 'Save' : dirty ? 'Save' : 'Saved'}
                </Button>
                <Button onClick={() => requestLoadScene(null)}>New</Button>
              </Stack>

              <Divider sx={{ my: 1.5 }} />

              <Stack direction="row" alignItems="center" spacing={1}>
                <TextField
                  select
                  size="small"
                  label="Load scene"
                  value={sceneId ?? ''}
                  onChange={(e) => requestLoadScene(e.target.value === '' ? null : Number(e.target.value))}
                  sx={{ flex: 1 }}
                >
                  <MenuItem value="">
                    <em>Unsaved</em>
                  </MenuItem>
                  {(sceneList ?? []).map((s) => (
                    <MenuItem key={s.id} value={s.id}>
                      {s.name} · {s.layerCount} layer{s.layerCount === 1 ? '' : 's'}
                    </MenuItem>
                  ))}
                </TextField>
                {sceneId != null && (
                  <Tooltip title="Delete scene">
                    <IconButton
                      color="error"
                      onClick={() => {
                        del.mutate(sceneId);
                        loadScene(null);
                      }}
                    >
                      <DeleteOutlineIcon />
                    </IconButton>
                  </Tooltip>
                )}
              </Stack>

              <Divider sx={{ my: 1.5 }} />

              <Stack direction="row" alignItems="center" justifyContent="space-between">
                <Typography variant="body2">Background</Typography>
                <Box
                  component="label"
                  sx={{
                    width: 40, height: 28, borderRadius: 1, border: `1px solid ${md3.outline}`,
                    overflow: 'hidden', cursor: 'pointer', bgcolor: rgbToHex(scene.background),
                  }}
                >
                  <input
                    type="color"
                    value={rgbToHex(scene.background)}
                    onChange={(e) => patch({ background: hexToRgb(e.target.value) })}
                    style={{ opacity: 0, width: '100%', height: '100%', cursor: 'pointer' }}
                  />
                </Box>
              </Stack>

              {!installation?.fixtures.length && (
                <Alert severity="info" sx={{ mt: 1.5 }}>
                  No fixtures placed yet — add them on the <b>Layout</b> page or the stream will light nothing.
                </Alert>
              )}
            </CardContent>
          </Card>
        </Stack>

        {/* layer stack + inspector */}
        <Stack spacing={2}>
          <Card>
            <CardContent>
              <Stack direction="row" alignItems="center" justifyContent="space-between">
                <Typography variant="h4">Layers</Typography>
                <Button
                  size="small"
                  startIcon={<AddIcon />}
                  onClick={(e) => setAddAnchor(e.currentTarget)}
                >
                  Add
                </Button>
                <Menu anchorEl={addAnchor} open={!!addAnchor} onClose={() => setAddAnchor(null)}>
                  <MenuItem
                    onClick={() => {
                      addLayer('solid');
                      setAddAnchor(null);
                    }}
                  >
                    FX Layer
                  </MenuItem>
                  <MenuItem
                    onClick={() => {
                      addMediaLayer();
                      setAddAnchor(null);
                    }}
                  >
                    Media Layer
                  </MenuItem>
                  <MenuItem
                    onClick={() => {
                      addTextLayer();
                      setAddAnchor(null);
                    }}
                  >
                    Text Layer
                  </MenuItem>
                </Menu>
              </Stack>

              {scene.layers.length === 0 && (
                <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                  No layers. <b>FX Layer</b> is a plain solid you can change below; <b>Media Layer</b>{' '}
                  maps an image or video onto the fixtures under it; <b>Text Layer</b> draws a string.
                </Typography>
              )}

              <Stack spacing={0.5} sx={{ mt: 1 }}>
                {[...scene.layers].reverse().map((l) => {
                  const def = getEffect(l.effectId) ?? customEffects.get(l.effectId);
                  const isSel = l.id === selectedId;
                  const label =
                    l.name?.trim() ||
                    (l.text != null
                      ? l.text.value.trim() || 'Text layer'
                      : l.media !== undefined
                        ? l.media?.filename || 'Media layer'
                        : def?.name || l.effectId);
                  const mediaTag =
                    l.text != null
                      ? ' · text'
                      : l.media === undefined
                        ? ''
                        : l.media === null
                          ? ' · media'
                          : l.media.kind === 'video'
                            ? ' · video'
                            : ' · image';
                  return (
                    <Stack
                      key={l.id}
                      direction="row"
                      alignItems="center"
                      spacing={0.5}
                      onClick={() => setSelectedId(l.id)}
                      sx={{
                        p: 0.5,
                        borderRadius: 1,
                        cursor: 'pointer',
                        bgcolor: isSel ? `${md3.primary}14` : 'transparent',
                        border: `1px solid ${isSel ? md3.primary : 'transparent'}`,
                        opacity: l.enabled ? 1 : 0.5,
                      }}
                    >
                      <Switch
                        size="small"
                        checked={l.enabled}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => patchLayer(l.id, { enabled: e.target.checked })}
                      />
                      <Typography variant="body2" sx={{ flex: 1 }} noWrap>
                        {label}
                        <Typography component="span" variant="caption" color="text.secondary">
                          {mediaTag}
                          {` · ${pct(l.opacity)}%`}
                          {l.blend !== 'normal' && ` · ${l.blend}`}
                        </Typography>
                      </Typography>
                      <IconButton size="small" onClick={(e) => { e.stopPropagation(); move(l.id, 1); }}>
                        <ArrowUpwardIcon fontSize="inherit" />
                      </IconButton>
                      <IconButton size="small" onClick={(e) => { e.stopPropagation(); move(l.id, -1); }}>
                        <ArrowDownwardIcon fontSize="inherit" />
                      </IconButton>
                      <IconButton size="small" onClick={(e) => { e.stopPropagation(); removeLayer(l.id); }}>
                        <DeleteOutlineIcon fontSize="inherit" />
                      </IconButton>
                    </Stack>
                  );
                })}
              </Stack>
            </CardContent>
          </Card>

          {selected && selectedIsMedia && (
            <MediaLayerInspector
              key={selected.id}
              layer={selected}
              canvas={installation?.canvas ?? { width: 16, height: 9 }}
              onPatch={(p) => patchLayer(selected.id, p)}
              onUploaded={(m) => setLayerMedia(selected.id, m)}
            />
          )}

          {selected && selectedIsText && (
            <TextLayerInspector
              key={selected.id}
              layer={selected}
              canvas={installation?.canvas ?? { width: 16, height: 9 }}
              onPatch={(p) => patchLayer(selected.id, p)}
            />
          )}

          {selected && selectedDef && (
            <Card>
              <CardContent>
                <Stack spacing={1.5}>
                  <TextField
                    size="small"
                    label="Layer name"
                    placeholder={selectedDef.name}
                    value={selected.name ?? ''}
                    onChange={(e) => patchLayer(selected.id, { name: e.target.value })}
                    InputLabelProps={{ shrink: true }}
                  />
                  <TextField
                    select
                    size="small"
                    label="Effect"
                    value={selected.effectId}
                    onChange={(e) =>
                      patchLayer(selected.id, { effectId: e.target.value, params: effectDefaults(e.target.value) })
                    }
                  >
                    {listEffects().map((e) => (
                      <MenuItem key={e.id} value={e.id}>
                        {e.name}
                      </MenuItem>
                    ))}
                    {!!customEffectRows?.length && [
                      <Divider key="custom-divider" />,
                      ...customEffectRows.map((c) => (
                        <MenuItem key={`custom:${c.id}`} value={`custom:${c.id}`}>
                          {c.name}
                        </MenuItem>
                      )),
                    ]}
                  </TextField>

                  <Stack direction="row" spacing={1}>
                    <TextField
                      select
                      size="small"
                      label="Blend"
                      value={selected.blend}
                      onChange={(e) => patchLayer(selected.id, { blend: e.target.value as BlendMode })}
                      sx={{ flex: 1 }}
                    >
                      {BLEND_MODES.map((b) => (
                        <MenuItem key={b.value} value={b.value}>
                          {b.label}
                        </MenuItem>
                      ))}
                    </TextField>
                  </Stack>

                  <Box>
                    <Stack direction="row" justifyContent="space-between">
                      <Typography variant="body2">Opacity</Typography>
                      <Typography variant="caption" color="text.secondary">
                        {Math.round(selected.opacity * 100)}%
                      </Typography>
                    </Stack>
                    <Box sx={{ px: 0.5 }}>
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.01}
                        value={selected.opacity}
                        onChange={(e) => patchLayer(selected.id, { opacity: Number(e.target.value) })}
                        style={{ width: '100%' }}
                      />
                    </Box>
                  </Box>

                  <Divider>
                    <Typography variant="caption" color="text.secondary">
                      Canvas region
                    </Typography>
                  </Divider>
                  <RegionEditor
                    rect={selected.rect ?? FULL_RECT}
                    onChange={(rect) => patchLayer(selected.id, { rect })}
                  />

                  <Divider>
                    <Typography variant="caption" color="text.secondary">
                      {selectedDef.name} settings
                    </Typography>
                  </Divider>

                  {selectedIsCustomEffect ? (
                    <Typography variant="caption" color="text.secondary">
                      This is a custom effect — its look is baked into its recipe. Edit it on the{' '}
                      <Link component={RouterLink} to="/effects">
                        Effects page
                      </Link>
                      .
                    </Typography>
                  ) : (
                    selectedDef.params.map((d) => (
                      <ParamControl
                        key={d.key}
                        def={d}
                        value={selected.params[d.key]}
                        onChange={(v) => patchLayer(selected.id, { params: { ...selected.params, [d.key]: v } })}
                      />
                    ))
                  )}

                  <Divider>
                    <Typography variant="caption" color="text.secondary">
                      Mask
                    </Typography>
                  </Divider>
                  <Stack direction="row" alignItems="center" justifyContent="space-between">
                    <Typography variant="body2">Use an effect as a mask</Typography>
                    <Switch
                      size="small"
                      checked={!!selected.mask}
                      onChange={(e) =>
                        patchLayer(selected.id, {
                          mask: e.target.checked ? { effectId: 'gradient', params: effectDefaults('gradient') } : null,
                        })
                      }
                    />
                  </Stack>
                  {selected.mask && (
                    <>
                      <TextField
                        select
                        size="small"
                        label="Mask effect"
                        value={selected.mask.effectId}
                        onChange={(e) =>
                          patchLayer(selected.id, {
                            mask: { effectId: e.target.value, params: effectDefaults(e.target.value), invert: selected.mask?.invert },
                          })
                        }
                      >
                        {listEffects().map((e) => (
                          <MenuItem key={`mask-${e.id}`} value={e.id}>
                            {e.name}
                          </MenuItem>
                        ))}
                        {!!customEffectRows?.length && [
                          <Divider key="mask-custom-divider" />,
                          ...customEffectRows.map((c) => (
                            <MenuItem key={`mask-custom:${c.id}`} value={`custom:${c.id}`}>
                              {c.name}
                            </MenuItem>
                          )),
                        ]}
                      </TextField>
                      <Stack direction="row" alignItems="center" justifyContent="space-between">
                        <Typography variant="body2">Invert mask</Typography>
                        <Switch
                          size="small"
                          checked={!!selected.mask.invert}
                          onChange={(e) =>
                            patchLayer(selected.id, { mask: { ...selected.mask!, invert: e.target.checked } })
                          }
                        />
                      </Stack>
                      {(getEffect(selected.mask.effectId)?.params ?? customEffects.get(selected.mask.effectId)?.params ?? []).map((d) => (
                        <ParamControl
                          key={d.key}
                          def={d}
                          value={selected.mask!.params[d.key]}
                          onChange={(v) =>
                            patchLayer(selected.id, {
                              mask: { ...selected.mask!, params: { ...selected.mask!.params, [d.key]: v } },
                            })
                          }
                        />
                      ))}
                    </>
                  )}
                </Stack>
              </CardContent>
            </Card>
          )}
        </Stack>
      </Box>

      <Dialog open={!!confirmLoad} onClose={() => setConfirmLoad(null)}>
        <DialogTitle>Stream output currently active</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Stream output currently active, sure you want to load a different scene? (This will stop
            the current stream output for the active scene.)
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button disabled={stopStream.isPending} onClick={() => setConfirmLoad(null)}>
            Cancel
          </Button>
          <Button
            variant="contained"
            color="error"
            disabled={stopStream.isPending}
            onClick={async () => {
              const target = confirmLoad?.id ?? null;
              stopSync();
              // Let any push already on the wire settle so it can't restart the
              // stream after we stop it, then stop & release, then load.
              for (let i = 0; i < 40 && push.current.inFlight; i++) {
                await new Promise((r) => setTimeout(r, 40));
              }
              try {
                await stopStream.mutateAsync();
              } catch {
                /* load anyway */
              }
              loadScene(target);
              setConfirmLoad(null);
            }}
          >
            {stopStream.isPending ? 'Stopping…' : 'Yes, I Understand'}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}

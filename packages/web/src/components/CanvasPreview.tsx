import { useEffect, useRef, useState } from 'react';
import { Box } from '@mui/material';
import {
  FULL_RECT,
  mapFixture,
  resolveMediaPositionMs,
  sampleScene,
  type Installation,
  type LayerRect,
  type MediaFrame,
  type MediaFrames,
  type Scene,
} from '@ewc/core';
import { floorplanUrl } from '../api/stage.js';
import { loadMediaFrame, mediaUrl } from '../api/media.js';
import { md3 } from '../theme/tokens.js';

interface Props {
  scene: Scene;
  installation?: Installation | null;
  playing?: boolean;
  showFixtures?: boolean;
  /** Overlay the installation's floorplan image (preview-only, 50% opacity). */
  showFloorplan?: boolean;
  resolution?: number;
  /** Enable the layer-region overlay (drag to move, corners to resize). */
  editable?: boolean;
  selectedLayerId?: string | null;
  onSelectLayer?: (id: string | null) => void;
  onLayerRect?: (id: string, rect: LayerRect) => void;
  /** Wall-clock ms to seed the animation clock from (the live stream's origin),
   *  so the preview stays phase-locked to the wire. Omit to free-run from mount. */
  epochMs?: number | null;
  /** Per-device RGB gain (white balance) applied to that device's fixture dots. */
  deviceGains?: Record<number, readonly [number, number, number]>;
}

type Corner = 'nw' | 'ne' | 'sw' | 'se';

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

function resizeRect(
  r: LayerRect,
  corner: Corner,
  dx: number,
  dy: number,
  aspect?: number,
): LayerRect {
  let { x, y, w, h } = r;
  const MIN = 0.03;
  if (corner === 'nw' || corner === 'sw') {
    const nx = clamp(x + dx, -0.5, x + w - MIN);
    w += x - nx;
    x = nx;
  }
  if (corner === 'ne' || corner === 'se') w = clamp(w + dx, MIN, 2.5);
  if (corner === 'nw' || corner === 'ne') {
    const ny = clamp(y + dy, -0.5, y + h - MIN);
    h += y - ny;
    y = ny;
  }
  if (corner === 'sw' || corner === 'se') h = clamp(h + dy, MIN, 2.5);

  // Aspect lock (media layers): drive height from width, keeping the corner
  // opposite the drag anchored.
  if (aspect && aspect > 0) {
    const nh = w / aspect;
    if (corner === 'nw' || corner === 'ne') y += h - nh; // bottom edge stays put
    h = nh;
  }
  return { x, y, w, h };
}

const clamp255 = (n: number) => (n < 0 ? 0 : n > 255 ? 255 : n) | 0;

/**
 * Draw the fixtures onto the crisp overlay: a neutral "housing" line following
 * each fixture's LED path, then the live per-LED colour on top — a continuous
 * lit segment for strips, a dot for a single point. Everything is at display
 * resolution so nothing smears.
 */
function drawFixtures(
  octx: CanvasRenderingContext2D,
  cw: number,
  ch: number,
  dpr: number,
  installation: Installation,
  scene: Scene,
  t: number,
  mediaFrames: MediaFrames | undefined,
  deviceGains: Record<number, readonly [number, number, number]> | undefined,
): void {
  octx.clearRect(0, 0, cw, ch);
  octx.lineCap = 'round';
  octx.lineJoin = 'round';

  const trace = (px: ReadonlyArray<readonly [number, number]>) => {
    octx.beginPath();
    octx.moveTo(px[0]![0], px[0]![1]);
    for (let i = 1; i < px.length; i++) octx.lineTo(px[i]![0], px[i]![1]);
  };

  for (const f of installation.fixtures) {
    if (!f.enabled) continue;
    const pts = mapFixture(f, installation.canvas);
    if (pts.length === 0) continue;

    const px = pts.map((p) => [p.x * cw, p.y * ch] as const);
    const g = deviceGains?.[f.deviceId];
    const colourAt = (i: number): string => {
      const c = sampleScene(scene, pts[i]!.x, pts[i]!.y, t, mediaFrames);
      return g
        ? `rgb(${clamp255(c[0] * g[0])},${clamp255(c[1] * g[1])},${clamp255(c[2] * g[2])})`
        : `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;
    };

    const single = px.length === 1;

    // Double outline so the fixture reads on ANY canvas colour (its lit colour
    // otherwise matches the canvas exactly): a dark casing under a light rim.
    if (single) {
      octx.beginPath();
      octx.arc(px[0]![0], px[0]![1], 3 * dpr, 0, Math.PI * 2);
    } else {
      trace(px);
    }
    octx.strokeStyle = 'rgba(0,0,0,0.55)';
    octx.lineWidth = 5 * dpr;
    octx.stroke();
    octx.strokeStyle = 'rgba(255,255,255,0.28)';
    octx.lineWidth = 3.2 * dpr;
    octx.stroke();

    // Lit core — the actual per-LED colour.
    if (single) {
      octx.beginPath();
      octx.arc(px[0]![0], px[0]![1], 2 * dpr, 0, Math.PI * 2);
      octx.fillStyle = colourAt(0);
      octx.fill();
      continue;
    }
    octx.lineWidth = 2 * dpr;
    for (let i = 0; i < px.length - 1; i++) {
      octx.beginPath();
      octx.moveTo(px[i]![0], px[i]![1]);
      octx.lineTo(px[i + 1]![0], px[i + 1]![1]);
      octx.strokeStyle = colourAt(i);
      octx.stroke();
    }
    octx.beginPath();
    octx.arc(px[px.length - 1]![0], px[px.length - 1]![1], 1 * dpr, 0, Math.PI * 2);
    octx.fillStyle = colourAt(px.length - 1);
    octx.fill();
  }
}

/**
 * Renders a {@link Scene} with the **same `sampleScene`** the DDP loop uses. When
 * `editable`, overlays a draggable / resizable box per layer so effects can be
 * scaled and positioned on parts of the canvas.
 */
export function CanvasPreview({
  scene,
  installation,
  playing = true,
  showFixtures = true,
  showFloorplan = false,
  resolution = 200,
  editable = false,
  selectedLayerId = null,
  onSelectLayer,
  onLayerRect,
  epochMs = null,
  deviceGains,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  /** Crisp, display-resolution overlay for the fixtures (the pixel canvas below
   *  is low-res and would smear thin lines when the browser upscales it). */
  const fixtureCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  // Still frames for the scene's IMAGE media layers, keyed by layer id.
  const [mediaImages, setMediaImages] = useState<Map<string, MediaFrame>>(() => new Map());
  const imageKey = scene.layers
    .map((l) => (l.media && l.media.kind !== 'video' ? `${l.id}:${l.media.assetId}` : ''))
    .join(',');
  useEffect(() => {
    const specs = scene.layers.flatMap((l) =>
      l.media && l.media.kind !== 'video' ? [[l.id, l.media.assetId] as const] : [],
    );
    if (specs.length === 0) {
      setMediaImages(new Map());
      return;
    }
    let cancelled = false;
    Promise.all(specs.map(async ([id, asset]) => [id, await loadMediaFrame(asset)] as const))
      .then((entries) => {
        if (!cancelled) setMediaImages(new Map(entries));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageKey]);

  // Playing <video> elements for VIDEO media layers, keyed by layer id. Kept in a
  // ref (not state) — the render loop samples them directly each frame.
  const videosRef = useRef<
    Map<string, { assetId: string; el: HTMLVideoElement; canvas: HTMLCanvasElement }>
  >(new Map());
  const videoKey = scene.layers
    .map((l) => (l.media?.kind === 'video' ? `${l.id}:${l.media.assetId}` : ''))
    .join(',');
  useEffect(() => {
    const want = new Map(
      scene.layers.flatMap((l) =>
        l.media?.kind === 'video' ? [[l.id, l.media.assetId] as const] : [],
      ),
    );
    const have = videosRef.current;
    // Drop layers that are gone or changed asset.
    for (const [id, v] of have) {
      if (want.get(id) !== v.assetId) {
        v.el.pause();
        v.el.removeAttribute('src');
        v.el.load();
        have.delete(id);
      }
    }
    // Add new ones.
    for (const [id, assetId] of want) {
      if (have.has(id)) continue;
      const el = document.createElement('video');
      // Marker: these live off-DOM, so `document.querySelector('video')` finds
      // only the inspector thumbnail — check `[data-ewc-sampler]` when debugging.
      el.dataset.ewcSampler = id;
      el.src = mediaUrl(assetId);
      el.crossOrigin = 'anonymous';
      el.muted = true;
      el.loop = true;
      el.playsInline = true;
      el.preload = 'auto';
      void el.play().catch(() => {});
      have.set(id, { assetId, el, canvas: document.createElement('canvas') });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoKey]);
  useEffect(
    () => () => {
      for (const v of videosRef.current.values()) {
        v.el.pause();
        v.el.removeAttribute('src');
        v.el.load();
      }
      videosRef.current.clear();
    },
    [],
  );

  const state = useRef({ scene, installation, playing, showFixtures, epochMs, deviceGains, mediaImages });
  state.current = { scene, installation, playing, showFixtures, epochMs, deviceGains, mediaImages };
  const drag = useRef<
    | { id: string; mode: 'move' | Corner; startRect: LayerRect; px: number; py: number }
    | null
  >(null);

  const aspect =
    installation && installation.canvas.height > 0
      ? installation.canvas.width / installation.canvas.height
      : 16 / 9;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const w = Math.max(16, Math.round(resolution));
    const h = Math.max(9, Math.round(w / aspect));
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const img = ctx.createImageData(w, h);

    // Fixture overlay: sized to its own on-screen box × devicePixelRatio so the
    // thin lines stay crisp regardless of how big the preview is rendered.
    const fixCanvas = fixtureCanvasRef.current;
    const fixCtx = fixCanvas?.getContext('2d') ?? null;
    let fixW = 0;
    let fixH = 0;
    const sizeFixture = () => {
      if (!fixCanvas) return;
      const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
      const rect = fixCanvas.getBoundingClientRect();
      fixW = Math.max(1, Math.round(rect.width * dpr));
      fixH = Math.max(1, Math.round(rect.height * dpr));
      if (fixCanvas.width !== fixW) fixCanvas.width = fixW;
      if (fixCanvas.height !== fixH) fixCanvas.height = fixH;
      return dpr;
    };
    let dpr = sizeFixture() ?? 1;
    const ro =
      fixCanvas && 'ResizeObserver' in window
        ? new ResizeObserver(() => {
            dpr = sizeFixture() ?? dpr;
          })
        : null;
    if (ro && fixCanvas) ro.observe(fixCanvas);

    let raf = 0;
    let start = performance.now();
    let stoppedAt = 0;

    const frame = (now: number) => {
      const s = state.current;
      if (!s.playing) {
        if (!stoppedAt) stoppedAt = now;
      } else if (stoppedAt) {
        start += now - stoppedAt;
        stoppedAt = 0;
      }
      // Phase-lock to the live stream when its clock origin is known; otherwise
      // free-run from mount.
      const t = !s.playing
        ? 0
        : s.epochMs != null
          ? (Date.now() - s.epochMs) / 1000
          : (now - start) / 1000;

      // Merge the current frame of every <video> layer over the still images.
      // The <video> element is driven by the same `resolveMediaPositionMs` the
      // wire uses (against `Date.now()`), so preview and wall agree.
      let mediaFrames = s.mediaImages;
      if (videosRef.current.size > 0) {
        mediaFrames = new Map(s.mediaImages);
        const nowMs = Date.now();
        for (const [layerId, v] of videosRef.current) {
          const vid = v.el;
          if (vid.readyState < 2 || !vid.videoWidth) continue;
          const media = s.scene.layers.find((l) => l.id === layerId)?.media;
          // Scenes saved before durationMs existed fall back to the element's
          // own metadata (reliable here — readyState >= 2).
          const durationMs =
            media?.durationMs || (Number.isFinite(vid.duration) ? vid.duration * 1000 : 0);
          const pos = media
            ? resolveMediaPositionMs(media, durationMs, nowMs)
            : (nowMs / 1000) % (vid.duration || 1) * 1000;

          if (pos == null) {
            // hidden right now (a stopped/ended 'hide' clip) — leave the layer
            // with no frame so it contributes nothing.
            if (!vid.paused) vid.pause();
            continue;
          }
          const wantSec = ((media?.trimInMs ?? 0) + pos) / 1000;
          const playing = (media?.playback?.state ?? (media?.playbackType === 'loop' ? 'playing' : 'stopped')) === 'playing';
          if (playing && vid.paused) void vid.play().catch(() => {});
          if (!playing && !vid.paused) vid.pause();
          // Correct drift; playing video advances on its own between corrections.
          if (Math.abs(vid.currentTime - wantSec) > (playing ? 0.12 : 0.03)) {
            try {
              vid.currentTime = wantSec;
            } catch {
              /* seek not ready yet */
            }
          }

          const vc = v.canvas;
          if (vc.width !== vid.videoWidth || vc.height !== vid.videoHeight) {
            vc.width = vid.videoWidth;
            vc.height = vid.videoHeight;
          }
          const vctx = vc.getContext('2d', { willReadFrequently: true });
          if (!vctx) continue;
          try {
            vctx.drawImage(vid, 0, 0, vc.width, vc.height);
            const id = vctx.getImageData(0, 0, vc.width, vc.height);
            const copy = new Uint8ClampedArray(id.data.length);
            copy.set(id.data);
            mediaFrames.set(layerId, { width: vc.width, height: vc.height, data: copy });
          } catch {
            /* frame not ready / tainted — skip this tick */
          }
        }
      }

      const data = img.data;
      for (let py = 0; py < h; py++) {
        for (let px = 0; px < w; px++) {
          const c = sampleScene(s.scene, (px + 0.5) / w, (py + 0.5) / h, t, mediaFrames);
          const o = (py * w + px) * 4;
          data[o] = c[0];
          data[o + 1] = c[1];
          data[o + 2] = c[2];
          data[o + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);

      // Fixtures: crisp, on their own display-resolution overlay. Each LED's
      // colour is the actual `sampleScene` value with the device's white balance
      // applied — the one place the preview can reflect a per-device correction.
      if (fixCtx) {
        if (s.showFixtures && s.installation && s.installation.fixtures.length > 0) {
          drawFixtures(fixCtx, fixW, fixH, dpr, s.installation, s.scene, t, mediaFrames, s.deviceGains);
        } else {
          fixCtx.clearRect(0, 0, fixW, fixH);
        }
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
    };
  }, [aspect, resolution]);

  const onPointerDown = (
    e: React.PointerEvent,
    id: string,
    mode: 'move' | Corner,
    rect: LayerRect,
  ) => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    onSelectLayer?.(id);
    drag.current = { id, mode, startRect: rect, px: e.clientX, py: e.clientY };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    const el = overlayRef.current;
    if (!d || !el || !onLayerRect) return;
    const box = el.getBoundingClientRect();
    const dx = (e.clientX - d.px) / box.width;
    const dy = (e.clientY - d.py) / box.height;
    if (d.mode === 'move') {
      onLayerRect(d.id, {
        ...d.startRect,
        x: clamp(d.startRect.x + dx, -0.5, 1.5 - d.startRect.w),
        y: clamp(d.startRect.y + dy, -0.5, 1.5 - d.startRect.h),
      });
    } else {
      onLayerRect(d.id, resizeRect(d.startRect, d.mode, dx, dy, mediaAspect(d.id)));
    }
  };

  /** Locked rect w/h ratio for a media layer (native ratio ÷ canvas ratio), else undefined. */
  const mediaAspect = (layerId: string): number | undefined => {
    const m = scene.layers.find((l) => l.id === layerId)?.media;
    if (!m) return undefined;
    return (m.naturalWidth / m.naturalHeight) / aspect;
  };

  const endDrag = () => {
    drag.current = null;
  };

  return (
    <Box
      sx={{
        position: 'relative',
        width: '100%',
        aspectRatio: String(aspect),
        borderRadius: 2,
        overflow: 'hidden',
        border: `1px solid ${md3.outlineVariant}`,
        bgcolor: '#000',
      }}
    >
      <Box
        component="canvas"
        ref={canvasRef}
        sx={{ width: '100%', height: '100%', display: 'block' }}
      />

      {showFloorplan && installation?.floorplan && (() => {
        const fp = installation.floorplan;
        const { width: cw, height: ch } = installation.canvas;
        return (
          <Box
            component="img"
            src={floorplanUrl(fp)}
            alt=""
            sx={{
              position: 'absolute',
              left: `${((fp.position.x - fp.size.x / 2) / cw) * 100}%`,
              top: `${((fp.position.y - fp.size.y / 2) / ch) * 100}%`,
              width: `${(fp.size.x / cw) * 100}%`,
              height: `${(fp.size.y / ch) * 100}%`,
              opacity: 0.5,
              objectFit: 'fill',
              pointerEvents: 'none',
            }}
          />
        );
      })()}

      <Box
        component="canvas"
        ref={fixtureCanvasRef}
        sx={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          pointerEvents: 'none',
        }}
      />

      {showFixtures && installation && installation.fixtures.length > 0 && (
        <Box sx={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
          {installation.fixtures.map((f) => {
            if (!f.enabled) return null;
            const leds = mapFixture(f, installation.canvas);
            if (leds.length === 0) return null;
            let minX = 1;
            let maxX = 0;
            let maxY = 0;
            for (const p of leds) {
              if (p.x < minX) minX = p.x;
              if (p.x > maxX) maxX = p.x;
              if (p.y > maxY) maxY = p.y;
            }
            return (
              <Box
                key={f.id}
                sx={{
                  position: 'absolute',
                  left: `${((minX + maxX) / 2) * 100}%`,
                  top: `${maxY * 100}%`,
                  transform: 'translate(-50%, 3px)',
                  fontSize: 9,
                  lineHeight: 1,
                  fontWeight: 600,
                  color: '#fff',
                  textShadow: '0 0 3px rgba(0,0,0,0.95), 0 0 3px rgba(0,0,0,0.95)',
                  whiteSpace: 'nowrap',
                }}
              >
                {f.name}
              </Box>
            );
          })}
        </Box>
      )}

      {editable && (
        <Box
          ref={overlayRef}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerLeave={endDrag}
          onPointerDown={() => onSelectLayer?.(null)}
          sx={{ position: 'absolute', inset: 0, touchAction: 'none' }}
        >
          {scene.layers.map((l) => {
            if (!l.enabled) return null;
            const r = l.rect ?? FULL_RECT;
            const sel = l.id === selectedLayerId;
            const isFull = r.x <= 0 && r.y <= 0 && r.w >= 1 && r.h >= 1;
            if (isFull && !sel) return null; // don't clutter with full-canvas outlines
            return (
              <Box
                key={l.id}
                onPointerDown={(e) => onPointerDown(e, l.id, 'move', r)}
                sx={{
                  position: 'absolute',
                  left: `${r.x * 100}%`,
                  top: `${r.y * 100}%`,
                  width: `${r.w * 100}%`,
                  height: `${r.h * 100}%`,
                  border: `1.5px ${sel ? 'solid' : 'dashed'} ${sel ? md3.primary : 'rgba(255,255,255,0.5)'}`,
                  boxShadow: sel ? `0 0 0 1px rgba(0,0,0,0.6)` : 'none',
                  cursor: sel ? 'move' : 'pointer',
                }}
              >
                {sel &&
                  (['nw', 'ne', 'sw', 'se'] as Corner[]).map((c) => (
                    <Box
                      key={c}
                      onPointerDown={(e) => onPointerDown(e, l.id, c, r)}
                      sx={{
                        position: 'absolute',
                        width: 12,
                        height: 12,
                        bgcolor: md3.primary,
                        border: '1px solid #000',
                        borderRadius: '2px',
                        top: c[0] === 'n' ? -6 : undefined,
                        bottom: c[0] === 's' ? -6 : undefined,
                        left: c[1] === 'w' ? -6 : undefined,
                        right: c[1] === 'e' ? -6 : undefined,
                        cursor: `${c}-resize`,
                      }}
                    />
                  ))}
              </Box>
            );
          })}
        </Box>
      )}
    </Box>
  );
}

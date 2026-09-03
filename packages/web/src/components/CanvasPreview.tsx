import { useEffect, useRef, useState } from 'react';
import { Box } from '@mui/material';
import {
  FULL_RECT,
  mapFixture,
  mapInstallation,
  sampleScene,
  type Installation,
  type LayerRect,
  type MediaFrame,
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

      // Merge the current frame of every playing <video> layer over the still
      // images. Sampled from the same transcoded clip the wire decodes.
      let mediaFrames = s.mediaImages;
      if (videosRef.current.size > 0) {
        mediaFrames = new Map(s.mediaImages);
        for (const [layerId, v] of videosRef.current) {
          const vid = v.el;
          if (vid.readyState < 2 || !vid.videoWidth) continue;
          // Nudge toward the wall clock when streaming, without constant seeking.
          if (s.playing && s.epochMs != null && vid.duration > 0) {
            const wanted = ((Date.now() - s.epochMs) / 1000) % vid.duration;
            if (Math.abs(vid.currentTime - wanted) > 0.15) vid.currentTime = wanted;
          }
          if (vid.paused && s.playing) void vid.play().catch(() => {});
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

      if (s.showFixtures && s.installation) {
        // Fixture dots show the actual sampled colour, with each device's white
        // balance applied — the one place the preview can reflect a per-device
        // correction (the shared canvas can't carry three white points).
        for (const led of mapInstallation(s.installation)) {
          const c = sampleScene(s.scene, led.x, led.y, t, mediaFrames);
          const g = s.deviceGains?.[led.deviceId];
          const r = g ? c[0] * g[0] : c[0];
          const gr = g ? c[1] * g[1] : c[1];
          const b = g ? c[2] * g[2] : c[2];
          const px = led.x * w;
          const py = led.y * h;
          ctx.fillStyle = 'rgba(0,0,0,0.55)';
          ctx.fillRect(px - 1.6, py - 1.6, 3.2, 3.2);
          ctx.fillStyle = `rgb(${r | 0},${gr | 0},${b | 0})`;
          ctx.fillRect(px - 1, py - 1, 2, 2);
        }
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
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

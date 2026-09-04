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
  /**
   * "As-output" view: black out the canvas (all FX / media layers hidden) and
   * show only the fixtures, each LED lit with its actual current colour. The
   * stream is unaffected — this is a preview-only view mode.
   */
  showOutputOnly?: boolean;
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
  /** "As-output" view — canvas is black, so lean into the lit core + a glow. */
  outputMode = false,
): void {
  octx.clearRect(0, 0, cw, ch);
  octx.lineCap = 'round';
  octx.lineJoin = 'round';
  const coreW = (outputMode ? 3.2 : 2) * dpr;

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
    const cols = pts.map((p) => {
      const c = sampleScene(scene, p.x, p.y, t, mediaFrames);
      return g
        ? `rgb(${clamp255(c[0] * g[0])},${clamp255(c[1] * g[1])},${clamp255(c[2] * g[2])})`
        : `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;
    });
    const colourAt = (i: number) => cols[i]!;

    const single = px.length === 1;

    // Double outline so the fixture reads on ANY canvas colour (its lit colour
    // otherwise matches the canvas exactly): a dark casing under a light rim.
    if (single) {
      octx.beginPath();
      octx.arc(px[0]![0], px[0]![1], 3 * dpr, 0, Math.PI * 2);
    } else {
      trace(px);
    }
    octx.strokeStyle = outputMode ? 'rgba(0,0,0,0.9)' : 'rgba(0,0,0,0.55)';
    octx.lineWidth = 5 * dpr;
    octx.stroke();
    octx.strokeStyle = outputMode ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.28)';
    octx.lineWidth = 3.2 * dpr;
    octx.stroke();

    if (single) {
      const col = colourAt(0);
      if (outputMode) {
        octx.globalAlpha = 0.28;
        octx.beginPath();
        octx.arc(px[0]![0], px[0]![1], 5 * dpr, 0, Math.PI * 2);
        octx.fillStyle = col;
        octx.fill();
        octx.globalAlpha = 1;
      }
      octx.beginPath();
      octx.arc(px[0]![0], px[0]![1], (outputMode ? 2.6 : 2) * dpr, 0, Math.PI * 2);
      octx.fillStyle = col;
      octx.fill();
      continue;
    }

    // Lit core — the actual per-LED colour. In output mode a cheap wide,
    // low-alpha pass under it fakes a bloom (no per-segment canvas shadows).
    const drawCore = (widthPx: number, alpha: number) => {
      octx.globalAlpha = alpha;
      octx.lineWidth = widthPx;
      for (let i = 0; i < px.length - 1; i++) {
        octx.beginPath();
        octx.moveTo(px[i]![0], px[i]![1]);
        octx.lineTo(px[i + 1]![0], px[i + 1]![1]);
        octx.strokeStyle = colourAt(i);
        octx.stroke();
      }
      octx.globalAlpha = 1;
    };
    if (outputMode) drawCore(coreW * 2.6, 0.22);
    drawCore(coreW, 1);

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
  showOutputOnly = false,
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

  // Still frames for the scene's IMAGE and TEXT layers, keyed by layer id. A text
  // layer's string is rasterised + uploaded by its inspector, so here it's just
  // another image asset to fetch.
  const [mediaImages, setMediaImages] = useState<Map<string, MediaFrame>>(() => new Map());
  const frameAssetOf = (l: (typeof scene.layers)[number]): string | null =>
    l.media && l.media.kind !== 'video'
      ? l.media.assetId
      : l.text && l.text.assetId
        ? l.text.assetId
        : null;
  const imageKey = scene.layers
    .map((l) => {
      const a = frameAssetOf(l);
      return a ? `${l.id}:${a}` : '';
    })
    .join(',');
  useEffect(() => {
    const specs = scene.layers.flatMap((l) => {
      const a = frameAssetOf(l);
      return a ? [[l.id, a] as const] : [];
    });
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

  const state = useRef({
    scene,
    installation,
    playing,
    showFixtures,
    showOutputOnly,
    epochMs,
    deviceGains,
    mediaImages,
  });
  state.current = {
    scene,
    installation,
    playing,
    showFixtures,
    showOutputOnly,
    epochMs,
    deviceGains,
    mediaImages,
  };
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
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // The pixel canvas is rendered near its on-screen size (× dpr, capped) so the
    // browser barely has to scale it — a fixed low resolution stretched to the
    // preview box is what made everything look soft. `sampleScene` runs per
    // pixel, though, so a heavy layer stack can't afford an unbounded canvas:
    // an EMA of the per-frame sample cost walks the resolution back down when a
    // scene is expensive and back up when it's cheap.
    const RES_MIN = 200;
    const RES_MAX = 480;
    const dprNow = () => Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    const boxTargetW = () =>
      Math.round((canvas.getBoundingClientRect().width || RES_MIN) * dprNow());
    let w = Math.max(16, Math.min(RES_MAX, Math.max(RES_MIN, boxTargetW())));
    let h = Math.max(9, Math.round(w / aspect));
    canvas.width = w;
    canvas.height = h;
    let img = ctx.createImageData(w, h);
    const applyRes = (next: number) => {
      const nw = Math.max(RES_MIN, Math.min(RES_MAX, Math.round(next)));
      const nh = Math.max(9, Math.round(nw / aspect));
      if (nw === w && nh === h) return;
      w = nw;
      h = nh;
      canvas.width = w;
      canvas.height = h;
      img = ctx.createImageData(w, h);
    };
    let sampleEma = 0;
    let adaptTick = 0;

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

      // Revisit the render resolution ~twice a second. The box-size track runs in
      // every mode (output mode skips the sample loop, so its perf-driven branch
      // never fires); the perf back-off / grow only makes sense once we've timed
      // an actual sample loop this tick.
      const adapt = ++adaptTick % 30 === 0;
      const resTarget = Math.max(RES_MIN, Math.min(RES_MAX, boxTargetW()));
      if (adapt && w > resTarget * 1.15) applyRes(resTarget);

      if (s.showOutputOnly) {
        // "As-output" view — black canvas, only the fixtures are lit. The scene
        // still streams; the fixture overlay below samples the real scene.
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, w, h);
      } else {
        const t0 = performance.now();
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

        const dt = performance.now() - t0;
        sampleEma = sampleEma ? sampleEma * 0.8 + dt * 0.2 : dt;
        if (adapt) {
          if (sampleEma > 24 && w > RES_MIN) applyRes(w * 0.85);
          else if (sampleEma < 12 && w < resTarget) applyRes(Math.min(w * 1.15, resTarget));
        }
      }

      // Fixtures: crisp, on their own display-resolution overlay. Each LED's
      // colour is the actual `sampleScene` value with the device's white balance
      // applied — the one place the preview can reflect a per-device correction.
      if (fixCtx) {
        if (s.showFixtures && s.installation && s.installation.fixtures.length > 0) {
          drawFixtures(
            fixCtx,
            fixW,
            fixH,
            dpr,
            s.installation,
            s.scene,
            t,
            mediaFrames,
            s.deviceGains,
            s.showOutputOnly,
          );
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
  }, [aspect]);

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
    const l = scene.layers.find((x) => x.id === layerId);
    const m = l?.media ?? l?.text ?? null;
    if (!m || !m.naturalWidth || !m.naturalHeight) return undefined;
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
        sx={{
          width: '100%',
          height: '100%',
          display: 'block',
          // The canvas backing store is rendered near its on-screen size; keep
          // whatever residual upscale remains hard-edged so a swept line stays a
          // clean one-pixel edge instead of a soft two-pixel gradient.
          imageRendering: 'pixelated',
        }}
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

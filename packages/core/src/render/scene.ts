/**
 * A **scene** is an ordered layer stack. Each layer is one effect plus a blend
 * mode, an opacity and an optional mask (another effect whose luma multiplies the
 * layer's alpha). `sampleScene` evaluates the stack bottom → top for one canvas
 * point and returns a solid RGB.
 *
 * Scenes serialise straight to JSON — that's how they persist in SQLite and how
 * the browser ships one to the stream. Effect ids inside a layer are the persisted
 * contract; an unknown id is skipped (with a one-time console warning) so a single
 * stale row can't take down the 40 Hz loop.
 */

import { blend, type BlendMode } from './blend.js';
import { clamp8, luma } from './color.js';
import { getEffect } from './registry.js';
import { withParamDefaults, type ParamValues, type RGB, type RGBA } from './types.js';

export interface LayerMask {
  effectId: string;
  params: ParamValues;
  /** Invert the mask (bright → hidden). */
  invert?: boolean;
}

/**
 * How a **video** media layer plays (milestone 8c).
 * - `loop`  — restart from the trim-in point every time playback reaches trim-out.
 * - `hold`  — play once, then freeze on the trim-out frame.
 * - `hide`  — play once, then the layer contributes nothing (layers below show).
 */
export type MediaPlaybackType = 'loop' | 'hold' | 'hide';

/**
 * Transport state for a video media layer. **Transient** — it is stripped when a
 * scene is persisted (it lives only on the wire / in the editor, like a console
 * fader), and reconstructed from {@link MediaLayerSpec.playbackType} on load.
 *
 * `anchorMs` / `headMs` are a wall-clock parametrisation: at wall time
 * `anchorMs` the clip was at `headMs` (ms from trim-in), and while `playing` it
 * advances in real time from there. Same-host clocks make preview and wire
 * agree exactly (the effect phase-lock makes the same assumption).
 */
export interface MediaPlayback {
  state: 'playing' | 'paused' | 'stopped';
  anchorMs: number;
  headMs: number;
}

/**
 * A **media layer** shows an uploaded image (milestone 8a) or video (8b/8c) on
 * the canvas. The pixels are supplied at render time by a {@link MediaFrames}
 * provider keyed by layer id — the browser fills it from a decoded `<img>` or a
 * `<video>`, the server from the stored blob — so `@ewc/core` never decodes
 * anything.
 */
export interface MediaLayerSpec {
  /** Server asset id for the decoded, downscaled RGBA blob (image) or mp4 (video). */
  assetId: string;
  /** Original upload name, shown in the inspector. */
  filename: string;
  /**
   * `'video'` assets are a downscaled, no-audio clip; `'image'` (the default
   * when absent) is a single still frame.
   */
  kind?: 'image' | 'video';
  /**
   * Native pixel size of the **original** source — the region editor locks to
   * this ratio, so it matches what the user sees in their own image/video
   * player. The stored (downscaled) size lives in the server asset meta only.
   */
  naturalWidth: number;
  naturalHeight: number;

  // --- video only (8b/8c) --------------------------------------------------
  /** Full clip length (ms) — denormalised from the asset so the trim UI has a range. */
  durationMs?: number;
  /** Playback starts here (ms into the clip). Absent = 0. */
  trimInMs?: number;
  /** Playback ends here (ms into the clip). Absent = clip end. */
  trimOutMs?: number;
  /** What happens at the trim-out point. Absent = `'loop'`. */
  playbackType?: MediaPlaybackType;
  /** Transient transport state — see {@link MediaPlayback}. */
  playback?: MediaPlayback | null;
}

const clampNum = (n: number, lo: number, hi: number) => (n < lo ? lo : n > hi ? hi : n);

/** Effective transport state for a video layer when its `playback` is absent. */
export function defaultMediaPlayback(
  playbackType: MediaPlaybackType | undefined,
  nowMs: number,
): MediaPlayback {
  return {
    state: (playbackType ?? 'loop') === 'loop' ? 'playing' : 'stopped',
    anchorMs: nowMs,
    headMs: 0,
  };
}

/**
 * Position within the **trimmed window** (ms from trim-in) for a video layer at
 * wall time `nowMs`, or `null` when the layer should contribute nothing right
 * now (a `hide`-type clip that is stopped or has run past its end).
 */
export function resolveMediaPositionMs(
  spec: Pick<MediaLayerSpec, 'trimInMs' | 'trimOutMs' | 'playbackType' | 'playback'>,
  durationMs: number,
  nowMs: number,
): number | null {
  const dur = Math.max(0, durationMs || 0);
  const trimIn = clampNum(spec.trimInMs ?? 0, 0, dur);
  const trimOut = clampNum(spec.trimOutMs ?? dur, trimIn, dur);
  const win = trimOut - trimIn;
  const type = spec.playbackType ?? 'loop';
  const pb = spec.playback ?? defaultMediaPlayback(type, nowMs);

  if (pb.state === 'stopped') return type === 'hide' ? null : 0;
  if (win <= 0) return 0;

  let pos = pb.state === 'playing' ? pb.headMs + (nowMs - pb.anchorMs) : pb.headMs;
  if (!Number.isFinite(pos) || pos < 0) pos = 0;

  if (pos >= win) {
    if (type === 'loop') pos %= win;
    else return type === 'hide' ? null : win; // hold the last frame
  }
  return pos;
}

/**
 * Decoded-clip frame index for a video layer at wall time `nowMs`, or `null` to
 * hide the layer. `timing` comes from the **asset** (authoritative), not the
 * layer spec.
 */
export function resolveMediaFrameIndex(
  spec: Pick<MediaLayerSpec, 'trimInMs' | 'trimOutMs' | 'playbackType' | 'playback'>,
  timing: { fps: number; frameCount: number; durationMs: number },
  nowMs: number,
): number | null {
  const pos = resolveMediaPositionMs(spec, timing.durationMs, nowMs);
  if (pos == null) return null;
  const clipMs = (spec.trimInMs ?? 0) + pos;
  const idx = Math.floor((clipMs / 1000) * timing.fps);
  return clampNum(idx, 0, Math.max(0, timing.frameCount - 1));
}

/**
 * Longest edge (px) a media frame is downscaled to before upload. Fixtures are
 * sparse — Frank's largest run is 150 LEDs in a line — so 256 is already far
 * more than the wire can resolve, and it keeps a stored RGBA blob ≤ 256 KB. To
 * change an image's resolution, re-upload it.
 */
export const MEDIA_MAX_EDGE = 256;

/** One decoded frame: tightly packed RGBA, row-major, `width * height * 4` bytes. */
export interface MediaFrame {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** Resolves a media layer's current frame by layer id. A plain Map is ideal. */
export type MediaFrames = { get(layerId: string): MediaFrame | undefined };

/** Nearest-neighbour sample of a frame at normalised (u,v), both 0..1. Returns RGBA (a 0..1). */
export function sampleMediaFrame(frame: MediaFrame, u: number, v: number): RGBA {
  const px = Math.min(frame.width - 1, Math.max(0, (u * frame.width) | 0));
  const py = Math.min(frame.height - 1, Math.max(0, (v * frame.height) | 0));
  const o = (py * frame.width + px) * 4;
  const d = frame.data;
  return [d[o] ?? 0, d[o + 1] ?? 0, d[o + 2] ?? 0, (d[o + 3] ?? 255) / 255];
}

/**
 * A layer's rectangle on the canvas, in normalised [0,1] coords (may extend
 * outside for an overhang). The effect renders **scaled to fill this box** — a
 * point outside contributes nothing, so layers on different parts of the canvas
 * run independently and only blend where their boxes overlap.
 */
export interface LayerRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const FULL_RECT: LayerRect = { x: 0, y: 0, w: 1, h: 1 };

export interface Layer {
  /** Stable within a scene; used as the React key and for reordering. */
  id: string;
  /** User label. Empty / absent → the UI falls back to the effect's name. */
  name?: string;
  /** The effect this layer renders. Empty string for a media layer. */
  effectId: string;
  params: ParamValues;
  blend: BlendMode;
  /** 0..1 */
  opacity: number;
  enabled: boolean;
  /** Canvas region the effect / media fills. Absent = full canvas (back-compat). */
  rect?: LayerRect;
  mask?: LayerMask | null;
  /** Set on a **media layer** — the layer shows this image instead of an effect. */
  media?: MediaLayerSpec | null;
}

export interface Scene {
  name: string;
  /** Bottom colour the stack composites over. */
  background: RGB;
  layers: Layer[];
}

export const EMPTY_SCENE: Scene = {
  name: 'Untitled scene',
  background: [0, 0, 0],
  layers: [],
};

/**
 * Effect ids in the scene that this build doesn't know — those layers are
 * skipped by {@link sampleScene}. Call at stream start / on save to surface the
 * problem instead of silently dropping layers in the 40 Hz loop.
 */
export function unknownEffectIds(scene: Scene): string[] {
  const out = new Set<string>();
  for (const l of scene.layers) {
    if (l.media || !l.effectId) continue; // media layers (and empty ids) don't use an effect
    if (!getEffect(l.effectId)) out.add(l.effectId);
    if (l.mask && !getEffect(l.mask.effectId)) out.add(l.mask.effectId);
  }
  return [...out];
}

/**
 * Composite one canvas point. x,y in [0,1] (y down), t in seconds. `mediaFrames`
 * supplies the current frame for any media layer (by layer id); omit it and
 * media layers contribute nothing.
 */
export function sampleScene(
  scene: Scene,
  x: number,
  y: number,
  t: number,
  mediaFrames?: MediaFrames,
): RGB {
  let dst: RGB = [
    clamp8(scene.background[0]),
    clamp8(scene.background[1]),
    clamp8(scene.background[2]),
  ];

  for (const layer of scene.layers) {
    if (!layer.enabled || layer.opacity <= 0) continue;

    const def = layer.media ? undefined : getEffect(layer.effectId);
    if (!layer.media && !def) continue; // unknown effect — see unknownEffectIds()

    // Map the canvas point into this layer's box; skip if it falls outside.
    const r = layer.rect;
    let lx = x;
    let ly = y;
    if (r) {
      if (r.w <= 0 || r.h <= 0) continue;
      lx = (x - r.x) / r.w;
      ly = (y - r.y) / r.h;
      if (lx < 0 || lx > 1 || ly < 0 || ly > 1) continue;
    }

    let src: RGBA;
    if (layer.media) {
      const frame = mediaFrames?.get(layer.id);
      if (!frame || frame.width <= 0 || frame.height <= 0) continue;
      src = sampleMediaFrame(frame, lx, ly);
    } else {
      src = def!.render(lx, ly, t, withParamDefaults(def!, layer.params));
    }

    let a = src[3] * layer.opacity;
    if (a <= 0) continue;

    if (layer.mask) {
      const maskDef = getEffect(layer.mask.effectId);
      if (maskDef) {
        const mc = maskDef.render(lx, ly, t, withParamDefaults(maskDef, layer.mask.params));
        let m = (luma([mc[0], mc[1], mc[2]]) / 255) * mc[3];
        if (layer.mask.invert) m = 1 - m;
        a *= m;
      }
    }

    if (a <= 0) continue;
    dst = blend(dst, [src[0], src[1], src[2], a > 1 ? 1 : a], layer.blend);
  }

  return dst;
}

/** A fresh layer for `effectId` with all defaults filled in. */
export function makeLayer(id: string, effectId: string): Layer {
  const def = getEffect(effectId);
  return {
    id,
    effectId,
    params: def ? withParamDefaults(def, undefined) : {},
    blend: 'normal',
    opacity: 1,
    enabled: true,
    rect: { ...FULL_RECT },
    mask: null,
  };
}

/** A fresh, empty media layer — `media` is filled in once an image is uploaded. */
export function makeMediaLayer(id: string): Layer {
  return {
    id,
    effectId: '',
    params: {},
    blend: 'normal',
    opacity: 1,
    enabled: true,
    rect: { ...FULL_RECT },
    mask: null,
    media: null,
  };
}

/**
 * A {@link LayerRect} centred on the canvas that renders `natW × natH` at its
 * true aspect ratio (accounting for the canvas's own aspect) and fits inside it.
 */
export function fitMediaRect(
  natW: number,
  natH: number,
  canvas: { width: number; height: number },
): LayerRect {
  const imgAR = natW > 0 && natH > 0 ? natW / natH : 1;
  const canvasAR = canvas.width > 0 && canvas.height > 0 ? canvas.width / canvas.height : 1;
  // rect w/h ratio needed so the image shows at imgAR on screen
  const ratio = imgAR / canvasAR;
  let w = 1;
  let h = 1;
  if (ratio >= 1) h = 1 / ratio;
  else w = ratio;
  return { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
}

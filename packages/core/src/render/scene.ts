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
import { withParamDefaults, type ParamValues, type RGB } from './types.js';

export interface LayerMask {
  effectId: string;
  params: ParamValues;
  /** Invert the mask (bright → hidden). */
  invert?: boolean;
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
  effectId: string;
  params: ParamValues;
  blend: BlendMode;
  /** 0..1 */
  opacity: number;
  enabled: boolean;
  /** Canvas region the effect fills. Absent = full canvas (back-compat). */
  rect?: LayerRect;
  mask?: LayerMask | null;
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
    if (!getEffect(l.effectId)) out.add(l.effectId);
    if (l.mask && !getEffect(l.mask.effectId)) out.add(l.mask.effectId);
  }
  return [...out];
}

/** Composite one canvas point. x,y in [0,1] (y down), t in seconds. */
export function sampleScene(scene: Scene, x: number, y: number, t: number): RGB {
  let dst: RGB = [
    clamp8(scene.background[0]),
    clamp8(scene.background[1]),
    clamp8(scene.background[2]),
  ];

  for (const layer of scene.layers) {
    if (!layer.enabled || layer.opacity <= 0) continue;
    const def = getEffect(layer.effectId);
    if (!def) continue; // unknown effect — see unknownEffectIds()

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

    const params = withParamDefaults(def, layer.params);
    const src = def.render(lx, ly, t, params);

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

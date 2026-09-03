/** Small colour helpers shared by the effects and the compositor. */

import type { RGB } from './types.js';

export function clamp8(n: number): number {
  if (Number.isNaN(n)) return 0;
  return n < 0 ? 0 : n > 255 ? 255 : Math.round(n);
}

export function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function mix(a: RGB, b: RGB, t: number): RGB {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

/** Rec. 709 luma, 0..255. Used for effect-as-mask. */
export function luma(c: RGB): number {
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

/** h in [0,1) (wraps), s,v in [0,1]. Returns 0..255 RGB. */
export function hsv(h: number, s: number, v: number): RGB {
  h = ((h % 1) + 1) % 1;
  s = clamp01(s);
  v = clamp01(v);
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const u = v * (1 - (1 - f) * s);
  let r = 0;
  let g = 0;
  let b = 0;
  switch (i % 6) {
    case 0: r = v; g = u; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = u; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = u; g = p; b = v; break;
    case 5: r = v; g = p; b = q; break;
  }
  return [r * 255, g * 255, b * 255];
}

/**
 * Sample a small colour ramp at t in [0,1]. `stops` are `[position, color]`
 * pairs, position 0..1, assumed sorted. Used by fire / plasma.
 */
export function ramp(stops: Array<[number, RGB]>, t: number): RGB {
  t = clamp01(t);
  if (t <= stops[0]![0]) return stops[0]![1];
  const last = stops[stops.length - 1]!;
  if (t >= last[0]) return last[1];
  for (let i = 1; i < stops.length; i++) {
    const [p1, c1] = stops[i]!;
    if (t <= p1) {
      const [p0, c0] = stops[i - 1]!;
      const k = p1 === p0 ? 0 : (t - p0) / (p1 - p0);
      return mix(c0, c1, k);
    }
  }
  return last[1];
}

/** Rotate a normalised (x,y) around (0.5,0.5) by `deg`, return the new x used as a 1-D axis. */
export function axisCoord(x: number, y: number, deg: number): number {
  const rad = (deg * Math.PI) / 180;
  const dx = x - 0.5;
  const dy = y - 0.5;
  return 0.5 + dx * Math.cos(rad) + dy * Math.sin(rad);
}

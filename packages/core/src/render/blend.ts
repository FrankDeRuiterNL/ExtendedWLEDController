/** Layer blend modes for the scene compositor. */

import { clamp8 } from './color.js';
import type { RGB, RGBA } from './types.js';

export type BlendMode = 'normal' | 'add' | 'screen' | 'multiply' | 'lighten';

export const BLEND_MODES: Array<{ value: BlendMode; label: string }> = [
  { value: 'normal', label: 'Normal' },
  { value: 'add', label: 'Add' },
  { value: 'screen', label: 'Screen' },
  { value: 'multiply', label: 'Multiply' },
  { value: 'lighten', label: 'Lighten' },
];

/**
 * Composite `src` (rgb 0..255, alpha 0..1) over `dst` (rgb 0..255). The blend
 * mode picks how the source colour combines; alpha then cross-fades that result
 * back toward `dst`. Returns a fresh clamped RGB.
 */
export function blend(dst: RGB, src: RGBA, mode: BlendMode): RGB {
  const a = src[3] <= 0 ? 0 : src[3] >= 1 ? 1 : src[3];
  if (a === 0) return [dst[0], dst[1], dst[2]];

  const out: RGB = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const d = dst[i]!;
    const s = src[i]!;
    let blended: number;
    switch (mode) {
      case 'add':
        blended = d + s;
        break;
      case 'screen':
        blended = 255 - ((255 - d) * (255 - s)) / 255;
        break;
      case 'multiply':
        blended = (d * s) / 255;
        break;
      case 'lighten':
        blended = Math.max(d, s);
        break;
      case 'normal':
      default:
        blended = s;
        break;
    }
    out[i] = clamp8(d + (blended - d) * a);
  }
  return out;
}

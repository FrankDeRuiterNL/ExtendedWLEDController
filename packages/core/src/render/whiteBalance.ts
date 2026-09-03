/**
 * Per-device white-balance correction for RGB strips with **no white channel**.
 *
 * A colour temperature (Kelvin) maps to a set of per-channel gains ≤ 1. The
 * realtime sender multiplies every outgoing pixel by that device's gains after
 * the canvas is sampled and before the frame is packed, so a nominal "white" on
 * the canvas lands as the chosen white point on the wall. The Studio preview
 * applies the same gains to the fixture dots.
 *
 * Devices with a real white channel (RGBW / RGBW+CCT) do white in hardware via
 * `seg.cct` — this correction is not for them.
 *
 * `kelvinToRgbGain(6500)` is **exactly `[1, 1, 1]`** (identity): 6500 K is the
 * neutral reference and the curve is normalised against it, so the documented
 * "neutral" really is a no-op.
 */

import type { RGB } from './types.js';

/** Slider bounds the UI offers (the spec's warm→cool range). */
export const WHITE_BALANCE_MIN_K = 2000;
export const WHITE_BALANCE_MAX_K = 10000;
/** The neutral reference — `kelvinToRgbGain` returns `[1,1,1]` here. */
export const WHITE_BALANCE_NEUTRAL_K = 6500;

/** Hard clamp before the approximation (it degenerates outside this range). */
const K_MIN = 1000;
const K_MAX = 40000;

/**
 * Blackbody RGB (0..255) via Tanner Helland's piecewise fit. Not colour-accurate
 * science, but the standard approximation and plenty good for tinting LEDs.
 */
function blackbodyRgb(kelvin: number): RGB {
  const k = Number.isFinite(kelvin) ? kelvin : WHITE_BALANCE_NEUTRAL_K;
  const t = clamp(k, K_MIN, K_MAX) / 100;

  let r: number;
  let g: number;
  let b: number;

  if (t <= 66) {
    r = 255;
    g = clamp8(99.4708025861 * Math.log(t) - 161.1195681661);
  } else {
    r = clamp8(329.698727446 * Math.pow(t - 60, -0.1332047592));
    g = clamp8(288.1221695283 * Math.pow(t - 60, -0.0755148492));
  }

  if (t >= 66) b = 255;
  else if (t <= 19) b = 0;
  else b = clamp8(138.5177312231 * Math.log(t - 10) - 305.0447927307);

  return [r, g, b];
}

/**
 * Per-channel gains (each 0..1, at least one channel = 1) for a target white
 * point, normalised so {@link WHITE_BALANCE_NEUTRAL_K} is the identity `[1,1,1]`.
 * Warmer than neutral pulls green + blue down; cooler pulls red down.
 */
export function kelvinToRgbGain(kelvin: number): RGB {
  const ref = blackbodyRgb(WHITE_BALANCE_NEUTRAL_K);
  const cur = blackbodyRgb(kelvin);
  const raw: RGB = [cur[0] / ref[0], cur[1] / ref[1], cur[2] / ref[2]];
  const max = Math.max(raw[0], raw[1], raw[2]) || 1;
  return [raw[0] / max, raw[1] / max, raw[2] / max];
}

/** True when the gain is (near enough) the identity — no need to touch pixels. */
export function isUnitGain(g: RGB): boolean {
  return Math.abs(g[0] - 1) < 1e-4 && Math.abs(g[1] - 1) < 1e-4 && Math.abs(g[2] - 1) < 1e-4;
}

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

function clamp8(n: number): number {
  return n < 0 ? 0 : n > 255 ? 255 : n;
}

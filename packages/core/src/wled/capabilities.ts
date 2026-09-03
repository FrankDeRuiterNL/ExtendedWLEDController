/**
 * Light-capability decoding from `info.leds.seglc` / `info.leds.lc`.
 *
 * | Bit | Capability   |
 * |-----|--------------|
 * | 0   | RGB          |
 * | 1   | white channel|
 * | 2   | CCT          |
 *
 * So 1 = RGB, 3 = RGBW, 7 = RGBW + CCT. Value 0 = the segment has no bus in
 * range. **CCT is per-segment only, never per-pixel.**
 */

import type { WledInfo } from './info.js';

export const LC_RGB = 0b001;
export const LC_WHITE = 0b010;
export const LC_CCT = 0b100;

export interface LightCapabilities {
  /** Raw capability byte. */
  raw: number;
  rgb: boolean;
  /** Dedicated white channel (RGBW). */
  white: boolean;
  /** Correlated colour temperature control (per-segment only). */
  cct: boolean;
  /** raw === 0: no LED bus maps to this segment. */
  empty: boolean;
}

export function decodeCapabilities(byte: number | undefined | null): LightCapabilities {
  const raw = typeof byte === 'number' && byte >= 0 ? byte : 0;
  return {
    raw,
    rgb: (raw & LC_RGB) !== 0,
    white: (raw & LC_WHITE) !== 0,
    cct: (raw & LC_CCT) !== 0,
    empty: raw === 0,
  };
}

/**
 * Capabilities for a specific segment id.
 *
 * Uses the per-segment `seglc[id]` — NOT the AND-reduced `lc`, which would
 * hide controls that only some segments support. Falls back to `lc` only when
 * `seglc` is absent entirely (very old firmware).
 */
export function segmentCapabilities(info: WledInfo, segmentId: number): LightCapabilities {
  const seglc = info.leds.seglc;
  if (Array.isArray(seglc) && seglc.length > 0) {
    if (segmentId >= 0 && segmentId < seglc.length) {
      return decodeCapabilities(seglc[segmentId]);
    }
    // Segment id beyond the reported range: treat as unknown-but-RGB so the
    // user isn't locked out of basic colour control.
    return decodeCapabilities(LC_RGB);
  }
  return decodeCapabilities(info.leds.lc ?? LC_RGB);
}

/** Union of capabilities across every reported segment (what the device *can* do). */
export function deviceCapabilities(info: WledInfo): LightCapabilities {
  const seglc = info.leds.seglc;
  if (Array.isArray(seglc) && seglc.length > 0) {
    return decodeCapabilities(seglc.reduce((acc, b) => acc | (b ?? 0), 0));
  }
  return decodeCapabilities(info.leds.lc ?? LC_RGB);
}

/**
 * How WLED wants CCT echoed back. The device accepts `seg.cct` as either
 * 0–255 relative or 1900–10091 Kelvin, and expects the same range it reported.
 */
export function cctIsKelvin(cct: number): boolean {
  return cct >= 1900;
}

export const CCT_KELVIN_MIN = 1900;
export const CCT_KELVIN_MAX = 10091;

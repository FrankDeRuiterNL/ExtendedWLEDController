import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  cctIsKelvin,
  decodeCapabilities,
  deviceCapabilities,
  segmentCapabilities,
} from './capabilities.js';
import type { WledInfo } from './info.js';

const realInfo: WledInfo = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../test/fixtures/wled-16.0.0-esp32/info.json', import.meta.url)),
    'utf8',
  ),
);

describe('decodeCapabilities', () => {
  it.each([
    [0, { rgb: false, white: false, cct: false, empty: true }],
    [1, { rgb: true, white: false, cct: false, empty: false }],
    [3, { rgb: true, white: true, cct: false, empty: false }],
    [7, { rgb: true, white: true, cct: true, empty: false }],
  ])('byte %i', (byte, expected) => {
    expect(decodeCapabilities(byte)).toMatchObject(expected);
  });

  it('treats negative / undefined as empty', () => {
    expect(decodeCapabilities(-1).empty).toBe(true);
    expect(decodeCapabilities(undefined).empty).toBe(true);
  });
});

describe('segmentCapabilities', () => {
  it('uses per-segment seglc, not the AND-reduced lc', () => {
    const info = {
      leds: { count: 10, pwr: 0, fps: 0, maxpwr: 0, maxseg: 32, seglc: [1, 3], lc: 1 },
    } as unknown as WledInfo;
    expect(segmentCapabilities(info, 0)).toMatchObject({ rgb: true, white: false });
    expect(segmentCapabilities(info, 1)).toMatchObject({ rgb: true, white: true });
  });

  it('falls back to RGB for a segment id beyond the reported range', () => {
    const info = { leds: { seglc: [1] } } as unknown as WledInfo;
    expect(segmentCapabilities(info, 5)).toMatchObject({ rgb: true });
  });

  it('real dump: segment 0 is RGB-only', () => {
    expect(segmentCapabilities(realInfo, 0)).toMatchObject({
      rgb: true,
      white: false,
      cct: false,
    });
    expect(deviceCapabilities(realInfo).raw).toBe(1);
  });
});

describe('cctIsKelvin', () => {
  it('>= 1900 is Kelvin, below is relative', () => {
    expect(cctIsKelvin(0)).toBe(false);
    expect(cctIsKelvin(255)).toBe(false);
    expect(cctIsKelvin(1900)).toBe(true);
    expect(cctIsKelvin(6500)).toBe(true);
  });
});

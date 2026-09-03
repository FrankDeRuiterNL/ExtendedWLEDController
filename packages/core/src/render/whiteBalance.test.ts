import { describe, expect, it } from 'vitest';
import {
  WHITE_BALANCE_NEUTRAL_K,
  isUnitGain,
  kelvinToRgbGain,
} from './whiteBalance.js';

describe('kelvinToRgbGain', () => {
  it('is exactly the identity at the neutral reference', () => {
    expect(kelvinToRgbGain(WHITE_BALANCE_NEUTRAL_K)).toEqual([1, 1, 1]);
    expect(isUnitGain(kelvinToRgbGain(6500))).toBe(true);
  });

  it('always keeps at least one channel at full and the rest ≤ 1', () => {
    for (const k of [2000, 2700, 4000, 5500, 6500, 8000, 10000]) {
      const g = kelvinToRgbGain(k);
      expect(Math.max(...g)).toBeCloseTo(1, 5);
      expect(Math.min(...g)).toBeGreaterThan(0);
      expect(Math.min(...g)).toBeLessThanOrEqual(1);
    }
  });

  it('warm (< 6500 K) pulls green and blue down, red stays full', () => {
    const g = kelvinToRgbGain(2700);
    expect(g[0]).toBeCloseTo(1, 5);
    expect(g[1]).toBeLessThan(0.85);
    expect(g[2]).toBeLessThan(g[1]);
  });

  it('cool (> 6500 K) pulls red down, blue stays full', () => {
    const g = kelvinToRgbGain(10000);
    expect(g[2]).toBeCloseTo(1, 5);
    expect(g[0]).toBeLessThan(0.9);
    expect(g[0]).toBeLessThan(g[1]);
  });

  it('moves monotonically — warmer means relatively less blue', () => {
    const warmer = kelvinToRgbGain(3000);
    const cooler = kelvinToRgbGain(5000);
    expect(warmer[2] / warmer[0]).toBeLessThan(cooler[2] / cooler[0]);
  });

  it('clamps absurd inputs instead of returning NaN', () => {
    for (const k of [0, -100, 1e9, NaN]) {
      const g = kelvinToRgbGain(k);
      expect(g.every((n) => Number.isFinite(n))).toBe(true);
    }
  });
});

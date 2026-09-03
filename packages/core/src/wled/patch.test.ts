import { describe, expect, it } from 'vitest';
import { applyOptimistic, brightnessPatch, looksLikeFullState, segmentPatch } from './patch.js';

describe('brightnessPatch', () => {
  it('maps zero / negative / NaN to {on:false}, never bri:0', () => {
    expect(brightnessPatch(0)).toEqual({ on: false });
    expect(brightnessPatch(-5)).toEqual({ on: false });
    expect(brightnessPatch(Number.NaN)).toEqual({ on: false });
  });

  it('clamps the top end to 255 and turns the device on', () => {
    expect(brightnessPatch(300)).toEqual({ on: true, bri: 255 });
    expect(brightnessPatch(128)).toEqual({ on: true, bri: 128 });
  });
});

describe('segmentPatch', () => {
  it('targets one segment by id and touches nothing else', () => {
    expect(segmentPatch(2, { fx: 38, sx: 24 })).toEqual({ seg: [{ id: 2, fx: 38, sx: 24 }] });
  });
});

describe('applyOptimistic', () => {
  it('merges scalar fields', () => {
    expect(applyOptimistic({ on: true, bri: 10 }, { bri: 200 })).toMatchObject({ on: true, bri: 200 });
  });

  it('merges a segment by id without disturbing siblings', () => {
    const cur = { seg: [{ id: 0, fx: 0 }, { id: 1, fx: 5 }] };
    const next = applyOptimistic(cur, { seg: [{ id: 1, fx: 9, sx: 100 }] });
    expect(next.seg).toEqual([{ id: 0, fx: 0 }, { id: 1, fx: 9, sx: 100 }]);
  });

  it('appends an unknown segment id', () => {
    const next = applyOptimistic({ seg: [{ id: 0 }] }, { seg: [{ id: 3, fx: 1 }] });
    expect(next.seg).toEqual([{ id: 0 }, { id: 3, fx: 1 }]);
  });
});

describe('looksLikeFullState', () => {
  it('accepts small patches', () => {
    expect(looksLikeFullState({ on: true, bri: 128 })).toBe(false);
    expect(looksLikeFullState({ seg: [{ id: 0, fx: 1 }] })).toBe(false);
  });

  it('flags bulky payloads and long segment arrays', () => {
    expect(looksLikeFullState({ seg: Array.from({ length: 8 }, (_, id) => ({ id })) })).toBe(true);
  });
});

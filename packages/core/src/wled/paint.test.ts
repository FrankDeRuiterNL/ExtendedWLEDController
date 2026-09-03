import { describe, expect, it } from 'vitest';
import {
  buildDensePaint,
  buildSparsePaint,
  matrixPaintIndex,
  paintPreamble,
  paintRelease,
  rgbToWledHex,
  wledHexToRgb,
} from './paint.js';

describe('rgbToWledHex', () => {
  it('formats [r,g,b] as upper-case 6-hex, no #', () => {
    expect(rgbToWledHex([255, 0, 128])).toBe('FF0080');
    expect(rgbToWledHex([0, 0, 0])).toBe('000000');
  });

  it('appends a white byte when a 4th channel is present', () => {
    expect(rgbToWledHex([16, 32, 48, 64])).toBe('10203040');
  });

  it('clamps and rounds out-of-range channels', () => {
    expect(rgbToWledHex([-10, 300, 127.6])).toBe('00FF80');
  });

  it('round-trips through wledHexToRgb', () => {
    expect(wledHexToRgb(rgbToWledHex([12, 34, 56]))).toEqual([12, 34, 56]);
    expect(wledHexToRgb('#0A141E')).toEqual([10, 20, 30]);
  });

  it('pads a short hex to at least r,g,b', () => {
    expect(wledHexToRgb('FF')).toEqual([255, 0, 0]);
  });
});

describe('matrixPaintIndex', () => {
  it('is row-major non-serpentine', () => {
    expect(matrixPaintIndex(0, 0, 8)).toBe(0);
    expect(matrixPaintIndex(3, 0, 8)).toBe(3);
    expect(matrixPaintIndex(0, 1, 8)).toBe(8);
    expect(matrixPaintIndex(7, 2, 8)).toBe(23);
  });
});

describe('buildDensePaint', () => {
  it('emits one [startIndex, ...hex] block for a run that fits in a chunk', () => {
    const chunks = buildDensePaint([[255, 0, 0], [0, 255, 0], '0000FF'], { segId: 1 });
    expect(chunks).toEqual([{ id: 1, i: [0, 'FF0000', '00FF00', '0000FF'] }]);
  });

  it('splits into sequential chunks at chunkSize, each with its own startIndex', () => {
    const pixels = Array.from({ length: 5 }, () => [1, 2, 3] as number[]);
    const chunks = buildDensePaint(pixels, { chunkSize: 2 });
    expect(chunks.map((c) => c.i![0])).toEqual([0, 2, 4]);
    expect(chunks[0].i).toHaveLength(3); // start + 2 colours
    expect(chunks[2].i).toHaveLength(2); // start + 1 colour
  });

  it('defaults the segment id to 0 and upper-cases string input', () => {
    expect(buildDensePaint(['ff00aa'])).toEqual([{ id: 0, i: [0, 'FF00AA'] }]);
  });
});

describe('buildSparsePaint', () => {
  it('coalesces consecutive indices into a single run', () => {
    const chunks = buildSparsePaint([
      { index: 5, color: [255, 0, 0] },
      { index: 6, color: [0, 255, 0] },
      { index: 7, color: [0, 0, 255] },
    ]);
    expect(chunks).toEqual([{ id: 0, i: [5, 'FF0000', '00FF00', '0000FF'] }]);
  });

  it('starts a new run when indices are not contiguous', () => {
    const chunks = buildSparsePaint([
      { index: 2, color: '111111' },
      { index: 9, color: '222222' },
    ]);
    expect(chunks).toEqual([{ id: 0, i: [2, '111111', 9, '222222'] }]);
  });

  it('sorts unsorted input before coalescing', () => {
    const chunks = buildSparsePaint([
      { index: 3, color: '030303' },
      { index: 1, color: '010101' },
      { index: 2, color: '020202' },
    ]);
    expect(chunks).toEqual([{ id: 0, i: [1, '010101', '020202', '030303'] }]);
  });

  it('dedupes a repeated index, last write wins', () => {
    const chunks = buildSparsePaint([
      { index: 4, color: '000000' },
      { index: 4, color: 'FFFFFF' },
    ]);
    expect(chunks).toEqual([{ id: 0, i: [4, 'FFFFFF'] }]);
  });

  it('caps colours per chunk at chunkSize', () => {
    const painted = Array.from({ length: 5 }, (_, k) => ({ index: k, color: '0A0A0A' }));
    const chunks = buildSparsePaint(painted, { chunkSize: 2, segId: 3 });
    expect(chunks).toHaveLength(3);
    expect(chunks.every((c) => c.id === 3)).toBe(true);
  });
});

describe('paintPreamble / paintRelease', () => {
  it('preamble powers on, sets brightness, no transition, no seg', () => {
    expect(paintPreamble(200)).toEqual({ on: true, bri: 200, tt: 0 });
  });

  it('preamble clamps brightness to 1..255', () => {
    expect(paintPreamble(0).bri).toBe(1);
    expect(paintPreamble(999).bri).toBe(255);
  });

  it('release un-freezes the target segment only', () => {
    expect(paintRelease(2)).toEqual({ seg: [{ id: 2, frz: false }] });
  });
});

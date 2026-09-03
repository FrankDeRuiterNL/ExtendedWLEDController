import { describe, expect, it } from 'vitest';
import {
  fixtureLocalPositions,
  mapFixture,
  mapInstallation,
  matrixCell,
  renderDeviceBuffers,
  type MappedLed,
} from './engine.js';
import type { Fixture, Installation } from './model.js';

describe('matrixCell — wire index → grid cell', () => {
  const base = { kind: 'matrix' as const, width: 4, height: 3, serpentine: false, origin: 'top-left' as const };

  it('row-major, non-serpentine, top-left', () => {
    expect(matrixCell(0, base)).toEqual({ col: 0, row: 0 });
    expect(matrixCell(3, base)).toEqual({ col: 3, row: 0 });
    expect(matrixCell(4, base)).toEqual({ col: 0, row: 1 });
    expect(matrixCell(11, base)).toEqual({ col: 3, row: 2 });
  });

  it('serpentine reverses odd rows', () => {
    const s = { ...base, serpentine: true };
    expect(matrixCell(4, s)).toEqual({ col: 3, row: 1 }); // row 1 runs right→left
    expect(matrixCell(7, s)).toEqual({ col: 0, row: 1 });
    expect(matrixCell(8, s)).toEqual({ col: 0, row: 2 }); // row 2 back to left→right
  });

  it('origin bottom-left flips rows', () => {
    expect(matrixCell(0, { ...base, origin: 'bottom-left' })).toEqual({ col: 0, row: 2 });
  });

  it('origin top-right flips columns', () => {
    expect(matrixCell(0, { ...base, origin: 'top-right' })).toEqual({ col: 3, row: 0 });
  });

  it('column-major runs down columns first', () => {
    const c = { ...base, columnMajor: true };
    expect(matrixCell(0, c)).toEqual({ col: 0, row: 0 });
    expect(matrixCell(2, c)).toEqual({ col: 0, row: 2 });
    expect(matrixCell(3, c)).toEqual({ col: 1, row: 0 });
  });

  it('column-major serpentine reverses odd columns', () => {
    const c = { ...base, columnMajor: true, serpentine: true };
    expect(matrixCell(3, c)).toEqual({ col: 1, row: 2 });
  });
});

describe('fixtureLocalPositions', () => {
  it('strip spreads LEDs 0..1 along x, centred on y', () => {
    expect(fixtureLocalPositions({ kind: 'strip', count: 3 })).toEqual([
      { x: 0, y: 0.5 },
      { x: 0.5, y: 0.5 },
      { x: 1, y: 0.5 },
    ]);
  });

  it('single-LED strip sits at the centre', () => {
    expect(fixtureLocalPositions({ kind: 'strip', count: 1 })).toEqual([{ x: 0.5, y: 0.5 }]);
  });

  it('serpentine matrix: wire index 4 (start of reversed row) is at the right edge', () => {
    const pos = fixtureLocalPositions({
      kind: 'matrix', width: 4, height: 2, serpentine: true, origin: 'top-left',
    });
    expect(pos[4]).toEqual({ x: 1, y: 1 });
    expect(pos[7]).toEqual({ x: 0, y: 1 });
  });
});

describe('mapFixture — transform onto the canvas', () => {
  const canvas = { width: 10, height: 10 };
  const strip3 = (t: Partial<Fixture['transform']>): Fixture => ({
    id: 'f', deviceId: 1, name: 's', startIndex: 0, enabled: true,
    geometry: { kind: 'strip', count: 3 },
    transform: { position: { x: 5, y: 5 }, rotationDeg: 0, size: { x: 6, y: 1 }, ...t },
  });

  it('centres a horizontal strip and normalises to 0..1', () => {
    const m = mapFixture(strip3({}), canvas);
    expect(m.map((p) => [round(p.x), round(p.y)])).toEqual([
      [0.2, 0.5], // x = (5 - 3)/10
      [0.5, 0.5],
      [0.8, 0.5], // x = (5 + 3)/10
    ]);
  });

  it('90° rotation turns a horizontal strip vertical', () => {
    const m = mapFixture(strip3({ rotationDeg: 90 }), canvas);
    expect(m.map((p) => [round(p.x), round(p.y)])).toEqual([
      [0.5, 0.2],
      [0.5, 0.5],
      [0.5, 0.8],
    ]);
  });

  it('assigns device wire indices from startIndex', () => {
    const f = strip3({});
    f.startIndex = 100;
    expect(mapFixture(f, canvas).map((p) => p.index)).toEqual([100, 101, 102]);
  });
});

describe('mapInstallation', () => {
  it('skips disabled fixtures', () => {
    const inst: Installation = {
      canvas: { width: 10, height: 10 },
      fixtures: [
        { id: 'a', deviceId: 1, name: 'a', startIndex: 0, enabled: true, geometry: { kind: 'strip', count: 2 }, transform: { position: { x: 5, y: 5 }, rotationDeg: 0, size: { x: 4, y: 1 } } },
        { id: 'b', deviceId: 2, name: 'b', startIndex: 0, enabled: false, geometry: { kind: 'strip', count: 2 }, transform: { position: { x: 5, y: 5 }, rotationDeg: 0, size: { x: 4, y: 1 } } },
      ],
    };
    expect(mapInstallation(inst).every((l) => l.deviceId === 1)).toBe(true);
  });
});

describe('renderDeviceBuffers', () => {
  const mapped: MappedLed[] = [
    { deviceId: 1, index: 0, x: 0, y: 0 },
    { deviceId: 1, index: 2, x: 1, y: 1 },
    { deviceId: 2, index: 0, x: 0.5, y: 0.5 },
  ];

  it('packs sampled colours at the LED wire index; uncovered LEDs stay black', () => {
    const bufs = renderDeviceBuffers(
      mapped,
      [
        { deviceId: 1, ledCount: 3, format: 'rgb' },
        { deviceId: 2, ledCount: 1, format: 'rgb' },
      ],
      (x) => [Math.round(x * 255), 0, 0],
    );
    expect([...bufs.get(1)!]).toEqual([0, 0, 0, /* idx1 uncovered */ 0, 0, 0, 255, 0, 0]);
    expect([...bufs.get(2)!]).toEqual([128, 0, 0]);
  });

  it('RGBW buffers carry a white channel', () => {
    const bufs = renderDeviceBuffers(
      [{ deviceId: 1, index: 0, x: 0, y: 0 }],
      [{ deviceId: 1, ledCount: 1, format: 'rgbw' }],
      () => [10, 20, 30, 40],
    );
    expect([...bufs.get(1)!]).toEqual([10, 20, 30, 40]);
  });

  it('ignores LEDs whose index is out of the device buffer', () => {
    const bufs = renderDeviceBuffers(
      [{ deviceId: 1, index: 99, x: 0, y: 0 }],
      [{ deviceId: 1, ledCount: 3, format: 'rgb' }],
      () => [255, 255, 255],
    );
    expect([...bufs.get(1)!]).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });
});

const round = (n: number) => Math.round(n * 1000) / 1000;

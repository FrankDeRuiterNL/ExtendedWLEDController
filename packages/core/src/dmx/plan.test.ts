import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DMX_PLAN_CONFIG,
  allocationToDeviceCfg,
  findPatchConflicts,
  planDmxAllocation,
  replanPatch,
  universeSpan,
  type DmxAllocation,
} from './plan.js';

const alloc = (firstUniverse: number, universeCount: number, ledCount = 150): DmxAllocation => ({
  firstUniverse,
  universeCount,
  startChannel: 1,
  channelsPerLed: 3,
  ledCount,
});

describe('universeSpan', () => {
  it('150 RGB LEDs fit in one universe (170/universe)', () => {
    expect(universeSpan(150, 3, DEFAULT_DMX_PLAN_CONFIG)).toBe(1);
  });
  it('171 RGB LEDs need two universes', () => {
    expect(universeSpan(171, 3, DEFAULT_DMX_PLAN_CONFIG)).toBe(2);
  });
  it('500 RGB LEDs → 3 universes', () => {
    expect(universeSpan(500, 3, DEFAULT_DMX_PLAN_CONFIG)).toBe(3);
  });
  it('RGBW packs 128 per universe', () => {
    expect(universeSpan(128, 4, DEFAULT_DMX_PLAN_CONFIG)).toBe(1);
    expect(universeSpan(129, 4, DEFAULT_DMX_PLAN_CONFIG)).toBe(2);
  });
  it('0 or negative → at least 1', () => {
    expect(universeSpan(0, 3, DEFAULT_DMX_PLAN_CONFIG)).toBe(1);
  });
});

describe('planDmxAllocation — boundary packing, first-fit', () => {
  it('first device gets the base universe, channel 1', () => {
    const a = planDmxAllocation({ ledCount: 150, channelsPerLed: 3, existing: [] });
    expect(a).toMatchObject({ firstUniverse: 1, universeCount: 1, startChannel: 1 });
  });

  it('second 150-LED device gets universe 2', () => {
    const a = planDmxAllocation({ ledCount: 150, channelsPerLed: 3, existing: [alloc(1, 1)] });
    expect(a.firstUniverse).toBe(2);
  });

  it('a 400-LED device after a 150-LED device takes universes 2–4', () => {
    const a = planDmxAllocation({ ledCount: 400, channelsPerLed: 3, existing: [alloc(1, 1)] });
    expect(a.firstUniverse).toBe(2);
    expect(a.universeCount).toBe(3);
  });

  it('fills a gap left by a removed device (first-fit, not append)', () => {
    // devices at u1 (1) and u4 (2). A 1-universe device fills u2/u3? -> u2.
    const a = planDmxAllocation({
      ledCount: 100,
      channelsPerLed: 3,
      existing: [alloc(1, 1), alloc(4, 2)],
    });
    expect(a.firstUniverse).toBe(2);
  });

  it('a device too big for the gap skips past to the next free block', () => {
    // gap is just u2..u3 (size 2). A 3-universe device must go after u5.
    const a = planDmxAllocation({
      ledCount: 500, // 3 universes
      channelsPerLed: 3,
      existing: [alloc(1, 1), alloc(4, 2)],
    });
    expect(a.firstUniverse).toBe(6);
  });

  it('honours preferFirstUniverse when it is free', () => {
    const a = planDmxAllocation({
      ledCount: 150,
      channelsPerLed: 3,
      existing: [alloc(1, 1)],
      preferFirstUniverse: 10,
    });
    expect(a.firstUniverse).toBe(10);
  });

  it('ignores preferFirstUniverse when it would conflict', () => {
    const a = planDmxAllocation({
      ledCount: 150,
      channelsPerLed: 3,
      existing: [alloc(1, 1), alloc(10, 1)],
      preferFirstUniverse: 10,
    });
    expect(a.firstUniverse).toBe(2);
  });

  it('respects a non-default base universe', () => {
    const a = planDmxAllocation({
      ledCount: 150,
      channelsPerLed: 3,
      existing: [],
      config: { ...DEFAULT_DMX_PLAN_CONFIG, baseUniverse: 100 },
    });
    expect(a.firstUniverse).toBe(100);
  });
});

describe('allocationToDeviceCfg', () => {
  it('RGB → multi-RGB mode (4), addr 1, uni = firstUniverse', () => {
    expect(allocationToDeviceCfg(alloc(5, 2))).toEqual({ uni: 5, addr: 1, mode: 4 });
  });
  it('RGBW → multi-RGBW mode (6)', () => {
    expect(allocationToDeviceCfg({ ...alloc(3, 1), channelsPerLed: 4 })).toEqual({ uni: 3, addr: 1, mode: 6 });
  });
});

describe('findPatchConflicts', () => {
  it('reports overlapping universe ranges', () => {
    const c = findPatchConflicts([
      { deviceId: 1, name: 'A', allocation: alloc(1, 3) },
      { deviceId: 2, name: 'B', allocation: alloc(3, 2) },
      { deviceId: 3, name: 'C', allocation: alloc(6, 1) },
    ]);
    expect(c).toHaveLength(1);
    expect(c[0]!.universes).toEqual([3, 3]);
    expect([c[0]!.a.name, c[0]!.b.name].sort()).toEqual(['A', 'B']);
  });

  it('clean patch → no conflicts', () => {
    expect(
      findPatchConflicts([
        { deviceId: 1, name: 'A', allocation: alloc(1, 1) },
        { deviceId: 2, name: 'B', allocation: alloc(2, 1) },
      ]),
    ).toEqual([]);
  });
});

describe('replanPatch', () => {
  it('produces a deterministic, gap-free patch ordered by device id', () => {
    const patch = replanPatch([
      { deviceId: 3, name: 'C', ledCount: 150, channelsPerLed: 3 },
      { deviceId: 1, name: 'A', ledCount: 300, channelsPerLed: 3 },
      { deviceId: 2, name: 'B', ledCount: 150, channelsPerLed: 3 },
    ]);
    expect(patch.map((p) => [p.deviceId, p.allocation.firstUniverse, p.allocation.universeCount])).toEqual([
      [1, 1, 2],
      [2, 3, 1],
      [3, 4, 1],
    ]);
    expect(findPatchConflicts(patch)).toEqual([]);
  });
});

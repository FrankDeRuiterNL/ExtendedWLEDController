import { describe, expect, it } from 'vitest';
import {
  DATA_LINE_LED_BUDGET,
  LED_TYPES,
  dataLineLoad,
  estimatePower,
  ledTypeById,
} from './power.js';

const ws2812b = ledTypeById('ws2812b')!;
const ws2815 = ledTypeById('ws2815')!;

describe('ledTypeById', () => {
  it('resolves a known id and shrugs off unknowns', () => {
    expect(ledTypeById('ws2812b')?.name).toBe('WS2812B (5V)');
    expect(ledTypeById('nope')).toBeUndefined();
    expect(ledTypeById(null)).toBeUndefined();
    expect(ledTypeById(undefined)).toBeUndefined();
  });

  it('every LED type carries the guidance figures the estimator needs', () => {
    for (const t of LED_TYPES) {
      expect(t.maPerLedFullWhite).toBeGreaterThan(0);
      expect(t.maxLedsPerRun).toBeGreaterThan(0);
      expect(t.typicalLedsPerMeter).toBeGreaterThan(0);
    }
  });
});

describe('estimatePower', () => {
  it('sizes the supply against full-white worst case with headroom', () => {
    const est = estimatePower({ ledCount: 150, ledType: ws2812b });
    // 150 * 55mA = 8.25 A
    expect(est.maxAmps).toBeCloseTo(8.25, 2);
    expect(est.maxWatts).toBe(Math.round(8.25 * 5));
    // 8.25 * 1.25 = 10.31 -> next standard size is 15 A
    expect(est.psu.amps).toBe(15);
    expect(est.psu.voltage).toBe(5);
  });

  it('places injection points every maxLedsPerRun LEDs across the whole output', () => {
    // 5V WS2812B: a fresh feed every 150 LEDs
    const est = estimatePower({ ledCount: 400, ledType: ws2812b, ledsPerMeter: 60 });
    expect(est.injectionPoints.map((p) => p.atLed)).toEqual([150, 300]);
    // 150 LEDs / 60 per m = 2.5 m from the start
    expect(est.injectionPoints[0]!.meters).toBeCloseTo(2.5, 1);
    expect(est.lengthMeters).toBeCloseTo(400 / 60, 1);
  });

  it('needs no extra injection when the head feed covers the run', () => {
    const est = estimatePower({ ledCount: 120, ledType: ws2812b });
    expect(est.injectionPoints).toEqual([]);
  });

  it('runs 12V strips much further before injection', () => {
    const est = estimatePower({ ledCount: 400, ledType: ws2815, ledsPerMeter: 60 });
    // maxLedsPerRun 300 -> one injection at 300
    expect(est.injectionPoints.map((p) => p.atLed)).toEqual([300]);
  });

  it('falls back to the type density when none is given', () => {
    const est = estimatePower({ ledCount: 300, ledType: ws2812b });
    expect(est.lengthMeters).toBeCloseTo(300 / ws2812b.typicalLedsPerMeter, 1);
  });
});

describe('dataLineLoad', () => {
  it('reports the output load against the protocol budget', () => {
    const load = dataLineLoad(400);
    expect(load.budget).toBe(DATA_LINE_LED_BUDGET);
    expect(load.percent).toBe(50);
    expect(load.over).toBe(false);
  });

  it('flags an output past its practical capacity', () => {
    const load = dataLineLoad(1000);
    expect(load.over).toBe(true);
    expect(load.percent).toBeGreaterThan(100);
  });
});

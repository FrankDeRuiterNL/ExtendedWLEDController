/**
 * Power & data planning for a single addressable-LED data output.
 *
 * This is an **installer's estimating tool**, not a simulator. The per-LED
 * currents, run lengths and densities below are typical field guidance for the
 * common chips — real strips vary by brand, so the UI lets the installer
 * override the LED density. Everything here is pure and runtime-agnostic.
 *
 * One "output" = one WLED data pin = one continuous electrical strip. Fixtures
 * are just named sections of that run; their LEDs always follow each other in
 * wire order, so power is always calculated for the whole output.
 */

export interface LedType {
  id: string;
  /** Human label for the dropdown. */
  name: string;
  voltage: 5 | 12 | 24;
  /** RGB (3) or RGBW (4). */
  channels: 3 | 4;
  /** Guidance: current one LED/pixel draws at full white, in mA. */
  maPerLedFullWhite: number;
  /**
   * Guidance: how many LEDs one feed point can supply before voltage drop gets
   * bad enough to want a fresh power injection. Higher-voltage strips run much
   * further on one feed.
   */
  maxLedsPerRun: number;
  /** Guidance: typical physical density (LEDs per metre). The installer can override. */
  typicalLedsPerMeter: number;
}

/** The common chips an LED installer runs into, most-used first. */
export const LED_TYPES: readonly LedType[] = [
  { id: 'ws2812b', name: 'WS2812B (5V)', voltage: 5, channels: 3, maPerLedFullWhite: 55, maxLedsPerRun: 150, typicalLedsPerMeter: 60 },
  { id: 'ws2813', name: 'WS2813 (5V)', voltage: 5, channels: 3, maPerLedFullWhite: 55, maxLedsPerRun: 150, typicalLedsPerMeter: 60 },
  { id: 'sk6812', name: 'SK6812 (5V)', voltage: 5, channels: 3, maPerLedFullWhite: 55, maxLedsPerRun: 150, typicalLedsPerMeter: 60 },
  { id: 'sk6812-rgbw', name: 'SK6812 RGBW (5V)', voltage: 5, channels: 4, maPerLedFullWhite: 75, maxLedsPerRun: 140, typicalLedsPerMeter: 60 },
  { id: 'ws2811', name: 'WS2811 (12V)', voltage: 12, channels: 3, maPerLedFullWhite: 20, maxLedsPerRun: 300, typicalLedsPerMeter: 30 },
  { id: 'ws2815', name: 'WS2815 (12V)', voltage: 12, channels: 3, maPerLedFullWhite: 20, maxLedsPerRun: 300, typicalLedsPerMeter: 60 },
  { id: 'gs8208', name: 'GS8208 (12V)', voltage: 12, channels: 3, maPerLedFullWhite: 20, maxLedsPerRun: 300, typicalLedsPerMeter: 60 },
  { id: 'ucs1903', name: 'UCS1903 (12V)', voltage: 12, channels: 3, maPerLedFullWhite: 20, maxLedsPerRun: 280, typicalLedsPerMeter: 60 },
  { id: 'apa102', name: 'APA102 / SK9822 (5V)', voltage: 5, channels: 3, maPerLedFullWhite: 60, maxLedsPerRun: 150, typicalLedsPerMeter: 60 },
  { id: 'ws2801', name: 'WS2801 (5V)', voltage: 5, channels: 3, maPerLedFullWhite: 60, maxLedsPerRun: 150, typicalLedsPerMeter: 32 },
  { id: 'tm1814', name: 'TM1814 (12V RGBW)', voltage: 12, channels: 4, maPerLedFullWhite: 27, maxLedsPerRun: 280, typicalLedsPerMeter: 60 },
];

export function ledTypeById(id: string | null | undefined): LedType | undefined {
  return id == null ? undefined : LED_TYPES.find((t) => t.id === id);
}

/**
 * Practical LED budget for one WLED data output at a usable frame rate. The
 * WS281x wire protocol needs ~30 µs per LED, so ~800 LEDs is roughly the point
 * where a single output can no longer hold ~40 fps.
 */
export const DATA_LINE_LED_BUDGET = 800;

/** Off-the-shelf DC supply current ratings (A) to snap a recommendation to. */
const PSU_AMP_SIZES = [1, 2, 3, 5, 8, 10, 15, 20, 25, 30, 40, 50, 60, 70, 80, 100] as const;

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

export interface PowerInjectionPoint {
  /** Wire index of the first LED fed by this injection point. */
  atLed: number;
  /** Approximate distance from the start of the strip, in metres. */
  meters: number;
}

export interface PowerEstimate {
  ledCount: number;
  voltage: number;
  /** Every LED at full white — the figure a power supply must be sized against. */
  maxAmps: number;
  maxWatts: number;
  /** Recommended single supply to place at the head of the strip. */
  psu: { voltage: number; amps: number; watts: number };
  /**
   * Extra power injection points beyond the head feed. Empty when one feed at
   * the start covers the whole run.
   */
  injectionPoints: PowerInjectionPoint[];
  /** Total physical length of the run, in metres. */
  lengthMeters: number;
}

export interface PowerInput {
  /** LEDs on the whole output (not one fixture section). */
  ledCount: number;
  ledType: LedType;
  /** Physical density; falls back to the LED type's typical figure. */
  ledsPerMeter?: number | null;
}

export function estimatePower({ ledCount, ledType, ledsPerMeter }: PowerInput): PowerEstimate {
  const n = Math.max(0, Math.floor(ledCount));
  const density = ledsPerMeter && ledsPerMeter > 0 ? ledsPerMeter : ledType.typicalLedsPerMeter;

  const maxAmps = (n * ledType.maPerLedFullWhite) / 1000;
  const maxWatts = maxAmps * ledType.voltage;

  // Size the supply to the worst case with 25% headroom, then snap up to a
  // standard rating.
  const needAmps = maxAmps * 1.25;
  const psuAmps = PSU_AMP_SIZES.find((a) => a >= needAmps) ?? Math.ceil(needAmps / 10) * 10;

  const seg = Math.max(1, Math.floor(ledType.maxLedsPerRun));
  const injectionPoints: PowerInjectionPoint[] = [];
  for (let at = seg; at < n; at += seg) {
    injectionPoints.push({ atLed: at, meters: round1(at / density) });
  }

  return {
    ledCount: n,
    voltage: ledType.voltage,
    maxAmps: round2(maxAmps),
    maxWatts: Math.round(maxWatts),
    psu: { voltage: ledType.voltage, amps: psuAmps, watts: psuAmps * ledType.voltage },
    injectionPoints,
    lengthMeters: round1(n / density),
  };
}

export interface DataLineLoad {
  ledCount: number;
  budget: number;
  /** 0..1+ — above 1 means the output is past its practical capacity. */
  fraction: number;
  percent: number;
  over: boolean;
}

/** How hard one data output is being worked, against {@link DATA_LINE_LED_BUDGET}. */
export function dataLineLoad(ledCount: number, budget = DATA_LINE_LED_BUDGET): DataLineLoad {
  const n = Math.max(0, Math.floor(ledCount));
  const fraction = budget > 0 ? n / budget : 0;
  return { ledCount: n, budget, fraction, percent: Math.round(fraction * 100), over: fraction > 1 };
}

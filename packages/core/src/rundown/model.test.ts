import { describe, expect, it } from 'vitest';
import {
  autoFireDelayMs,
  cueLevelAt,
  cuePhaseAt,
  cueTotalMs,
  formatDuration,
  makeCue,
  parseDuration,
  type Cue,
} from './model.js';

const cue = (over: Partial<Cue> = {}): Cue => ({
  ...makeCue('1'),
  fadeInMs: 1000,
  durationMs: 4000,
  fadeOutMs: 2000,
  ...over,
});

describe('parseDuration', () => {
  it('reads bare seconds, m:ss and h:mm:ss', () => {
    expect(parseDuration('35')).toBe(35_000);
    expect(parseDuration('1:20')).toBe(80_000);
    expect(parseDuration('1:30:24')).toBe(5_424_000);
    expect(parseDuration('1.5')).toBe(1_500);
  });
  it('rejects junk', () => {
    expect(parseDuration('')).toBeNull();
    expect(parseDuration('abc')).toBeNull();
    expect(parseDuration('1:2:3:4')).toBeNull();
    expect(parseDuration('-5')).toBeNull();
    expect(parseDuration('1::2')).toBeNull();
  });
  it('round-trips through formatDuration', () => {
    expect(formatDuration(parseDuration('2:05')!)).toBe('2:05');
    expect(formatDuration(parseDuration('1:00:00')!)).toBe('1:00:00');
    expect(formatDuration(90_000)).toBe('1:30');
  });
});

describe('cue timing', () => {
  it('cueTotalMs = fade-in + hold + fade-out', () => {
    expect(cueTotalMs(cue())).toBe(7000);
  });

  it('cuePhaseAt walks fade-in → hold → fade-out → done', () => {
    const c = cue();
    expect(cuePhaseAt(c, 0)).toBe('fade-in');
    expect(cuePhaseAt(c, 999)).toBe('fade-in');
    expect(cuePhaseAt(c, 1000)).toBe('hold');
    expect(cuePhaseAt(c, 4999)).toBe('hold');
    expect(cuePhaseAt(c, 5000)).toBe('fade-out');
    expect(cuePhaseAt(c, 6999)).toBe('fade-out');
    expect(cuePhaseAt(c, 7000)).toBe('done');
  });

  it('cueLevelAt ramps 0→1 in, holds, 1→0 out', () => {
    const c = cue();
    expect(cueLevelAt(c, 0)).toBe(0);
    expect(cueLevelAt(c, 500)).toBeCloseTo(0.5);
    expect(cueLevelAt(c, 1000)).toBe(1);
    expect(cueLevelAt(c, 5000)).toBe(1);
    expect(cueLevelAt(c, 6000)).toBeCloseTo(0.5);
    expect(cueLevelAt(c, 7000)).toBe(0);
  });

  it('no fade-in → full from the first instant', () => {
    expect(cueLevelAt(cue({ fadeInMs: 0 }), 0)).toBe(1);
  });
});

describe('autoFireDelayMs', () => {
  const prev = cue(); // total 7000

  it('manual → null (waits for GO)', () => {
    expect(autoFireDelayMs(prev, cue({ trigger: { type: 'manual' } }))).toBeNull();
  });
  it('follow → measured from prev START', () => {
    expect(autoFireDelayMs(prev, cue({ trigger: { type: 'follow', seconds: 3 } }))).toBe(3000);
    expect(autoFireDelayMs(prev, cue({ trigger: { type: 'follow', seconds: 0 } }))).toBe(0);
  });
  it('wait → measured from prev FINISH (its whole run + the delay)', () => {
    expect(autoFireDelayMs(prev, cue({ trigger: { type: 'wait', seconds: 2 } }))).toBe(9000);
    expect(autoFireDelayMs(prev, cue({ trigger: { type: 'wait', seconds: 0 } }))).toBe(7000);
  });
});

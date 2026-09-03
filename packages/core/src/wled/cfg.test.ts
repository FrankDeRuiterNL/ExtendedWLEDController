import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { summarizeCfg, type WledCfg } from './cfg.js';

const realCfg: WledCfg = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../test/fixtures/wled-16.0.0-esp32/cfg.json', import.meta.url)),
    'utf8',
  ),
);

describe('summarizeCfg — real WLED 16.0.0 dump', () => {
  const s = summarizeCfg(realCfg);

  it('extracts the NON-ZERO DMX start address (this device has addr:1)', () => {
    expect(s.dmxStartAddress).toBe(1);
  });

  it('extracts DMX universe and mode', () => {
    expect(s.dmxUniverse).toBe(10);
    expect(s.dmxMode).toBe(4);
  });

  it('converts the realtime timeout from 100ms units to ms', () => {
    expect(s.realtimeTimeoutMs).toBe(2500); // cfg.if.live.timeout = 25
  });

  it('reads the realtime gamma / brightness policy', () => {
    expect(s.realtimeGammaDisabled).toBe(true); // if.live.no-gc = true
    expect(s.realtimeForcesMaxBrightness).toBe(false);
    expect(s.gamma).toEqual({ bri: 1, col: 2.8, val: 2.8 });
    expect(s.brightnessScalePercent).toBe(100);
  });

  it('reads the mdns hostname', () => {
    expect(s.mdnsName).toBe('wled-ramen');
  });
});

describe('summarizeCfg — defensive defaults', () => {
  it('missing cfg yields a zero DMX address and null policy fields', () => {
    const s = summarizeCfg(null);
    expect(s.dmxStartAddress).toBe(0);
    expect(s.realtimeTimeoutMs).toBeNull();
    expect(s.gamma).toBeNull();
    expect(s.realtimeOffset).toBe(0);
  });

  it('a firmware that moved if.live.dmx still yields addr 0, not a crash', () => {
    expect(summarizeCfg({ if: { live: {} } }).dmxStartAddress).toBe(0);
  });
});

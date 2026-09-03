import {
  WS_UNSUPPORTED,
  isMatrix,
  parseFxData,
  summarizeCfg,
  type DeviceWarning,
} from '@ewc/core';
import type { WledSnapshot } from './httpClient.js';

/** Flattened, storable view of a device snapshot. */
export interface ImportedDevice {
  mac: string | null;
  arch: string | null;
  fwVersion: string | null;
  name: string | null;
  ledCount: number | null;
  matrixW: number | null;
  matrixH: number | null;
  seglc: number[] | null;
  lc: number | null;
  fxcount: number | null;
  palcount: number | null;
  fsTotalKb: number | null;
  fsUsedKb: number | null;
  wsSupported: boolean | null;
  fxdataComplete: boolean;

  dmxStartAddress: number;
  dmxUniverse: number | null;
  dmxMode: number | null;
  realtimeTimeoutMs: number | null;
  realtimeGammaDisabled: boolean | null;
  realtimeForcesMaxBri: boolean | null;
  realtimeOffset: number;
  deviceGamma: { bri: number; col: number; val: number } | null;

  warnings: DeviceWarning[];
}

/** Turn the raw endpoint responses into storable fields + warnings. */
export function analyzeSnapshot(snap: WledSnapshot): ImportedDevice {
  const { info, cfg } = snap;
  const cfgSummary = summarizeCfg(cfg);
  const warnings: DeviceWarning[] = [];

  const matrix = isMatrix(info) ? info.leds.matrix! : null;

  const { warnings: fxWarnings } = parseFxData(
    snap.fxdata,
    snap.effects,
    typeof info.fxcount === 'number' ? info.fxcount : undefined,
  );
  for (const w of fxWarnings) {
    warnings.push({ code: 'effect-count-mismatch', severity: 'warning', message: w });
  }

  // The DMX start address is managed by the app's patch planner now — the DMX
  // patch view surfaces any conflict or out-of-sync state, not a per-device
  // warning here.

  if (info.ws === WS_UNSUPPORTED) {
    warnings.push({
      code: 'ws-unsupported',
      severity: 'info',
      message: 'This build has no WebSocket support; live state will use HTTP polling.',
    });
  }

  if (snap.fxdata.length === 0) {
    warnings.push({
      code: 'fxdata-missing',
      severity: 'warning',
      message: '/json/fxdata was unavailable; effect controls fall back to generic sliders.',
    });
  } else if (!snap.fxdataComplete) {
    const known = snap.fxdata.filter(Boolean).length;
    warnings.push({
      code: 'fxdata-missing',
      severity: 'info',
      message:
        `The device truncated /json/fxdata (a known WLED/ESP32 quirk under load). ` +
        `Metadata for ~${known} of ${snap.fxdata.length} effects was recovered; the rest use ` +
        `generic controls. Use "Refresh effect metadata" to try again.`,
    });
  }
  if (!cfg) {
    warnings.push({
      code: 'cfg-missing',
      severity: 'warning',
      message: '/json/cfg was unavailable; DMX start address and gamma policy are unknown.',
    });
  }

  const fs = info.fs;
  if (fs && fs.t > 0 && fs.t - fs.u < 40) {
    warnings.push({
      code: 'fs-low',
      severity: 'info',
      message: `Only ${fs.t - fs.u} kB free on the device filesystem; GIF bakes may fail.`,
    });
  }

  return {
    mac: typeof info.mac === 'string' && info.mac ? info.mac.toLowerCase() : null,
    arch: info.arch ?? null,
    fwVersion: info.ver ?? null,
    name: typeof info.name === 'string' && info.name && info.name !== 'WLED' ? info.name : null,
    ledCount: typeof info.leds.count === 'number' ? info.leds.count : null,
    matrixW: matrix?.w ?? null,
    matrixH: matrix?.h ?? null,
    seglc: Array.isArray(info.leds.seglc) ? info.leds.seglc : null,
    lc: typeof info.leds.lc === 'number' ? info.leds.lc : null,
    fxcount: typeof info.fxcount === 'number' ? info.fxcount : null,
    palcount: typeof info.palcount === 'number' ? info.palcount : null,
    fsTotalKb: fs?.t ?? null,
    fsUsedKb: fs?.u ?? null,
    wsSupported: typeof info.ws === 'number' ? info.ws !== WS_UNSUPPORTED : null,
    fxdataComplete: snap.fxdataComplete,

    dmxStartAddress: cfgSummary.dmxStartAddress,
    dmxUniverse: cfgSummary.dmxUniverse,
    dmxMode: cfgSummary.dmxMode,
    realtimeTimeoutMs: cfgSummary.realtimeTimeoutMs,
    realtimeGammaDisabled: cfgSummary.realtimeGammaDisabled,
    realtimeForcesMaxBri: cfgSummary.realtimeForcesMaxBrightness,
    realtimeOffset: cfgSummary.realtimeOffset,
    deviceGamma: cfgSummary.gamma,

    warnings,
  };
}

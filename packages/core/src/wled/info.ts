/**
 * Types for `/json/info` — the read-only device description.
 *
 * Field set verified against a real WLED 16.0.0 (ESP32) dump — see
 * `packages/core/test/fixtures/wled-16.0.0-esp32/info.json`.
 * Everything is optional-friendly: firmware versions differ in what they report.
 */

export interface WledLedsInfo {
  /** Total configured LED count across all buses. */
  count: number;
  /** Estimated current draw, mA. */
  pwr: number;
  /** Actual render rate, frames/s. This is the backpressure signal. */
  fps: number;
  /** Configured max current, mA (0 = no limit). */
  maxpwr: number;
  /** Max number of segments this build supports. */
  maxseg: number;
  /** Preset loaded at boot. */
  bootps?: number;
  /**
   * Per-segment light-capability bytes, one entry per segment id up to the last
   * active segment. Bit 0 = RGB, bit 1 = white channel, bit 2 = CCT.
   * Value 0 = the segment has no bus in range.
   */
  seglc?: number[];
  /** Bitwise AND of every `seglc` entry. Do NOT use for per-segment gating. */
  lc?: number;
  /** Legacy global RGBW flag. Prefer `seglc`. */
  rgbw?: boolean;
  /** White-value UI hint: -1 none, 0 via colour picker, 1 slider, 2 both. */
  wv?: number;
  /** CCT UI hint: 0 hidden, 1 slider, 2 both. */
  cct?: number;
  /** Present only on 2D builds with a matrix configured. */
  matrix?: { w: number; h: number };
}

export interface WledWifiInfo {
  bssid?: string;
  rssi?: number;
  /** 0–100 signal quality. */
  signal?: number;
  channel?: number;
  ap?: boolean;
}

export interface WledFsInfo {
  /** Used space, **kilobytes**. */
  u: number;
  /** Total space, **kilobytes**. */
  t: number;
  /** Timestamp of last preset-file modification (epoch seconds), 0 if unknown. */
  pmt: number;
}

export interface WledInfo {
  /** Firmware version string, e.g. "16.0.0" or "0.14.4". */
  ver?: string;
  /** Numeric build id (roughly a date). */
  vid?: number;
  /** Release codename. */
  cn?: string;
  /** Build target label, e.g. "ESP32". */
  release?: string;
  leds: WledLedsInfo;
  /** True if the strip is a single string (no 2D). */
  str?: boolean;
  /** User-set device name. */
  name?: string;
  /** Legacy realtime UDP port (usually 21324). */
  udpport?: number;
  /** True while the device is showing realtime data. */
  live?: boolean;
  /** Segment currently receiving live data, or -1. */
  liveseg?: number;
  /** Source of the current live data ("", "UDP", "E1.31", "DDP", …). */
  lm?: string;
  /** IP of the live-data source. */
  lip?: string;
  /**
   * Current WebSocket client count. **-1 on builds without WS support** —
   * fall back to HTTP polling when this is -1.
   */
  ws?: number;
  /** Number of effects. `/json/eff` and `/json/fxdata` have this length. */
  fxcount?: number;
  /** Number of palettes. */
  palcount?: number;
  /** Custom palette count. */
  cpalcount?: number;
  /** Available ledmaps, newer firmware. Older firmware uses `leds.maps`. */
  maps?: Array<{ id: number; n?: string }>;
  wifi?: WledWifiInfo;
  fs?: WledFsInfo;
  /** Discovered node count, or -1 if node discovery is disabled. */
  ndc?: number;
  /** MCU family: "esp32", "esp8266", "esp32-s2", "esp32-s3", "esp32-c3", … */
  arch?: string;
  /** Arduino core version. */
  core?: string;
  /** Free heap, bytes. Health signal. */
  freeheap?: number;
  /** Uptime, seconds. */
  uptime?: number;
  time?: string;
  /** Feature bitfield. */
  opt?: number;
  brand?: string;
  product?: string;
  /** MAC, lowercase hex, no separators. Stable device identity. */
  mac?: string;
  ip?: string;
  /** Usermod data. May contain HTML strings — never render as markup. */
  u?: Record<string, unknown>;
}

/** Extract available ledmap ids from either the new or legacy location. */
export function ledmapIds(info: WledInfo): number[] {
  const maps = info.maps ?? (info.leds as { maps?: Array<{ id: number }> }).maps;
  if (!Array.isArray(maps)) return [0];
  return maps.map((m) => m.id).sort((a, b) => a - b);
}

/** True when the device reports a 2D matrix. */
export function isMatrix(info: WledInfo): boolean {
  return !!info.leds.matrix && info.leds.matrix.w > 0 && info.leds.matrix.h > 0;
}

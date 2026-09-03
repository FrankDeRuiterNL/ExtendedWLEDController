/**
 * Types for the WLED HTTP JSON API `state` object (`/json/state`).
 *
 * These mirror the fields listed as "verified against firmware source" in the
 * build spec. Every field is optional: we only ever send partial `state`
 * objects, and the device only echoes the fields it knows about.
 *
 * IMPORTANT: this is the *device-side* model. Realtime streaming (DDP) addresses
 * raw LED indices across the whole strip and ignores segments entirely. Keep the
 * two models apart — see `packages/core/src/mapping` (milestone 3).
 */

/** An RGB or RGBW colour as WLED accepts it in `seg.col`. */
export type WledColor =
  | [number, number, number]
  | [number, number, number, number]
  | string; // hex, e.g. "FF0000" or "FF0000AA"

/**
 * Increment expressions WLED accepts on numeric fields: `~`, `~-`, `~10`,
 * `~-10`. `fx`/`pal` additionally accept `"r"`, `"5~10r"`; `ps` accepts `"1~6~"`.
 * We keep these as opaque strings — the device evaluates them.
 */
export type WledNumberOrExpr = number | string;

export interface WledSegment {
  id?: number;
  /** Inclusive start LED index (segment-relative to the strip). */
  start?: number;
  /** Exclusive stop LED index. `stop:0` deletes the segment. */
  stop?: number;
  startY?: number;
  stopY?: number;
  len?: number;
  /** Grouping: repeat each virtual pixel this many times. */
  grp?: number;
  /** Spacing: blank pixels between groups. */
  spc?: number;
  /** Offset: rotate the segment's output by this many LEDs. */
  of?: number;
  on?: boolean;
  /** Freeze — stop the effect from advancing (used with live paint via `i`). */
  frz?: boolean;
  bri?: number;
  /**
   * Correlated colour temperature. Accepts 0–255 *relative* (0 warmest,
   * 255 coldest) OR 1900–10091 as Kelvin. Echo back whichever range the device
   * reported — see `cctIsKelvin()`. CCT is per-segment only, never per-pixel.
   */
  cct?: number;
  col?: WledColor[];
  fx?: WledNumberOrExpr;
  /** Effect speed 0–255. */
  sx?: number;
  /** Effect intensity 0–255. */
  ix?: number;
  /** Custom slider 1, 0–255. */
  c1?: number;
  /** Custom slider 2, 0–255. */
  c2?: number;
  /** Custom slider 3, 0–31 (5-bit). */
  c3?: number;
  o1?: boolean;
  o2?: boolean;
  o3?: boolean;
  pal?: WledNumberOrExpr;
  /** Palette blend/selection index for auto-palettes. */
  sel?: boolean;
  rev?: boolean;
  rY?: boolean;
  mi?: boolean;
  mY?: boolean;
  /** Transpose (2D). */
  tp?: boolean;
  n?: string;
  /** Expand 1D→2D: 0 Pixels, 1 Bar, 2 Arc, 3 Corner. */
  m12?: 0 | 1 | 2 | 3;
  /** Sound-sim mode. */
  si?: 0 | 1 | 2 | 3;
  /**
   * Individual LED paint. NEVER persisted — freezes the segment, lost on
   * power-off, not stored in presets. Live tool only. See spec "Baking".
   */
  i?: Array<number | WledColor> | WledColor[];
  fxdef?: boolean;
  set?: 0 | 1 | 2 | 3;
}

export interface WledNightlight {
  on?: boolean;
  /** Duration in minutes. */
  dur?: number;
  /** 0 instant, 1 fade, 2 colour fade, 3 sunrise. */
  mode?: 0 | 1 | 2 | 3;
  /** Target brightness. */
  tbri?: number;
  /** Remaining seconds (read-only). */
  rem?: number;
}

export interface WledUdpSync {
  send?: boolean;
  recv?: boolean;
  sgrp?: number;
  rgrp?: number;
  /** Send a one-off "no notification" broadcast. */
  nn?: boolean;
}

export interface WledPlaylist {
  /** Preset ids. */
  ps: number[];
  /** Per-entry duration, **tenths of a second**. */
  dur: number[];
  /** Per-entry transition, 100ms units (scalar applies to all). */
  transition?: number[] | number;
  /** Times to repeat; 0 = loop forever. */
  repeat?: number;
  /** Preset to apply when the playlist ends. */
  end?: number;
}

export interface WledState {
  /** `true`/`false`, or `"t"` to toggle. */
  on?: boolean | 't';
  /** Global brightness 1–255. Never report 0 — use `on:false`. */
  bri?: number;
  /** Crossfade duration, units of 100 ms. */
  transition?: number;
  /** Transition for this call only, units of 100 ms. */
  tt?: number;
  /** Preset to load, 1–250. Also accepts `"1~6~"` cycle expressions. */
  ps?: WledNumberOrExpr;
  /** Save current state to this preset slot, 1–250. */
  psave?: number;
  /** Delete this preset slot. */
  pdel?: number;
  /** With `psave`: also store segment bounds. */
  sb?: boolean;
  /** With `psave`: also store segment brightness. */
  ib?: boolean;
  /** With `psave`: also store segment selection. */
  sc?: boolean;
  /** Active playlist id, or -1. */
  pl?: number;
  nl?: WledNightlight;
  udpn?: WledUdpSync;
  /** `true` enters realtime mode and blanks LEDs; send `false` when done. */
  live?: boolean;
  /** Live override: 0 off, 1 until live data ends, 2 until reboot. */
  lor?: 0 | 1 | 2;
  /** Main segment id. */
  mainseg?: number;
  seg?: WledSegment[];
  playlist?: WledPlaylist;
  /** Load ledmap 0–9 (`ledmap.json` / `ledmap1..9.json`). */
  ledmap?: number;
  /** Remove custom palette. */
  rmcpal?: boolean;
  /** Effect timebase. */
  tb?: number;
  /** Transition speed for `tb`. */
  time?: number;
}

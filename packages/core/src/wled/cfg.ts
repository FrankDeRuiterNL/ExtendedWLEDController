/**
 * Types and extractors for `/json/cfg`.
 *
 * `cfg` is huge and firmware-dependent. We type only the slices milestone 1
 * needs and treat the rest as opaque. Verified against
 * `packages/core/test/fixtures/wled-16.0.0-esp32/cfg.json`.
 */

export interface WledCfgDmx {
  /** E1.31 / Art-Net universe. */
  uni?: number;
  /**
   * **DMX start address** (a.k.a. E1.31 start channel offset).
   *
   * WLED's DDP handler adds this to every computed pixel index. A non-zero
   * value silently shifts the whole strip. Read it here; compensate or warn.
   * On the reference device this is `1`.
   */
  addr?: number;
  /** DMX mode (0 disabled, 1 single RGB, 2 single DRGB, 3 effect, 4 multi RGB, …). */
  mode?: number;
  seqskip?: boolean;
  e131prio?: number;
  dss?: number;
}

export interface WledCfgLive {
  /** Realtime input enabled. */
  en?: boolean;
  /** Main-segment-only realtime. */
  mso?: boolean;
  /** "Realtime last mode" — return to last mode instead of blanking on timeout. */
  rlm?: boolean;
  /** E1.31 / Art-Net listen port. */
  port?: number;
  /** Multicast E1.31. */
  mc?: boolean;
  dmx?: WledCfgDmx;
  /** Realtime timeout, **units of 100 ms**. Device reverts after this idle gap. */
  timeout?: number;
  /** Force max brightness for realtime data. */
  maxbri?: boolean;
  /**
   * `true` = do NOT gamma-correct incoming realtime data.
   * This is the field that decides whether our renderer must pre-gamma.
   */
  'no-gc'?: boolean;
  /** Global realtime LED offset. */
  offset?: number;
}

export interface WledCfgGammaCurves {
  /** Gamma exponent applied to brightness (1 = linear). */
  bri?: number;
  /** Gamma exponent applied to per-channel colour. */
  col?: number;
  /** Gamma exponent applied to value. */
  val?: number;
}

export interface WledCfgLedBus {
  start?: number;
  len?: number;
  pin?: number[];
  order?: number;
  rev?: boolean;
  skip?: number;
  /** Bus type id (WLED `TYPE_*`). */
  type?: number;
  /** Per-bus RGBW mode. */
  rgbwm?: number;
  freq?: number;
  maxpwr?: number;
  /** mA per LED. */
  ledma?: number;
}

export interface WledCfg {
  rev?: number[];
  vid?: number;
  id?: { mdns?: string; name?: string; inv?: string; sui?: boolean };
  hw?: {
    led?: {
      total?: number;
      maxpwr?: number;
      cct?: boolean;
      fps?: number;
      rgbwm?: number;
      ins?: WledCfgLedBus[];
    };
  };
  light?: {
    'scale-bri'?: number;
    'pal-mode'?: number;
    /** Gamma correction curves. */
    gc?: WledCfgGammaCurves;
    tr?: { dur?: number; rpc?: number; hrp?: boolean };
  };
  def?: { ps?: number; on?: boolean; bri?: number };
  if?: {
    live?: WledCfgLive;
    nodes?: { list?: boolean; bcast?: boolean };
  };
}

/**
 * The subset of `cfg` we persist per device and act on. Everything here is
 * derived defensively so a firmware that moves a field doesn't crash the import.
 */
export interface DeviceCfgSummary {
  /** `if.live.dmx.addr`. Non-zero shifts realtime pixels — surface a warning. */
  dmxStartAddress: number;
  /** `if.live.dmx.uni`. */
  dmxUniverse: number | null;
  /** `if.live.dmx.mode`. */
  dmxMode: number | null;
  /** `if.live.timeout` in ms (converted from 100 ms units). */
  realtimeTimeoutMs: number | null;
  /** `if.live.no-gc` — true means the device will NOT gamma-correct our stream. */
  realtimeGammaDisabled: boolean | null;
  /** `if.live.maxbri` — true means the device forces brightness 255 for realtime. */
  realtimeForcesMaxBrightness: boolean | null;
  /** `if.live.offset` — additional global LED offset for realtime. */
  realtimeOffset: number;
  /** `light.gc` gamma exponents. */
  gamma: { bri: number; col: number; val: number } | null;
  /** `light.scale-bri` percent. */
  brightnessScalePercent: number | null;
  /** `id.mdns` hostname. */
  mdnsName: string | null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function summarizeCfg(cfg: WledCfg | null | undefined): DeviceCfgSummary {
  const live = cfg?.if?.live;
  const dmx = live?.dmx;
  const gc = cfg?.light?.gc;
  const timeout100ms = num(live?.timeout);

  return {
    dmxStartAddress: num(dmx?.addr) ?? 0,
    dmxUniverse: num(dmx?.uni),
    dmxMode: num(dmx?.mode),
    realtimeTimeoutMs: timeout100ms === null ? null : timeout100ms * 100,
    realtimeGammaDisabled: typeof live?.['no-gc'] === 'boolean' ? live['no-gc'] : null,
    realtimeForcesMaxBrightness: typeof live?.maxbri === 'boolean' ? live.maxbri : null,
    realtimeOffset: num(live?.offset) ?? 0,
    gamma: gc
      ? { bri: num(gc.bri) ?? 1, col: num(gc.col) ?? 1, val: num(gc.val) ?? 1 }
      : null,
    brightnessScalePercent: num(cfg?.light?.['scale-bri']),
    mdnsName: typeof cfg?.id?.mdns === 'string' && cfg.id.mdns ? cfg.id.mdns : null,
  };
}

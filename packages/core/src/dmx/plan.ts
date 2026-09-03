/**
 * DMX / E1.31 patch planner.
 *
 * The app owns the DMX patch: when a device is added it is assigned a
 * conflict-free block of universes based on its LED count, and that assignment
 * is written to the device's `cfg.if.live.dmx` so lighting consoles / other
 * software addressing the same fixtures stay in sync.
 *
 * Project decisions (2026-09-03):
 * - Real E1.31/sACN patch (not just internal bookkeeping).
 * - "Boundary" packing: every device starts at **channel 1 of a fresh
 *   universe**; a device with more LEDs than fit in one universe spans
 *   consecutive universes.
 * - **170 RGB LEDs per universe** (510 channels; the E1.31 / WLED default).
 *
 * Because every managed device gets `addr = 1`, the DDP path sees a uniform
 * (possibly zero) pixel offset across all devices — the sender compensates once.
 */

export interface DmxPlanConfig {
  /** First universe number to allocate from. */
  baseUniverse: number;
  /** RGB LEDs per universe. E1.31 standard: 170 (510 channels). */
  ledsPerUniverseRgb: number;
  /** RGBW LEDs per universe. 512 / 4 = 128. */
  ledsPerUniverseRgbw: number;
  /**
   * `boundary` — each device starts at channel 1 of a fresh universe (readable,
   * wastes a little space). `packed` — devices sit back-to-back in a linear
   * channel space (compact, fixtures can straddle universe boundaries).
   */
  packing: 'boundary' | 'packed';
}

export const DEFAULT_DMX_PLAN_CONFIG: DmxPlanConfig = {
  baseUniverse: 1,
  ledsPerUniverseRgb: 170,
  ledsPerUniverseRgbw: 128,
  packing: 'boundary',
};

/** E1.31 universe ceiling (the protocol reserves 0 and 64000+). */
export const MAX_E131_UNIVERSE = 63999;

export type ChannelsPerLed = 3 | 4;

export interface DmxAllocation {
  /** First E1.31 universe this device occupies. */
  firstUniverse: number;
  /** Number of consecutive universes (>= 1). */
  universeCount: number;
  /** 1-based start channel within `firstUniverse` (1 for boundary packing). */
  startChannel: number;
  channelsPerLed: ChannelsPerLed;
  ledCount: number;
}

/** WLED `cfg.if.live.dmx.mode` values. */
export const DMX_MODE_MULTI_RGB = 4;
export const DMX_MODE_MULTI_RGBW = 6;

export interface DmxDeviceCfg {
  uni: number;
  addr: number;
  mode: number;
}

/** The `if.live.dmx` values to write for an allocation. */
export function allocationToDeviceCfg(a: DmxAllocation): DmxDeviceCfg {
  return {
    uni: a.firstUniverse,
    addr: a.startChannel,
    mode: a.channelsPerLed === 4 ? DMX_MODE_MULTI_RGBW : DMX_MODE_MULTI_RGB,
  };
}

function ledsPerUniverse(cpl: ChannelsPerLed, config: DmxPlanConfig): number {
  return cpl === 4 ? config.ledsPerUniverseRgbw : config.ledsPerUniverseRgb;
}

/** Universe span a device needs under the given config. */
export function universeSpan(ledCount: number, cpl: ChannelsPerLed, config: DmxPlanConfig): number {
  return Math.max(1, Math.ceil(Math.max(0, ledCount) / ledsPerUniverse(cpl, config)));
}

/** Inclusive `[first, last]` universe range of an allocation. */
export function allocationRange(a: DmxAllocation): [number, number] {
  return [a.firstUniverse, a.firstUniverse + a.universeCount - 1];
}

export interface PlanDmxOptions {
  ledCount: number;
  channelsPerLed: ChannelsPerLed;
  /** Allocations already in use by other devices. */
  existing: readonly DmxAllocation[];
  config?: DmxPlanConfig;
  /** Prefer this first universe if it's free (e.g. keep a device's current one). */
  preferFirstUniverse?: number;
}

/**
 * Assign a conflict-free allocation. First-fit: fills the lowest gap that fits,
 * so removing and re-adding a device keeps the patch compact.
 */
export function planDmxAllocation(opts: PlanDmxOptions): DmxAllocation {
  const config = opts.config ?? DEFAULT_DMX_PLAN_CONFIG;
  const cpl = opts.channelsPerLed;
  const span = universeSpan(opts.ledCount, cpl, config);

  const occupied = [...opts.existing]
    .map(allocationRange)
    .sort((a, b) => a[0] - b[0]);

  const fits = (start: number): boolean => {
    const end = start + span - 1;
    if (end > MAX_E131_UNIVERSE) return false;
    return !occupied.some(([lo, hi]) => start <= hi && end >= lo);
  };

  const mk = (firstUniverse: number): DmxAllocation => ({
    firstUniverse,
    universeCount: span,
    startChannel: 1,
    channelsPerLed: cpl,
    ledCount: Math.max(0, opts.ledCount),
  });

  if (opts.preferFirstUniverse !== undefined && opts.preferFirstUniverse >= config.baseUniverse && fits(opts.preferFirstUniverse)) {
    return mk(opts.preferFirstUniverse);
  }

  // Walk gaps from baseUniverse upward.
  let candidate = config.baseUniverse;
  for (const [lo, hi] of occupied) {
    if (candidate + span - 1 < lo) break; // fits before this block
    if (candidate <= hi) candidate = hi + 1; // overlap → jump past
  }
  if (!fits(candidate)) {
    throw new RangeError(`No free universe block of size ${span} below ${MAX_E131_UNIVERSE}`);
  }
  return mk(candidate);
}

export interface PatchEntry {
  deviceId: number;
  name: string;
  allocation: DmxAllocation;
}

export interface PatchConflict {
  a: PatchEntry;
  b: PatchEntry;
  universes: [number, number];
}

/** Find overlapping universe ranges across a whole plan. */
export function findPatchConflicts(entries: readonly PatchEntry[]): PatchConflict[] {
  const sorted = [...entries].sort((x, y) => x.allocation.firstUniverse - y.allocation.firstUniverse);
  const conflicts: PatchConflict[] = [];
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const [aLo, aHi] = allocationRange(sorted[i]!.allocation);
      const [bLo, bHi] = allocationRange(sorted[j]!.allocation);
      if (bLo > aHi) break;
      conflicts.push({
        a: sorted[i]!,
        b: sorted[j]!,
        universes: [Math.max(aLo, bLo), Math.min(aHi, bHi)],
      });
    }
  }
  return conflicts;
}

/**
 * Re-plan an entire patch from scratch in a stable order (by device id), so the
 * result is deterministic and gap-free. Used when the user asks to "tidy" the
 * patch or changes the config.
 */
export function replanPatch(
  devices: ReadonlyArray<{ deviceId: number; name: string; ledCount: number; channelsPerLed: ChannelsPerLed }>,
  config: DmxPlanConfig = DEFAULT_DMX_PLAN_CONFIG,
): PatchEntry[] {
  const ordered = [...devices].sort((a, b) => a.deviceId - b.deviceId);
  const out: PatchEntry[] = [];
  for (const d of ordered) {
    const allocation = planDmxAllocation({
      ledCount: d.ledCount,
      channelsPerLed: d.channelsPerLed,
      existing: out.map((e) => e.allocation),
      config,
    });
    out.push({ deviceId: d.deviceId, name: d.name, allocation });
  }
  return out;
}

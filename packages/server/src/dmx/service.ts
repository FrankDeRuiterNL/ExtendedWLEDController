import {
  DEFAULT_DMX_PLAN_CONFIG,
  allocationToDeviceCfg,
  decodeCapabilities,
  findPatchConflicts,
  planDmxAllocation,
  replanPatch,
  type ChannelsPerLed,
  type DmxAllocation,
  type DmxPatchDTO,
  type DmxPatchEntryDTO,
  type DmxPlanConfig,
  type PatchEntry,
} from '@ewc/core';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { SettingsStore } from '../db/settings.js';
import { log } from '../logger.js';
import { WledHttpError, postCfg, type WledEndpoint } from '../wled/httpClient.js';
import { DeviceRepo, type DeviceRow } from '../devices/repo.js';

const SETTINGS_KEY = 'dmxPlanConfig';

interface StoredPlan {
  allocation: DmxAllocation;
  writeError?: string | null;
}

/**
 * Owns the DMX / E1.31 patch. On device add (and on demand) it assigns a
 * conflict-free universe block and writes it to the device's
 * `cfg.if.live.dmx` — see `packages/core/src/dmx/plan.ts` for the model.
 */
export class DmxService {
  private readonly repo: DeviceRepo;
  private readonly settings: SettingsStore;

  constructor(
    db: Db,
    private readonly config: Config,
  ) {
    this.repo = new DeviceRepo(db);
    this.settings = new SettingsStore(db);
  }

  getConfig(): DmxPlanConfig {
    return { ...DEFAULT_DMX_PLAN_CONFIG, ...this.settings.get<Partial<DmxPlanConfig>>(SETTINGS_KEY, {}) };
  }

  setConfig(patch: Partial<DmxPlanConfig>): DmxPlanConfig {
    const next = { ...this.getConfig(), ...patch };
    this.settings.set(SETTINGS_KEY, next);
    return next;
  }

  private endpoint(row: DeviceRow): WledEndpoint {
    return { host: row.host, port: row.port, timeoutMs: this.config.wledHttpTimeoutMs };
  }

  private channelsPerLed(row: DeviceRow): ChannelsPerLed {
    const seglc = safeParse<number[]>(row.seglc_json) ?? [];
    const raw = seglc.length ? seglc.reduce((a, b) => a | (b ?? 0), 0) : (row.lc ?? 1);
    return decodeCapabilities(raw).white ? 4 : 3;
  }

  private storedPlan(row: DeviceRow): StoredPlan | null {
    return safeParse<StoredPlan>(row.dmx_plan_json);
  }

  private existingAllocations(exceptId?: number): DmxAllocation[] {
    return this.repo
      .list()
      .filter((r) => r.dmx_managed !== 0 && r.id !== exceptId)
      .map((r) => this.storedPlan(r)?.allocation)
      .filter((a): a is DmxAllocation => a != null);
  }

  /**
   * Plan an allocation for a device and write it to the hardware. Idempotent:
   * keeps the device's current universe if it's still free.
   */
  async assign(deviceId: number): Promise<DmxAllocation> {
    const row = this.repo.get(deviceId);
    if (!row) throw new Error(`no device ${deviceId}`);
    if (row.dmx_managed === 0) throw new Error(`device ${deviceId} is not app-managed`);

    const cpl = this.channelsPerLed(row);
    const current = this.storedPlan(row)?.allocation;
    const allocation = planDmxAllocation({
      ledCount: row.led_count ?? 0,
      channelsPerLed: cpl,
      existing: this.existingAllocations(deviceId),
      config: this.getConfig(),
      ...(current ? { preferFirstUniverse: current.firstUniverse } : {}),
    });

    const writeError = await this.write(row, allocation);
    this.repo.setDmxPlan(deviceId, { allocation, writeError } satisfies StoredPlan, true);
    return allocation;
  }

  private async write(row: DeviceRow, allocation: DmxAllocation): Promise<string | null> {
    const dmx = allocationToDeviceCfg(allocation);
    try {
      await postCfg(this.endpoint(row), { if: { live: { en: true, dmx } } });
      log.info(`dmx: device ${row.id} → universe ${dmx.uni} addr ${dmx.addr} mode ${dmx.mode}`);
      // Reflect the write in the M1 columns too.
      this.repo.applyDmxWrite(row.id, dmx.uni, dmx.addr, dmx.mode);
      return null;
    } catch (err) {
      const msg = err instanceof WledHttpError ? err.message : (err as Error).message;
      log.warn(`dmx: could not write patch to device ${row.id}`, { err: msg });
      return msg;
    }
  }

  /** Set the managed flag; when turning off, the app stops touching the address. */
  setManaged(deviceId: number, managed: boolean): void {
    const row = this.repo.get(deviceId);
    if (!row) throw new Error(`no device ${deviceId}`);
    this.repo.setDmxPlan(deviceId, this.storedPlan(row), managed);
  }

  /** Re-plan the whole patch from scratch and push every managed device. */
  async replanAll(): Promise<PatchEntry[]> {
    const managed = this.repo.list().filter((r) => r.dmx_managed !== 0 && r.led_count);
    const patch = replanPatch(
      managed.map((r) => ({
        deviceId: r.id,
        name: r.name,
        ledCount: r.led_count ?? 0,
        channelsPerLed: this.channelsPerLed(r),
      })),
      this.getConfig(),
    );
    for (const entry of patch) {
      const row = managed.find((r) => r.id === entry.deviceId)!;
      const writeError = await this.write(row, entry.allocation);
      this.repo.setDmxPlan(entry.deviceId, { allocation: entry.allocation, writeError }, true);
    }
    return patch;
  }

  patch(): DmxPatchDTO {
    const rows = this.repo.list();
    const entries: DmxPatchEntryDTO[] = rows.map((r) => {
      const stored = this.storedPlan(r);
      const allocation = stored?.allocation ?? null;
      const reports = {
        universe: r.dmx_universe,
        startAddress: r.dmx_start_address,
        mode: r.dmx_mode,
      };
      const inSync =
        !!allocation &&
        reports.universe === allocation.firstUniverse &&
        reports.startAddress === allocation.startChannel;
      return {
        deviceId: r.id,
        name: r.name,
        ledCount: r.led_count,
        managed: r.dmx_managed !== 0,
        allocation,
        deviceReports: reports,
        inSync,
        writeError: stored?.writeError ?? null,
      };
    });

    const patchEntries: PatchEntry[] = entries
      .filter((e) => e.allocation)
      .map((e) => ({ deviceId: e.deviceId, name: e.name, allocation: e.allocation! }));
    const conflicts = findPatchConflicts(patchEntries).map((c) => ({
      deviceIdA: c.a.deviceId,
      deviceIdB: c.b.deviceId,
      nameA: c.a.name,
      nameB: c.b.name,
      universes: c.universes,
    }));

    const highestUniverse = patchEntries.reduce(
      (max, e) => Math.max(max, e.allocation.firstUniverse + e.allocation.universeCount - 1),
      0,
    );

    return { config: this.getConfig(), entries, conflicts, highestUniverse };
  }
}

function safeParse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

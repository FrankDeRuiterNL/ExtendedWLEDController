import {
  DEFAULT_BRIGHTNESS_POLICY,
  decodeCapabilities,
  parseFxData,
  type BrightnessPolicy,
  type DeviceConnectionStatus,
  type DeviceDetailDTO,
  type DeviceHealthDTO,
  type DeviceSummaryDTO,
  type DeviceWarning,
  type LinkType,
  type WledState,
} from '@ewc/core';
import type { Db } from '../db/index.js';
import type { ImportedDevice } from '../wled/import.js';

export interface DeviceRow {
  id: number;
  name: string;
  host: string;
  port: number;
  mac: string | null;
  link_type: string;
  enabled: number;
  arch: string | null;
  fw_version: string | null;
  eth_speed_mbps: number | null;
  led_count: number | null;
  matrix_w: number | null;
  matrix_h: number | null;
  seglc_json: string | null;
  lc: number | null;
  fxcount: number | null;
  palcount: number | null;
  fs_total_kb: number | null;
  fs_used_kb: number | null;
  ws_supported: number | null;
  fxdata_complete: number;
  warnings_json: string;
  dmx_start_address: number;
  dmx_universe: number | null;
  dmx_mode: number | null;
  realtime_timeout_ms: number | null;
  realtime_gamma_disabled: number | null;
  realtime_forces_max_bri: number | null;
  realtime_offset: number;
  dmx_plan_json: string | null;
  dmx_managed: number;
  brightness_policy_json: string;
  device_gamma_json: string | null;
  raw_info_json: string | null;
  raw_state_json: string | null;
  raw_cfg_json: string | null;
  raw_eff_json: string | null;
  raw_pal_json: string | null;
  raw_fxdata_json: string | null;
  last_import_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface HealthRow {
  device_id: number;
  online: number;
  last_seen_at: string | null;
  last_error: string | null;
  fps: number | null;
  freeheap: number | null;
  wifi_signal: number | null;
  uptime_s: number | null;
  live: number | null;
  ws_clients: number | null;
  checked_at: string | null;
}

const bool = (n: number | null | undefined): boolean | null =>
  n === null || n === undefined ? null : n !== 0;

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

// --- Raw persisted payloads (for re-parse) --------------------------------

export interface RawPayloads {
  info?: unknown;
  cfg?: unknown;
  effects?: string[];
  palettes?: string[];
  fxdata?: string[];
  state?: WledState;
}

// --- Queries -------------------------------------------------------------

export class DeviceRepo {
  constructor(private readonly db: Db) {}

  findByHostPort(host: string, port: number): DeviceRow | undefined {
    return this.db
      .prepare('SELECT * FROM devices WHERE host = ? AND port = ?')
      .get(host, port) as DeviceRow | undefined;
  }

  findByMac(mac: string): DeviceRow | undefined {
    return this.db.prepare('SELECT * FROM devices WHERE mac = ?').get(mac) as DeviceRow | undefined;
  }

  get(id: number): DeviceRow | undefined {
    return this.db.prepare('SELECT * FROM devices WHERE id = ?').get(id) as DeviceRow | undefined;
  }

  list(): DeviceRow[] {
    return this.db.prepare('SELECT * FROM devices ORDER BY name, id').all() as DeviceRow[];
  }

  health(id: number): HealthRow | undefined {
    return this.db
      .prepare('SELECT * FROM device_health WHERE device_id = ?')
      .get(id) as HealthRow | undefined;
  }

  create(input: {
    name: string;
    host: string;
    port: number;
    linkType: LinkType;
  }): number {
    const info = this.db
      .prepare('INSERT INTO devices (name, host, port, link_type) VALUES (?, ?, ?, ?)')
      .run(input.name, input.host, input.port, input.linkType);
    const id = Number(info.lastInsertRowid);
    this.db.prepare('INSERT INTO device_health (device_id) VALUES (?)').run(id);
    return id;
  }

  delete(id: number): boolean {
    return this.db.prepare('DELETE FROM devices WHERE id = ?').run(id).changes > 0;
  }

  updateMeta(
    id: number,
    patch: {
      name?: string;
      linkType?: LinkType;
      enabled?: boolean;
      brightnessPolicy?: BrightnessPolicy;
      ethSpeedMbps?: number | null;
    },
  ): void {
    const sets: string[] = [];
    const args: unknown[] = [];
    if (patch.name !== undefined) (sets.push('name = ?'), args.push(patch.name));
    if (patch.linkType !== undefined) (sets.push('link_type = ?'), args.push(patch.linkType));
    if (patch.enabled !== undefined) (sets.push('enabled = ?'), args.push(patch.enabled ? 1 : 0));
    if (patch.ethSpeedMbps !== undefined)
      (sets.push('eth_speed_mbps = ?'), args.push(patch.ethSpeedMbps));
    if (patch.brightnessPolicy !== undefined)
      (sets.push('brightness_policy_json = ?'), args.push(JSON.stringify(patch.brightnessPolicy)));
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    args.push(id);
    this.db.prepare(`UPDATE devices SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  }

  /** Store an import snapshot: capability fields, realtime prep, raw payloads. */
  applyImport(
    id: number,
    imported: ImportedDevice,
    raw: { info: unknown; cfg: unknown; effects: string[]; palettes: string[]; fxdata: string[]; state: WledState },
  ): void {
    this.db
      .prepare(
        `UPDATE devices SET
           mac = COALESCE(?, mac),
           arch = ?, fw_version = ?,
           name = CASE WHEN name = 'WLED' AND ? IS NOT NULL THEN ? ELSE name END,
           led_count = ?, matrix_w = ?, matrix_h = ?,
           seglc_json = ?, lc = ?, fxcount = ?, palcount = ?,
           fs_total_kb = ?, fs_used_kb = ?, ws_supported = ?,
           fxdata_complete = ?, warnings_json = ?,
           dmx_start_address = ?, dmx_universe = ?, dmx_mode = ?,
           realtime_timeout_ms = ?, realtime_gamma_disabled = ?, realtime_forces_max_bri = ?,
           realtime_offset = ?, device_gamma_json = ?,
           raw_info_json = ?, raw_state_json = ?, raw_cfg_json = ?, raw_eff_json = ?, raw_pal_json = ?, raw_fxdata_json = ?,
           last_import_at = datetime('now'), updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(
        imported.mac,
        imported.arch,
        imported.fwVersion,
        imported.name,
        imported.name,
        imported.ledCount,
        imported.matrixW,
        imported.matrixH,
        imported.seglc ? JSON.stringify(imported.seglc) : null,
        imported.lc,
        imported.fxcount,
        imported.palcount,
        imported.fsTotalKb,
        imported.fsUsedKb,
        imported.wsSupported === null ? null : imported.wsSupported ? 1 : 0,
        imported.fxdataComplete ? 1 : 0,
        JSON.stringify(imported.warnings),
        imported.dmxStartAddress,
        imported.dmxUniverse,
        imported.dmxMode,
        imported.realtimeTimeoutMs,
        imported.realtimeGammaDisabled === null ? null : imported.realtimeGammaDisabled ? 1 : 0,
        imported.realtimeForcesMaxBri === null ? null : imported.realtimeForcesMaxBri ? 1 : 0,
        imported.realtimeOffset,
        imported.deviceGamma ? JSON.stringify(imported.deviceGamma) : null,
        JSON.stringify(raw.info),
        JSON.stringify(raw.state),
        raw.cfg === null ? null : JSON.stringify(raw.cfg),
        JSON.stringify(raw.effects),
        JSON.stringify(raw.palettes),
        JSON.stringify(raw.fxdata),
        id,
      );
  }

  /**
   * Record health. Metric fields (`fps`, `freeheap`, …) use COALESCE, so a
   * partial call — e.g. just `{online:false, lastError}` after a failed write —
   * keeps the last-known values rather than wiping them.
   */
  recordHealth(id: number, h: Partial<DeviceHealthDTO> & { lastError?: string | null }): void {
    this.db
      .prepare(
        `UPDATE device_health SET
           online = ?, last_seen_at = COALESCE(?, last_seen_at), last_error = ?,
           fps = COALESCE(?, fps), freeheap = COALESCE(?, freeheap),
           wifi_signal = COALESCE(?, wifi_signal), uptime_s = COALESCE(?, uptime_s),
           live = COALESCE(?, live), ws_clients = COALESCE(?, ws_clients),
           checked_at = datetime('now')
         WHERE device_id = ?`,
      )
      .run(
        h.online ? 1 : 0,
        h.online ? new Date().toISOString() : null,
        h.lastError ?? null,
        h.fps ?? null,
        h.freeheap ?? null,
        h.wifiSignal ?? null,
        h.uptimeS ?? null,
        h.live === null || h.live === undefined ? null : h.live ? 1 : 0,
        h.wsClients ?? null,
        id,
      );
  }

  setDmxPlan(id: number, plan: unknown | null, managed: boolean): void {
    this.db
      .prepare(`UPDATE devices SET dmx_plan_json = ?, dmx_managed = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(plan === null ? null : JSON.stringify(plan), managed ? 1 : 0, id);
  }

  /** Reflect a DMX cfg write we made in the device-reported columns. */
  applyDmxWrite(id: number, universe: number, startAddress: number, mode: number): void {
    this.db
      .prepare(
        `UPDATE devices SET dmx_universe = ?, dmx_start_address = ?, dmx_mode = ?, updated_at = datetime('now') WHERE id = ?`,
      )
      .run(universe, startAddress, mode, id);
  }

  /** Refresh the cached device state (after a control write or a poll). */
  updateState(id: number, state: WledState): void {
    this.db
      .prepare(`UPDATE devices SET raw_state_json = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(JSON.stringify(state), id);
  }

  /** Replace just the fxdata payload after a targeted re-fetch. */
  updateFxData(id: number, fxdata: string[], complete: boolean, warnings: DeviceWarning[]): void {
    this.db
      .prepare(
        `UPDATE devices SET raw_fxdata_json = ?, fxdata_complete = ?, warnings_json = ?, updated_at = datetime('now') WHERE id = ?`,
      )
      .run(JSON.stringify(fxdata), complete ? 1 : 0, JSON.stringify(warnings), id);
  }

  rawPayloads(id: number): RawPayloads {
    const row = this.get(id);
    if (!row) return {};
    return {
      info: parseJson<unknown>(row.raw_info_json, undefined as unknown),
      cfg: parseJson<unknown>(row.raw_cfg_json, undefined as unknown),
      effects: parseJson<string[]>(row.raw_eff_json, []),
      palettes: parseJson<string[]>(row.raw_pal_json, []),
      fxdata: parseJson<string[]>(row.raw_fxdata_json, []),
      state: parseJson<WledState | undefined>(row.raw_state_json, undefined),
    };
  }
}

// --- Row → DTO ----------------------------------------------------------

export function healthToDTO(row: HealthRow | undefined): DeviceHealthDTO | null {
  if (!row) return null;
  return {
    online: row.online !== 0,
    lastSeenAt: row.last_seen_at,
    lastError: row.last_error,
    fps: row.fps,
    freeheap: row.freeheap,
    wifiSignal: row.wifi_signal,
    uptimeS: row.uptime_s,
    live: bool(row.live),
    wsClients: row.ws_clients,
    checkedAt: row.checked_at,
  };
}

/** Warnings for a device: the ones stored at import time, or a live re-derive. */
export function deviceWarnings(row: DeviceRow): DeviceWarning[] {
  const stored = parseJson<DeviceWarning[]>(row.warnings_json, []);
  if (stored.length > 0 || row.last_import_at) return stored;
  return deriveWarnings(row);
}

/** Fallback warning derivation for rows that have not completed an import yet. */
export function deriveWarnings(row: DeviceRow): DeviceWarning[] {
  const warnings: DeviceWarning[] = [];
  if (row.ws_supported === 0) {
    warnings.push({
      code: 'ws-unsupported',
      severity: 'info',
      message: 'No WebSocket support on this build; live state uses HTTP polling.',
    });
  }
  if (row.fs_total_kb !== null && row.fs_used_kb !== null && row.fs_total_kb - row.fs_used_kb < 40) {
    warnings.push({
      code: 'fs-low',
      severity: 'info',
      message: `Only ${row.fs_total_kb - row.fs_used_kb} kB free on the device filesystem.`,
    });
  }
  return warnings;
}

/**
 * Live values from the realtime hub, layered over the persisted row. When the
 * hub has a live connection its state/health/status are fresher than the DB.
 */
export interface LiveOverlay {
  connection?: DeviceConnectionStatus;
  state?: WledState | null;
  health?: DeviceHealthDTO | null;
}

function connectionFromRow(row: DeviceRow, health: HealthRow | undefined): DeviceConnectionStatus {
  if (row.enabled === 0) return 'offline';
  return health?.online ? 'polling' : 'offline';
}

export function rowToSummary(
  row: DeviceRow,
  health: HealthRow | undefined,
  live?: LiveOverlay,
): DeviceSummaryDTO {
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    port: row.port,
    mac: row.mac,
    linkType: (row.link_type as LinkType) ?? 'unknown',
    enabled: row.enabled !== 0,
    arch: row.arch,
    fwVersion: row.fw_version,
    ethSpeedMbps: row.eth_speed_mbps,
    ledCount: row.led_count,
    matrix: row.matrix_w && row.matrix_h ? { w: row.matrix_w, h: row.matrix_h } : null,
    fxcount: row.fxcount,
    palcount: row.palcount,
    wsSupported: bool(row.ws_supported),
    dmxStartAddress: row.dmx_start_address,
    warnings: deviceWarnings(row),
    health: live?.health ?? healthToDTO(health),
    connection: live?.connection ?? connectionFromRow(row, health),
    lastImportAt: row.last_import_at,
  };
}

export function rowToDetail(
  row: DeviceRow,
  health: HealthRow | undefined,
  live?: LiveOverlay,
): DeviceDetailDTO {
  const seglc = parseJson<number[] | null>(row.seglc_json, null);
  const capsRaw = Array.isArray(seglc) && seglc.length > 0
    ? seglc.reduce((a, b) => a | (b ?? 0), 0)
    : (row.lc ?? 1);
  const caps = decodeCapabilities(capsRaw);

  const effects = parseJson<string[]>(row.raw_eff_json, []);
  const fxdata = parseJson<string[]>(row.raw_fxdata_json, []);
  const { effects: parsedEffects } = parseFxData(fxdata, effects, row.fxcount ?? undefined);

  return {
    ...rowToSummary(row, health, live),
    seglc,
    lc: row.lc,
    capabilities: { rgb: caps.rgb, white: caps.white, cct: caps.cct, raw: caps.raw },
    fsTotalKb: row.fs_total_kb,
    fsUsedKb: row.fs_used_kb,
    brightnessPolicy: parseJson<BrightnessPolicy>(row.brightness_policy_json, DEFAULT_BRIGHTNESS_POLICY),
    deviceGamma: parseJson<{ bri: number; col: number; val: number } | null>(row.device_gamma_json, null),
    realtime: {
      timeoutMs: row.realtime_timeout_ms,
      gammaDisabled: bool(row.realtime_gamma_disabled),
      forcesMaxBrightness: bool(row.realtime_forces_max_bri),
      offset: row.realtime_offset,
      dmxUniverse: row.dmx_universe,
      dmxMode: row.dmx_mode,
    },
    effects: parsedEffects,
    fxdataComplete: row.fxdata_complete !== 0,
    palettes: parseJson<string[]>(row.raw_pal_json, []),
    state: live?.state ?? parseJson<WledState | null>(row.raw_state_json, null),
  };
}

import {
  looksLikeFullState,
  parseFxData,
  type AddDeviceRequest,
  type DeviceDetailDTO,
  type DeviceSummaryDTO,
  type DeviceWarning,
  type LinkType,
  type NodeImportCandidate,
  type UpdateDeviceRequest,
  type WledState,
} from '@ewc/core';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { log } from '../logger.js';
import {
  WledHttpError,
  fetchFxData,
  fetchNodes,
  fetchSnapshot,
  fetchState,
  postState,
  type WledEndpoint,
} from '../wled/httpClient.js';
import { analyzeSnapshot } from '../wled/import.js';
import type { DmxService } from '../dmx/service.js';
import type { RealtimeHub, RegistryDevice } from '../realtime/hub.js';
import { DeviceRepo, rowToDetail, rowToSummary, type DeviceRow } from './repo.js';

export class DeviceError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'DeviceError';
  }
}

const HOSTNAME_RE = /^(?:\[[0-9a-fA-F:]+\]|[a-zA-Z0-9._-]+)$/;

function normalizeHost(raw: string): string {
  let h = raw.trim();
  if (h === '') throw new DeviceError('Host is required', 400, 'invalid-host');
  // Accept a pasted URL and pull the host[:port] out of it.
  const m = /^https?:\/\/([^/]+)/i.exec(h);
  if (m) h = m[1]!;
  h = h.replace(/\/+$/, '');
  return h;
}

function splitHostPort(raw: string): { host: string; port: number } {
  const h = normalizeHost(raw);
  // IPv6 in brackets: [::1]:8080
  const v6 = /^\[([0-9a-fA-F:]+)\](?::(\d+))?$/.exec(h);
  if (v6) return { host: v6[1]!, port: v6[2] ? Number(v6[2]) : 80 };
  const parts = h.split(':');
  if (parts.length === 2 && /^\d+$/.test(parts[1]!)) {
    return { host: parts[0]!, port: Number(parts[1]) };
  }
  if (!HOSTNAME_RE.test(h)) throw new DeviceError(`Invalid host: ${raw}`, 400, 'invalid-host');
  return { host: h, port: 80 };
}

export class DeviceService {
  private readonly repo: DeviceRepo;

  constructor(
    db: Db,
    private readonly config: Config,
    private readonly hub: RealtimeHub,
    private readonly dmx: DmxService,
  ) {
    this.repo = new DeviceRepo(db);
  }

  /** Current registry shape for the realtime hub. */
  registrySnapshot(): RegistryDevice[] {
    return this.repo.list().map((r) => ({
      id: r.id,
      host: r.host,
      port: r.port,
      enabled: r.enabled !== 0,
      wsSupported: r.ws_supported === null ? null : r.ws_supported !== 0,
    }));
  }

  private syncHub(): Promise<void> {
    return this.hub.sync(this.registrySnapshot());
  }

  private endpoint(row: DeviceRow): WledEndpoint {
    return {
      host: row.host,
      port: row.port,
      timeoutMs: this.config.wledHttpTimeoutMs,
      bulkRetries: this.config.wledBulkRetries,
    };
  }

  list(): DeviceSummaryDTO[] {
    return this.repo.list().map((row) => rowToSummary(row, this.repo.health(row.id), this.hub.overlay(row.id)));
  }

  detail(id: number): DeviceDetailDTO {
    const row = this.requireRow(id);
    return rowToDetail(row, this.repo.health(row.id), this.hub.overlay(row.id));
  }

  private requireRow(id: number): DeviceRow {
    const row = this.repo.get(id);
    if (!row) throw new DeviceError(`No device ${id}`, 404, 'not-found');
    return row;
  }

  /** Add a device by IP/hostname, fetch its full snapshot, persist. */
  async add(req: AddDeviceRequest): Promise<DeviceDetailDTO> {
    const { host, port } = req.port
      ? { host: normalizeHost(req.host), port: req.port }
      : splitHostPort(req.host);

    const existing = this.repo.findByHostPort(host, port);
    if (existing) throw new DeviceError(`${host}:${port} is already registered`, 409, 'duplicate');

    const endpoint: WledEndpoint = {
      host,
      port,
      timeoutMs: this.config.wledHttpTimeoutMs,
      bulkRetries: this.config.wledBulkRetries,
    };
    const snap = await this.fetchOrThrow(endpoint);

    if (snap.info.mac) {
      const byMac = this.repo.findByMac(snap.info.mac.toLowerCase());
      if (byMac) {
        throw new DeviceError(
          `That device (MAC ${snap.info.mac}) is already registered as "${byMac.name}" at ${byMac.host}`,
          409,
          'duplicate-mac',
        );
      }
    }

    const analyzed = analyzeSnapshot(snap);
    const name = req.name?.trim() || analyzed.name || snap.info.name || host;
    const linkType: LinkType = req.linkType ?? 'unknown';

    const id = this.repo.create({ name, host, port, linkType });
    this.repo.applyImport(id, analyzed, {
      info: snap.info,
      state: snap.state,
      cfg: snap.cfg,
      effects: snap.effects,
      palettes: snap.palettes,
      fxdata: snap.fxdata,
    });
    this.repo.recordHealth(id, {
      online: true,
      fps: snap.info.leds?.fps ?? null,
      freeheap: snap.info.freeheap ?? null,
      wifiSignal: snap.info.wifi?.signal ?? null,
      uptimeS: snap.info.uptime ?? null,
      live: snap.info.live ?? null,
      wsClients: typeof snap.info.ws === 'number' ? snap.info.ws : null,
      lastError: null,
    });

    log.info(`added device "${name}"`, { host, port, mac: analyzed.mac, warnings: analyzed.warnings.length });

    // Assign this device a conflict-free DMX universe block and write it to the
    // hardware. Non-fatal — the DMX patch view surfaces any write failure.
    try {
      await this.dmx.assign(id);
    } catch (err) {
      log.warn(`could not assign DMX patch to device ${id}`, { err: String(err) });
    }

    await this.syncHub();
    return this.detail(id);
  }

  /** Re-fetch info/eff/pal/fxdata/cfg for an existing device. */
  async refresh(id: number): Promise<DeviceDetailDTO> {
    const row = this.requireRow(id);
    const snap = await this.fetchOrThrow(this.endpoint(row));
    const analyzed = analyzeSnapshot(snap);
    this.repo.applyImport(id, analyzed, {
      info: snap.info,
      state: snap.state,
      cfg: snap.cfg,
      effects: snap.effects,
      palettes: snap.palettes,
      fxdata: snap.fxdata,
    });
    this.repo.recordHealth(id, {
      online: true,
      fps: snap.info.leds?.fps ?? null,
      freeheap: snap.info.freeheap ?? null,
      wifiSignal: snap.info.wifi?.signal ?? null,
      uptimeS: snap.info.uptime ?? null,
      live: snap.info.live ?? null,
      wsClients: typeof snap.info.ws === 'number' ? snap.info.ws : null,
      lastError: null,
    });

    // The LED count may have changed (strip extended / shortened). Re-plan this
    // device's DMX block so its universe span — and every later device's — stays
    // correct. Non-fatal; the DMX patch view surfaces conflicts / write errors.
    if (row.dmx_managed !== 0) {
      try {
        await this.dmx.assign(id);
      } catch (err) {
        log.warn(`could not re-assign DMX patch to device ${id} after refresh`, { err: String(err) });
      }
    }

    await this.syncHub();
    return this.detail(id);
  }

  /** Re-fetch only `/json/fxdata`, hammering past device truncation. */
  async refreshFxData(id: number): Promise<DeviceDetailDTO> {
    const row = this.requireRow(id);
    const raw = this.repo.rawPayloads(id);
    const fxcount = (raw.info as { fxcount?: number } | undefined)?.fxcount;
    const fx = await fetchFxData(this.endpoint(row), fxcount);

    const { warnings: fxWarnings } = parseFxData(fx.fxdata, raw.effects ?? [], fxcount);
    const existing: DeviceWarning[] = JSON.parse(row.warnings_json || '[]');
    const warnings = existing.filter((w) => w.code !== 'fxdata-missing' && w.code !== 'effect-count-mismatch');
    for (const w of fxWarnings) warnings.push({ code: 'effect-count-mismatch', severity: 'warning', message: w });
    if (!fx.complete) {
      warnings.push({
        code: 'fxdata-missing',
        severity: 'info',
        message: `Still truncated after ${fx.attempts} tries; recovered ~${fx.fxdata.filter(Boolean).length} of ${fx.fxdata.length}.`,
      });
    }

    this.repo.updateFxData(id, fx.fxdata, fx.complete, warnings);
    log.info(`refreshed fxdata for device ${id}`, { complete: fx.complete, attempts: fx.attempts });
    return this.detail(id);
  }

  async update(id: number, patch: UpdateDeviceRequest): Promise<DeviceDetailDTO> {
    this.requireRow(id);
    this.repo.updateMeta(id, patch);
    if (patch.enabled !== undefined) await this.syncHub();
    return this.detail(id);
  }

  remove(id: number): void {
    this.requireRow(id);
    this.repo.delete(id);
    void this.syncHub();
    log.info(`removed device ${id}`);
  }

  /**
   * Send a PARTIAL state patch. Routed over the device's realtime WebSocket when
   * it's open (one connection, no extra client against the 8-client limit); HTTP
   * POST otherwise. Fire-and-forget — the device pushes the resulting state and
   * the hub fans it out.
   */
  async control(id: number, patch: WledState): Promise<{ ok: true }> {
    const row = this.requireRow(id);
    if (looksLikeFullState(patch)) {
      throw new DeviceError(
        'Payload looks like a full state object. Send field-level patches only.',
        400,
        'not-a-patch',
      );
    }

    const conn = this.hub.getConnection(id);
    try {
      if (conn) {
        await conn.sendPatch(patch);
      } else {
        await postState(this.endpoint(row), patch);
        try {
          this.repo.updateState(id, await fetchState(this.endpoint(row)));
        } catch {
          /* next poll catches up */
        }
      }
      return { ok: true };
    } catch (err) {
      if (err instanceof WledHttpError) {
        this.repo.recordHealth(id, { online: false, lastError: err.message });
        throw new DeviceError(`Device did not accept the update: ${err.message}`, 502, 'device-unreachable');
      }
      throw err;
    }
  }

  /** Ask a registered device which peers it has discovered (`/json/nodes`). */
  async discoverNodes(id: number): Promise<NodeImportCandidate[]> {
    const row = this.requireRow(id);
    let payload: Awaited<ReturnType<typeof fetchNodes>>;
    try {
      payload = await fetchNodes(this.endpoint(row));
    } catch (err) {
      throw new DeviceError(
        `Could not read /json/nodes from ${row.host}: ${(err as Error).message}`,
        502,
        'device-unreachable',
      );
    }

    const nodes = Array.isArray(payload.nodes) ? payload.nodes : [];
    const known = this.repo.list();
    const knownHosts = new Set(known.map((d) => d.host.toLowerCase()));
    const knownMacs = new Set(known.map((d) => d.mac?.toLowerCase()).filter(Boolean));

    const candidates: NodeImportCandidate[] = [];
    for (const node of nodes) {
      const ip = readIp(node['ip']);
      if (!ip) continue;
      const mac = typeof node['mac'] === 'string' ? node['mac'].toLowerCase() : null;
      if (ip === row.host) continue; // the device itself
      candidates.push({
        host: ip,
        name: typeof node['name'] === 'string' && node['name'] ? node['name'] : null,
        alreadyRegistered: knownHosts.has(ip.toLowerCase()) || (mac ? knownMacs.has(mac) : false),
      });
    }
    return candidates;
  }

  private async fetchOrThrow(endpoint: WledEndpoint) {
    try {
      return await fetchSnapshot(endpoint);
    } catch (err) {
      const message =
        err instanceof WledHttpError
          ? `Could not reach a WLED device at ${endpoint.host}:${endpoint.port} (${err.message})`
          : `Unexpected error contacting ${endpoint.host}: ${(err as Error).message}`;
      throw new DeviceError(message, 502, 'device-unreachable');
    }
  }
}

function readIp(value: unknown): string | null {
  if (typeof value === 'string' && value) return value;
  // WLED /json/nodes sometimes reports ip as a 4-int array.
  if (Array.isArray(value) && value.length === 4 && value.every((n) => typeof n === 'number')) {
    return value.join('.');
  }
  return null;
}

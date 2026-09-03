import { EventEmitter } from 'node:events';
import type {
  DeviceHealthDTO,
  DeviceRealtimeState,
  WledState,
} from '@ewc/core';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { log } from '../logger.js';
import { DeviceRepo, type LiveOverlay } from '../devices/repo.js';
import { DeviceConnection } from './deviceConnection.js';

export interface RegistryDevice {
  id: number;
  host: string;
  port: number;
  enabled: boolean;
  wsSupported: boolean | null;
}

type HubEvents = {
  state: [{ deviceId: number; state: WledState }];
  health: [{ deviceId: number; health: DeviceHealthDTO }];
  status: [{ deviceId: number; connection: DeviceRealtimeState['connection']; lastError: string | null }];
  devicesChanged: [];
};

const PERSIST_DEBOUNCE_MS = 5_000;

/**
 * Owns one {@link DeviceConnection} per enabled device, persists their state /
 * health to SQLite (debounced — the in-memory copy is authoritative, the row is
 * a warm-start cache), and re-emits their events for the browser hub.
 *
 * Replaces the old HTTP-only HealthPoller: a WebSocket build gets live pushes, a
 * `-D WLED_DISABLE_WEBSOCKET` build gets HTTP polling, both through the same
 * connection object.
 */
export class RealtimeHub extends EventEmitter<HubEvents> {
  private readonly repo: DeviceRepo;
  private readonly conns = new Map<number, DeviceConnection>();
  private readonly persistTimers = new Map<number, NodeJS.Timeout>();
  private readonly dirty = new Map<number, { state?: WledState; health?: DeviceHealthDTO }>();

  constructor(
    db: Db,
    private readonly config: Config,
  ) {
    super();
    this.repo = new DeviceRepo(db);
  }

  private syncChain: Promise<void> = Promise.resolve();

  /** Reconcile live connections with the registry. Serialised; safe to spam. */
  sync(devices: RegistryDevice[]): Promise<void> {
    this.syncChain = this.syncChain.then(() => this.doSync(devices)).catch((err) => {
      log.warn('realtime: sync failed', { err: String(err) });
    });
    return this.syncChain;
  }

  private async doSync(devices: RegistryDevice[]): Promise<void> {
    const wanted = new Map(devices.filter((d) => d.enabled).map((d) => [d.id, d]));

    // Drop connections for devices that are gone or disabled.
    for (const [id, conn] of this.conns) {
      if (!wanted.has(id)) {
        this.conns.delete(id);
        await conn.stop();
        this.flush(id);
        log.info(`realtime: dropped device ${id}`);
      }
    }

    // Add / replace.
    for (const d of wanted.values()) {
      const existing = this.conns.get(d.id);
      if (existing) continue; // host/port changes are rare; handled via remove+add elsewhere
      const conn = new DeviceConnection({
        id: d.id,
        host: d.host,
        port: d.port,
        wsSupported: d.wsSupported,
        httpTimeoutMs: this.config.wledHttpTimeoutMs,
        pollIntervalMs: this.config.healthPollIntervalMs,
      });
      this.wire(conn);
      this.conns.set(d.id, conn);
      conn.start();
      log.info(`realtime: connecting device ${d.id}`, { host: d.host, port: d.port });
    }

    this.emit('devicesChanged');
  }

  getConnection(id: number): DeviceConnection | undefined {
    return this.conns.get(id);
  }

  /** The live overlay for a device's DTO, or `undefined` if the hub has nothing. */
  overlay(id: number): LiveOverlay | undefined {
    const c = this.conns.get(id);
    if (!c) return undefined;
    return { connection: c.connection, state: c.state, health: c.health };
  }

  snapshot(): DeviceRealtimeState[] {
    return [...this.conns.entries()].map(([deviceId, c]) => ({
      deviceId,
      connection: c.connection,
      state: c.state,
      health: c.health,
      lastError: c.lastError,
    }));
  }

  async stop(): Promise<void> {
    await Promise.all([...this.conns.values()].map((c) => c.stop()));
    for (const id of this.persistTimers.keys()) this.flush(id);
    this.conns.clear();
  }

  // --- internals ------------------------------------------------------

  private wire(conn: DeviceConnection): void {
    conn.on('state', (state) => {
      this.queuePersist(conn.id, { state });
      this.emit('state', { deviceId: conn.id, state });
    });
    conn.on('health', (health) => {
      this.queuePersist(conn.id, { health });
      this.emit('health', { deviceId: conn.id, health });
    });
    conn.on('status', ({ connection, lastError }) => {
      if (connection === 'offline') {
        this.repo.recordHealth(conn.id, { online: false, lastError });
      }
      this.emit('status', { deviceId: conn.id, connection, lastError });
    });
  }

  private queuePersist(id: number, patch: { state?: WledState; health?: DeviceHealthDTO }): void {
    const cur = this.dirty.get(id) ?? {};
    this.dirty.set(id, { ...cur, ...patch });
    if (this.persistTimers.has(id)) return;
    const t = setTimeout(() => {
      this.persistTimers.delete(id);
      this.flush(id);
    }, PERSIST_DEBOUNCE_MS);
    t.unref();
    this.persistTimers.set(id, t);
  }

  private flush(id: number): void {
    const timer = this.persistTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.persistTimers.delete(id);
    }
    const patch = this.dirty.get(id);
    if (!patch) return;
    this.dirty.delete(id);
    try {
      if (patch.state) this.repo.updateState(id, patch.state);
      if (patch.health) {
        this.repo.recordHealth(id, {
          online: patch.health.online,
          fps: patch.health.fps,
          freeheap: patch.health.freeheap,
          wifiSignal: patch.health.wifiSignal,
          uptimeS: patch.health.uptimeS,
          live: patch.health.live,
          wsClients: patch.health.wsClients,
          lastError: null,
        });
      }
    } catch (err) {
      log.warn(`realtime: failed to persist device ${id}`, { err: String(err) });
    }
  }
}

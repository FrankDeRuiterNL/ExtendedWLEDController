import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import {
  WS_UNSUPPORTED,
  type DeviceConnectionStatus,
  type DeviceHealthDTO,
  type WledInfo,
  type WledState,
} from '@ewc/core';
import { log } from '../logger.js';
import { WledHttpError, fetchInfo, postState, type WledEndpoint } from '../wled/httpClient.js';

export interface DeviceConnectionOptions {
  id: number;
  host: string;
  port: number;
  /** From the registry snapshot. `false` / `null` → HTTP-poll mode. */
  wsSupported: boolean | null;
  httpTimeoutMs: number;
  /** HTTP-poll interval when not on a WebSocket. */
  pollIntervalMs?: number;
  /** App-level `p`/`pong` heartbeat interval. */
  heartbeatIntervalMs?: number;
  /** Grace period for a `pong` (or any frame) before the socket is considered dead. */
  heartbeatTimeoutMs?: number;
}

type Events = {
  state: [WledState];
  health: [DeviceHealthDTO];
  status: [{ connection: DeviceConnectionStatus; lastError: string | null }];
};

const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];
const OFFLINE_AFTER_FAILURES = 3;

/**
 * One resilient connection to a single WLED device.
 *
 * WebSocket build: holds `ws://<host>/ws`, applies inbound `{state,info}` pushes
 * as authoritative state, `p`/`pong` heartbeat, exponential-backoff reconnect
 * that never gives up (Frank power-cycles strips). HTTP build (`info.ws === -1`):
 * polls `/json/si` on an interval instead. Either way it emits `state`,
 * `health` and `status`.
 */
export class DeviceConnection extends EventEmitter<Events> {
  readonly id: number;
  private readonly endpoint: WledEndpoint;
  private readonly mode: 'ws' | 'http';
  private readonly pollIntervalMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatTimeoutMs: number;

  private ws: WebSocket | null = null;
  private stopped = false;
  private failures = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private heartbeatDeadline: NodeJS.Timeout | null = null;

  private _connection: DeviceConnectionStatus = 'connecting';
  private _lastError: string | null = null;
  private _state: WledState | null = null;
  private _info: WledInfo | null = null;

  constructor(opts: DeviceConnectionOptions) {
    super();
    this.id = opts.id;
    this.endpoint = { host: opts.host, port: opts.port, timeoutMs: opts.httpTimeoutMs };
    // `false` → HTTP poll. `true` or `null` (never imported) → try WebSocket.
    this.mode = opts.wsSupported === false ? 'http' : 'ws';
    this.pollIntervalMs = opts.pollIntervalMs ?? 10_000;
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? 20_000;
    this.heartbeatTimeoutMs = opts.heartbeatTimeoutMs ?? 16_000;
  }

  get connection(): DeviceConnectionStatus {
    return this._connection;
  }
  get lastError(): string | null {
    return this._lastError;
  }
  get state(): WledState | null {
    return this._state;
  }
  get info(): WledInfo | null {
    return this._info;
  }
  get health(): DeviceHealthDTO | null {
    if (!this._info) return null;
    const online = this._connection === 'live' || this._connection === 'polling';
    return { ...infoToHealth(this._info), online, lastError: online ? null : this._lastError };
  }

  start(): void {
    this.stopped = false;
    if (this.mode === 'ws') this.connectWs();
    else this.startPolling();
  }

  /** Stop for good. Resolves once the socket is closed. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    if (!ws || ws.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      ws.once('close', done);
      try {
        ws.close();
      } catch {
        ws.terminate();
      }
      setTimeout(() => {
        ws.removeListener('close', done);
        try {
          ws.terminate();
        } catch {
          /* already gone */
        }
        resolve();
      }, 2_000).unref();
    });
  }

  /**
   * Send a partial state patch. Fire-and-forget over the WebSocket when open
   * (the device pushes the resulting state on its own); HTTP POST otherwise.
   */
  async sendPatch(patch: WledState): Promise<void> {
    if (this.mode === 'ws' && this.ws && this.ws.readyState === WebSocket.OPEN) {
      const text = JSON.stringify(patch);
      // ESP32 accepts one text frame up to 1428 bytes; larger gets {"error":9}.
      if (Buffer.byteLength(text) > 1400) {
        await postState(this.endpoint, patch);
        return;
      }
      await new Promise<void>((resolve, reject) => {
        this.ws!.send(text, (err) => (err ? reject(err) : resolve()));
      });
      return;
    }
    await postState(this.endpoint, patch);
    // Refresh our cached state so we're not stale until the next poll.
    void this.pollOnce().catch(() => undefined);
  }

  // --- WebSocket ---------------------------------------------------------

  private connectWs(): void {
    if (this.stopped) return;
    this.setStatus(this.failures === 0 ? 'connecting' : this._connection);

    const url = `ws://${wrapHost(this.endpoint.host)}${this.endpoint.port === 80 ? '' : `:${this.endpoint.port}`}/ws`;
    const ws = new WebSocket(url, { handshakeTimeout: this.endpoint.timeoutMs });
    this.ws = ws;

    ws.on('open', () => {
      if (this.stopped) return void ws.close();
      log.info(`device ${this.id}: websocket open`);
      this.failures = 0;
      this._lastError = null;
      this.setStatus('live');
      this.startHeartbeat();
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) return; // {"lv":true} preview stream — not requested here
      this.armHeartbeatDeadline();
      const text = data.toString();
      if (text === 'pong') return;
      this.handlePush(text);
    });

    ws.on('close', () => {
      this.clearHeartbeat();
      if (this.ws === ws) this.ws = null;
      if (this.stopped) return;
      this.onFailure('websocket closed');
      this.scheduleReconnect();
    });

    ws.on('error', (err) => {
      this._lastError = err.message;
      // 'close' fires next and handles reconnect.
    });
  }

  private handlePush(text: string): void {
    let obj: unknown;
    try {
      obj = JSON.parse(text);
    } catch {
      log.debug(`device ${this.id}: non-JSON ws frame`, { text: text.slice(0, 80) });
      return;
    }
    const o = obj as Record<string, unknown>;

    if (typeof o['error'] === 'number') {
      // 3 = out of JSON buffers, 9 = frame too large. Nothing to do for reads.
      log.debug(`device ${this.id}: ws {error:${o['error']}}`);
      return;
    }
    if (o['success'] !== undefined && o['state'] === undefined) return;

    const state = (o['state'] ?? (('on' in o || 'seg' in o) ? o : undefined)) as WledState | undefined;
    const info = o['info'] as WledInfo | undefined;

    if (info) {
      this._info = info;
      if (info.ws === WS_UNSUPPORTED) {
        // Shouldn't happen on a build that accepted our WS, but be safe.
        log.warn(`device ${this.id}: info.ws === -1 over an open socket; switching to polling`);
      }
      this.emit('health', infoToHealth(info));
    }
    if (state) {
      this._state = state;
      this.emit('state', state);
    }
  }

  private startHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        try {
          this.ws.send('p');
        } catch {
          /* close handler will deal with it */
        }
      }
    }, this.heartbeatIntervalMs);
    this.armHeartbeatDeadline();
  }

  /** Any inbound frame (pong or push) proves the link is alive — reset the clock. */
  private armHeartbeatDeadline(): void {
    if (this.heartbeatDeadline) clearTimeout(this.heartbeatDeadline);
    this.heartbeatDeadline = setTimeout(() => {
      log.warn(`device ${this.id}: heartbeat timeout, recycling socket`);
      try {
        this.ws?.terminate();
      } catch {
        /* noop */
      }
    }, this.heartbeatIntervalMs + this.heartbeatTimeoutMs);
    this.heartbeatDeadline.unref();
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.heartbeatDeadline) clearTimeout(this.heartbeatDeadline);
    this.heartbeatTimer = null;
    this.heartbeatDeadline = null;
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const base = BACKOFF_MS[Math.min(this.failures, BACKOFF_MS.length - 1)]!;
    const delay = Math.round(base * (0.8 + Math.random() * 0.4));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectWs();
    }, delay);
    this.reconnectTimer.unref();
  }

  // --- HTTP polling -----------------------------------------------------

  private startPolling(): void {
    this.setStatus('connecting');
    const tick = () => {
      void this.pollOnce().finally(() => {
        if (!this.stopped) {
          this.pollTimer = setTimeout(tick, this.pollIntervalMs);
          this.pollTimer.unref();
        }
      });
    };
    tick();
  }

  private async pollOnce(): Promise<void> {
    try {
      // /json/si is state + full info in one call (verified on real hardware).
      const si = await this.fetchSi();
      const info = si?.info ?? (await fetchInfo(this.endpoint));
      this._info = info;
      this.failures = 0;
      this._lastError = null;
      if (this.mode === 'http') this.setStatus('polling');
      this.emit('health', infoToHealth(info));
      if (si?.state) {
        this._state = si.state;
        this.emit('state', si.state);
      }
    } catch (err) {
      this.onFailure(err instanceof WledHttpError ? err.message : (err as Error).message);
    }
  }

  private async fetchSi(): Promise<{ state?: WledState; info?: WledInfo } | null> {
    try {
      const res = await fetch(
        `http://${wrapHost(this.endpoint.host)}${this.endpoint.port === 80 ? '' : `:${this.endpoint.port}`}/json/si`,
        { signal: AbortSignal.timeout(this.endpoint.timeoutMs) },
      );
      if (!res.ok) return null;
      return (await res.json()) as { state?: WledState; info?: WledInfo };
    } catch {
      return null;
    }
  }

  // --- status bookkeeping ---------------------------------------------

  private onFailure(message: string): void {
    this.failures++;
    this._lastError = message;
    if (this.failures >= OFFLINE_AFTER_FAILURES) this.setStatus('offline');
  }

  private setStatus(next: DeviceConnectionStatus): void {
    if (next === this._connection) return;
    this._connection = next;
    this.emit('status', { connection: next, lastError: this._lastError });
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.reconnectTimer = null;
    this.pollTimer = null;
    this.clearHeartbeat();
  }
}

function wrapHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

export function infoToHealth(info: WledInfo): DeviceHealthDTO {
  return {
    online: true,
    lastSeenAt: new Date().toISOString(),
    lastError: null,
    fps: info.leds?.fps ?? null,
    freeheap: info.freeheap ?? null,
    wifiSignal: info.wifi?.signal ?? null,
    uptimeS: info.uptime ?? null,
    live: info.live ?? null,
    wsClients: typeof info.ws === 'number' && info.ws !== WS_UNSUPPORTED ? info.ws : null,
    checkedAt: new Date().toISOString(),
  };
}

import type { Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { REALTIME_WS_PATH, type ServerRealtimeMsg } from '@ewc/core';
import { log } from '../logger.js';
import type { RealtimeHub } from './hub.js';

/**
 * Fans the {@link RealtimeHub}'s device events out to browser clients over one
 * WebSocket at {@link REALTIME_WS_PATH}. Browser clients are read-only; control
 * still goes through the REST API.
 */
export class BrowserHub {
  private readonly wss: WebSocketServer;
  private pingTimer: NodeJS.Timeout | null = null;

  constructor(
    server: Server,
    private readonly hub: RealtimeHub,
  ) {
    this.wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (req, socket, head) => {
      let pathname: string;
      try {
        pathname = new URL(req.url ?? '', 'http://localhost').pathname;
      } catch {
        socket.destroy();
        return;
      }
      if (pathname !== REALTIME_WS_PATH) return; // let other upgrade handlers try
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit('connection', ws, req);
      });
    });

    this.wss.on('connection', (ws) => this.onConnection(ws));

    hub.on('state', ({ deviceId, state }) =>
      this.broadcast({ type: 'deviceState', deviceId, state }),
    );
    hub.on('health', ({ deviceId, health }) =>
      this.broadcast({ type: 'deviceHealth', deviceId, health }),
    );
    hub.on('status', ({ deviceId, connection, lastError }) =>
      this.broadcast({ type: 'deviceStatus', deviceId, connection, lastError }),
    );
    hub.on('devicesChanged', () => this.broadcast({ type: 'deviceListChanged' }));

    this.pingTimer = setInterval(() => {
      for (const ws of this.wss.clients) {
        const c = ws as WebSocket & { isAlive?: boolean };
        if (c.isAlive === false) {
          c.terminate();
          continue;
        }
        c.isAlive = false;
        c.ping();
      }
    }, 30_000);
    this.pingTimer.unref();
  }

  private onConnection(ws: WebSocket): void {
    const c = ws as WebSocket & { isAlive?: boolean };
    c.isAlive = true;
    ws.on('pong', () => {
      c.isAlive = true;
    });
    ws.on('message', (data) => {
      // Only heartbeat pings expected from clients.
      if (data.toString() === 'ping') ws.send('pong');
    });
    ws.on('error', () => ws.terminate());

    this.send(ws, { type: 'snapshot', devices: this.hub.snapshot() });
    log.debug(`browser client connected (${this.wss.clients.size} total)`);
  }

  private broadcast(msg: ServerRealtimeMsg): void {
    const text = JSON.stringify(msg);
    for (const ws of this.wss.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(text);
    }
  }

  private send(ws: WebSocket, msg: ServerRealtimeMsg): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  close(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    for (const ws of this.wss.clients) ws.terminate();
    this.wss.close();
  }
}

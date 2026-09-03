import { useEffect, useRef, useState } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  REALTIME_WS_PATH,
  type DeviceDetailDTO,
  type DeviceHealthDTO,
  type DeviceRealtimeState,
  type DeviceSummaryDTO,
  type ServerRealtimeMsg,
} from '@ewc/core';

const keys = {
  list: ['devices', 'list'] as const,
  detail: (id: number) => ['devices', 'detail', id] as const,
};

function patchList(
  qc: QueryClient,
  deviceId: number,
  fn: (d: DeviceSummaryDTO) => DeviceSummaryDTO,
) {
  qc.setQueryData<DeviceSummaryDTO[]>(keys.list, (prev) =>
    prev?.map((d) => (d.id === deviceId ? fn(d) : d)),
  );
}

function patchDetail(
  qc: QueryClient,
  deviceId: number,
  fn: (d: DeviceDetailDTO) => DeviceDetailDTO,
) {
  qc.setQueryData<DeviceDetailDTO>(keys.detail(deviceId), (prev) => (prev ? fn(prev) : prev));
}

function applyMessage(qc: QueryClient, msg: ServerRealtimeMsg): void {
  switch (msg.type) {
    case 'snapshot':
      for (const d of msg.devices) applyRealtimeState(qc, d);
      break;
    case 'deviceState':
      patchDetail(qc, msg.deviceId, (d) => ({ ...d, state: msg.state }));
      break;
    case 'deviceStatus':
      patchList(qc, msg.deviceId, (d) => ({ ...d, connection: msg.connection }));
      patchDetail(qc, msg.deviceId, (d) => ({ ...d, connection: msg.connection }));
      break;
    case 'deviceHealth':
      patchHealth(qc, msg.deviceId, msg.health);
      break;
    case 'deviceListChanged':
      void qc.invalidateQueries({ queryKey: ['devices'] });
      break;
  }
}

function patchHealth(qc: QueryClient, deviceId: number, health: DeviceHealthDTO): void {
  patchList(qc, deviceId, (d) => ({ ...d, health }));
  patchDetail(qc, deviceId, (d) => ({ ...d, health }));
}

function applyRealtimeState(qc: QueryClient, s: DeviceRealtimeState): void {
  patchList(qc, s.deviceId, (d) => ({
    ...d,
    connection: s.connection,
    ...(s.health ? { health: s.health } : {}),
  }));
  patchDetail(qc, s.deviceId, (d) => ({
    ...d,
    connection: s.connection,
    ...(s.state ? { state: s.state } : {}),
    ...(s.health ? { health: s.health } : {}),
  }));
}

export type StreamStatus = 'connecting' | 'open' | 'closed';

/**
 * Single realtime WebSocket to the backend. Applies device state / health /
 * status pushes straight into the React Query cache, so existing components
 * re-render with no extra wiring. Mount once, near the app root.
 */
export function useRealtimeStream(): StreamStatus {
  const qc = useQueryClient();
  const [status, setStatus] = useState<StreamStatus>('connecting');
  const attempt = useRef(0);
  const closedByUs = useRef(false);

  useEffect(() => {
    closedByUs.current = false;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${proto}//${location.host}${REALTIME_WS_PATH}`);
      setStatus('connecting');

      ws.onopen = () => {
        attempt.current = 0;
        setStatus('open');
        heartbeat = setInterval(() => ws?.readyState === WebSocket.OPEN && ws.send('ping'), 25_000);
      };
      ws.onmessage = (ev) => {
        if (ev.data === 'pong') return;
        try {
          applyMessage(qc, JSON.parse(ev.data as string) as ServerRealtimeMsg);
        } catch {
          /* ignore malformed frame */
        }
      };
      ws.onclose = () => {
        if (heartbeat) clearInterval(heartbeat);
        setStatus('closed');
        if (closedByUs.current) return;
        const delay = Math.min(1000 * 2 ** attempt.current, 15_000);
        attempt.current += 1;
        reconnectTimer = setTimeout(connect, delay);
      };
      ws.onerror = () => ws?.close();
    };

    connect();

    return () => {
      closedByUs.current = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (heartbeat) clearInterval(heartbeat);
      ws?.close();
    };
  }, [qc]);

  return status;
}

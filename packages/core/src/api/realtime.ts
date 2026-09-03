/**
 * Contract for the backend → browser realtime stream (`/api/ws`).
 *
 * The backend holds one WebSocket per device to `ws://<device>/ws`, keeps the
 * authoritative state in memory, and fans changes out to browser clients over
 * this channel. Browser clients are read-only here — control still goes through
 * `POST /api/devices/:id/state`, which the backend routes over the device
 * socket when it's open.
 */

import type { WledState } from '../wled/state.js';
import type { DeviceHealthDTO } from './devices.js';

/**
 * - `connecting` — no data yet (initial connect or mid-reconnect)
 * - `live` — device WebSocket open, receiving pushes
 * - `polling` — falling back to HTTP polling (build has no WS, or WS unreachable)
 *   and the last poll succeeded
 * - `offline` — device is not reachable; the backend keeps retrying
 */
export type DeviceConnectionStatus = 'connecting' | 'live' | 'polling' | 'offline';

export interface DeviceRealtimeState {
  deviceId: number;
  connection: DeviceConnectionStatus;
  /** Authoritative device state, or null before the first push/poll. */
  state: WledState | null;
  health: DeviceHealthDTO | null;
  lastError: string | null;
}

export interface RealtimeSnapshotMsg {
  type: 'snapshot';
  devices: DeviceRealtimeState[];
}

export interface DeviceStateMsg {
  type: 'deviceState';
  deviceId: number;
  state: WledState;
}

export interface DeviceStatusMsg {
  type: 'deviceStatus';
  deviceId: number;
  connection: DeviceConnectionStatus;
  lastError: string | null;
}

export interface DeviceHealthMsg {
  type: 'deviceHealth';
  deviceId: number;
  health: DeviceHealthDTO;
}

/** A device was added to / removed from the registry while a client was connected. */
export interface DeviceListChangedMsg {
  type: 'deviceListChanged';
}

export type ServerRealtimeMsg =
  | RealtimeSnapshotMsg
  | DeviceStateMsg
  | DeviceStatusMsg
  | DeviceHealthMsg
  | DeviceListChangedMsg;

/** Path the browser realtime WebSocket is served on. */
export const REALTIME_WS_PATH = '/api/ws';

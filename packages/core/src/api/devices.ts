/**
 * DTOs for the EWC backend HTTP API. Shared verbatim between server and web so
 * the wire contract can't drift. Pure types — no runtime code.
 */

import type { WledState } from '../wled/state.js';
import type { FxMeta } from '../wled/fxdata.js';
import type { DeviceConnectionStatus } from './realtime.js';

export type LinkType = 'wifi' | 'ethernet' | 'unknown';

/**
 * Per-device brightness/gamma handling. The renderer (milestone 4) and the DDP
 * sender (milestone 3) consult this; it is captured at M1 so it never has to be
 * retrofitted.
 *
 * - `passthrough`: send colours as-is, let the device apply its own `bri` + gamma.
 * - `pin255`: force device `bri` to 255 and dim/gamma entirely in software.
 */
export interface BrightnessPolicy {
  mode: 'passthrough' | 'pin255';
  /** Software gamma exponent to pre-apply to the stream, or null for linear. */
  softwareGamma: number | null;
}

export const DEFAULT_BRIGHTNESS_POLICY: BrightnessPolicy = {
  mode: 'passthrough',
  softwareGamma: null,
};

export type DeviceWarningCode =
  | 'dmx-start-address'
  | 'ws-unsupported'
  | 'fs-low'
  | 'fxdata-missing'
  | 'cfg-missing'
  | 'effect-count-mismatch';

export interface DeviceWarning {
  code: DeviceWarningCode;
  severity: 'info' | 'warning';
  message: string;
}

export interface DeviceHealthDTO {
  online: boolean;
  lastSeenAt: string | null;
  lastError: string | null;
  /** `info.leds.fps` — the backpressure signal. */
  fps: number | null;
  freeheap: number | null;
  /** `info.wifi.signal`, 0–100. */
  wifiSignal: number | null;
  uptimeS: number | null;
  /** `info.live` — device is showing realtime data. */
  live: boolean | null;
  /** `info.ws` — current WebSocket client count. */
  wsClients: number | null;
  checkedAt: string | null;
}

export interface DeviceSummaryDTO {
  id: number;
  name: string;
  host: string;
  port: number;
  mac: string | null;
  linkType: LinkType;
  enabled: boolean;
  arch: string | null;
  fwVersion: string | null;
  /** Negotiated ethernet PHY speed in Mbps (10 / 100 / 1000). Per-device — WLED
   *  doesn't report it. NULL = unknown; the UI assumes 100 for ethernet links. */
  ethSpeedMbps: number | null;
  ledCount: number | null;
  matrix: { w: number; h: number } | null;
  fxcount: number | null;
  palcount: number | null;
  wsSupported: boolean | null;
  /** Non-zero shifts realtime pixels — always surfaced as a warning too. */
  dmxStartAddress: number;
  warnings: DeviceWarning[];
  health: DeviceHealthDTO | null;
  /**
   * Live connection status from the realtime hub. Authoritative for "is it up" —
   * prefer this over `health.online`, which is only as fresh as the last poll.
   */
  connection: DeviceConnectionStatus;
  lastImportAt: string | null;
}

export interface DeviceRealtimeInfoDTO {
  timeoutMs: number | null;
  gammaDisabled: boolean | null;
  forcesMaxBrightness: boolean | null;
  offset: number;
  dmxUniverse: number | null;
  dmxMode: number | null;
}

export interface DeviceDetailDTO extends DeviceSummaryDTO {
  seglc: number[] | null;
  lc: number | null;
  capabilities: { rgb: boolean; white: boolean; cct: boolean; raw: number };
  fsTotalKb: number | null;
  fsUsedKb: number | null;
  brightnessPolicy: BrightnessPolicy;
  deviceGamma: { bri: number; col: number; val: number } | null;
  realtime: DeviceRealtimeInfoDTO;
  /** Parsed effect metadata, reserved slots flagged (not removed). */
  effects: FxMeta[];
  /** False when the device truncated `/json/fxdata`; tail effects use generic controls. */
  fxdataComplete: boolean;
  palettes: string[];
  /** Last known device state (from the add/refresh snapshot). Live state = M2. */
  state: WledState | null;
}

// --- Requests --------------------------------------------------------------

export interface AddDeviceRequest {
  host: string;
  port?: number;
  name?: string;
  linkType?: LinkType;
}

export interface UpdateDeviceRequest {
  name?: string;
  linkType?: LinkType;
  enabled?: boolean;
  brightnessPolicy?: BrightnessPolicy;
  /** 10 / 100 / 1000, or null to clear. Only meaningful for an ethernet link. */
  ethSpeedMbps?: number | null;
}

export interface NodeImportCandidate {
  host: string;
  name: string | null;
  /** True when a device with this host or MAC is already registered. */
  alreadyRegistered: boolean;
}

export interface ImportNodesResponse {
  candidates: NodeImportCandidate[];
}

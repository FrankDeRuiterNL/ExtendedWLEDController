import { useMutation } from '@tanstack/react-query';
import { api } from './client.js';

export interface PaintRequest {
  segId?: number;
  brightness?: number;
  mode: 'dense' | 'sparse';
  /** dense: the whole run from segment-relative index 0. */
  pixels?: string[];
  /** sparse: only these indices are set; the rest keep running the effect. */
  painted?: Array<{ index: number; color: string }>;
}

export interface PaintResult {
  ok: true;
  chunks: number;
  pixels: number;
}

/** Push a `seg.i` paint to a device. Freezes the segment until released. */
export function usePaint(deviceId: number) {
  return useMutation({
    mutationFn: (body: PaintRequest) => api.post<PaintResult>(`/devices/${deviceId}/paint`, body),
  });
}

/** Un-freeze the segment so its effect resumes. */
export function usePaintRelease(deviceId: number) {
  return useMutation({
    mutationFn: (segId?: number) =>
      api.post<{ ok: true }>(`/devices/${deviceId}/paint/release`, segId == null ? {} : { segId }),
  });
}

export interface BakeRequest {
  segId?: number;
  /** 1..250 — also save as a preset that survives reboot. */
  preset?: number;
  name?: string;
  sceneId?: number;
  /** Segment-relative; `RRGGBB` hex or null. Used when no `sceneId`. */
  pixels?: Array<string | null>;
}

export interface BakeResult {
  ok: true;
  filename: string;
  bytes: number;
  freeKbBefore: number | null;
  freeKbAfter: number | null;
  preset: number | null;
  imageEffect: number | null;
}

/**
 * Bake a static pixel image to the device as a one-frame GIF (`seg.n` + the
 * Image effect), optionally `psave`d as a reboot-proof preset.
 */
export function useBake(deviceId: number) {
  return useMutation({
    mutationFn: (body: BakeRequest) => api.post<BakeResult>(`/devices/${deviceId}/bake`, body),
  });
}

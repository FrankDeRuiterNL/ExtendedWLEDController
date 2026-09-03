import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type {
  DmxPatchDTO,
  DmxPlanConfig,
  FloorplanRef,
  Installation,
} from '@ewc/core';
import { api } from './client.js';

// --- DMX patch --------------------------------------------------------

const dmxKey = ['dmx', 'patch'] as const;

export function useDmxPatch(): UseQueryResult<DmxPatchDTO> {
  return useQuery({
    queryKey: dmxKey,
    queryFn: () => api.get<DmxPatchDTO>('/dmx/patch'),
    refetchInterval: 15_000,
  });
}

export function useReplanDmx() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<DmxPatchDTO>('/dmx/replan'),
    onSuccess: (d) => qc.setQueryData(dmxKey, d),
  });
}

export function useSetDmxConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { config: Partial<DmxPlanConfig>; replan?: boolean }) =>
      api.put<DmxPatchDTO>('/dmx/config', body),
    onSuccess: (d) => qc.setQueryData(dmxKey, d),
  });
}

export function useAssignDmx() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (deviceId: number) => api.post<DmxPatchDTO>(`/dmx/${deviceId}/assign`),
    onSuccess: (d) => qc.setQueryData(dmxKey, d),
  });
}

export function useSetDmxManaged() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ deviceId, managed }: { deviceId: number; managed: boolean }) =>
      api.put<DmxPatchDTO>(`/dmx/${deviceId}/managed`, { managed }),
    onSuccess: (d) => qc.setQueryData(dmxKey, d),
  });
}

// --- stream ----------------------------------------------------------

export interface StreamStatusDTO {
  mode: 'idle' | 'solid' | 'pattern' | 'scene' | 'paint';
  running: boolean;
  color: [number, number, number] | null;
  scene: { name: string; layerCount: number; unknownEffects: string[] } | null;
  paint: { deviceId: number; litCount: number; ledCount: number } | null;
  epochMs: number | null;
  fps: number;
  devices: Array<{
    deviceId: number;
    name: string;
    connection: string;
    ledCount: number | null;
    universe: number | null;
    framesSent: number;
    framesDropped: number;
    packets: number;
    bytes: number;
    deviceFps: number | null;
    pixelOffset: number;
  }>;
}

const streamKey = ['stream', 'status'] as const;

export function useStreamStatus(): UseQueryResult<StreamStatusDTO> {
  return useQuery({
    queryKey: streamKey,
    queryFn: () => api.get<StreamStatusDTO>('/stream/status'),
    refetchInterval: (q) => (q.state.data?.running ? 1000 : 5000),
  });
}

export function useStartSolid() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (color: [number, number, number]) =>
      api.post<StreamStatusDTO>('/stream/solid', { color }),
    onSuccess: (d) => qc.setQueryData(streamKey, d),
  });
}

export function useStartPattern() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<StreamStatusDTO>('/stream/pattern'),
    onSuccess: (d) => qc.setQueryData(streamKey, d),
  });
}

export interface StartPaintStreamRequest {
  deviceId: number;
  segStart?: number;
  brightness: number;
  /** Segment-relative; `RRGGBB` hex or null (LED off). */
  pixels: Array<string | null>;
}

export function useStartPaintStream() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: StartPaintStreamRequest) =>
      api.post<StreamStatusDTO>('/stream/paint', body),
    onSuccess: (d) => qc.setQueryData(streamKey, d),
  });
}

export function useStopStream() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<StreamStatusDTO>('/stream/stop'),
    onSuccess: (d) => qc.setQueryData(streamKey, d),
  });
}

export function useSetPixelOffset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ deviceId, offset }: { deviceId: number; offset: number }) =>
      api.put<StreamStatusDTO>(`/stream/${deviceId}/pixel-offset`, { offset }),
    onSuccess: (d) => qc.setQueryData(streamKey, d),
  });
}

// --- installation ---------------------------------------------------

const instKey = ['installation'] as const;

export function useInstallation(): UseQueryResult<Installation> {
  return useQuery({
    queryKey: instKey,
    queryFn: () => api.get<{ installation: Installation }>('/installation').then((r) => r.installation),
  });
}

export function useSaveInstallation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (installation: Installation) =>
      api.put<{ installation: Installation }>('/installation', { installation }).then((r) => r.installation),
    onSuccess: (inst) => qc.setQueryData(instKey, inst),
  });
}

// --- floorplan (preview-only reference image) ----------------------

/** URL for the stored floorplan image, cache-busted by its `rev`. */
export const floorplanUrl = (fp: FloorplanRef): string =>
  `/api/installation/floorplan?rev=${fp.rev}`;

/** Read an image file's natural pixel dimensions in the browser. */
async function imageDimensions(file: File): Promise<{ w: number; h: number }> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('could not read image'));
      img.src = url;
    });
    return { w: img.naturalWidth || 1, h: img.naturalHeight || 1 };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function useUploadFloorplan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (file: File): Promise<Installation> => {
      const { w, h } = await imageDimensions(file);
      const res = await fetch(`/api/installation/floorplan?w=${w}&h=${h}`, {
        method: 'PUT',
        headers: { 'content-type': file.type },
        body: file,
      });
      const text = await res.text();
      const data = text ? JSON.parse(text) : undefined;
      if (!res.ok) {
        throw new Error(data?.error?.message ?? `upload failed (HTTP ${res.status})`);
      }
      return data.installation as Installation;
    },
    onSuccess: (inst) => qc.setQueryData(instKey, inst),
  });
}

export function useDeleteFloorplan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.delete<{ installation: Installation }>('/installation/floorplan').then((r) => r.installation),
    onSuccess: (inst) => qc.setQueryData(instKey, inst),
  });
}

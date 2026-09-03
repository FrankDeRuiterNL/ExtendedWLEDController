import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';
import type {
  AddDeviceRequest,
  DeviceDetailDTO,
  DeviceSummaryDTO,
  NodeImportCandidate,
  UpdateDeviceRequest,
  WledState,
} from '@ewc/core';
import { api } from './client.js';

const keys = {
  all: ['devices'] as const,
  list: () => [...keys.all, 'list'] as const,
  detail: (id: number) => [...keys.all, 'detail', id] as const,
  nodes: (id: number) => [...keys.all, 'nodes', id] as const,
};

export function useDevices(): UseQueryResult<DeviceSummaryDTO[]> {
  return useQuery({
    queryKey: keys.list(),
    queryFn: () => api.get<{ devices: DeviceSummaryDTO[] }>('/devices').then((r) => r.devices),
    // Live updates arrive over the realtime WebSocket; this is just a safety net
    // in case that socket dies silently.
    refetchInterval: 30_000,
  });
}

export function useDevice(id: number, enabled = true): UseQueryResult<DeviceDetailDTO> {
  return useQuery({
    queryKey: keys.detail(id),
    queryFn: () => api.get<{ device: DeviceDetailDTO }>(`/devices/${id}`).then((r) => r.device),
    refetchInterval: 30_000,
    enabled: enabled && Number.isInteger(id) && id > 0,
  });
}

export function useAddDevice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: AddDeviceRequest) =>
      api.post<{ device: DeviceDetailDTO }>('/devices', req).then((r) => r.device),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.all }),
  });
}

export function useUpdateDevice(id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: UpdateDeviceRequest) =>
      api.patch<{ device: DeviceDetailDTO }>(`/devices/${id}`, req).then((r) => r.device),
    onSuccess: (device) => {
      qc.setQueryData(keys.detail(id), device);
      qc.invalidateQueries({ queryKey: keys.list() });
    },
  });
}

export function useRefreshDevice(id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.post<{ device: DeviceDetailDTO }>(`/devices/${id}/refresh`).then((r) => r.device),
    onSuccess: (device) => {
      qc.setQueryData(keys.detail(id), device);
      qc.invalidateQueries({ queryKey: keys.list() });
    },
  });
}

export function useRefreshFxData(id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.post<{ device: DeviceDetailDTO }>(`/devices/${id}/refresh-fxdata`).then((r) => r.device),
    onSuccess: (device) => {
      qc.setQueryData(keys.detail(id), device);
      qc.invalidateQueries({ queryKey: keys.list() });
    },
  });
}

export function useDeleteDevice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.delete<void>(`/devices/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.all }),
  });
}

export function useControlDevice(id: number) {
  return useMutation({
    // Fire-and-forget: the device pushes the resulting state and the realtime
    // WebSocket updates the cache. No follow-up refetch needed.
    mutationFn: (patch: WledState) => api.post<{ ok: true }>(`/devices/${id}/state`, patch),
  });
}

export function useDiscoverNodes(id: number) {
  return useQuery({
    queryKey: keys.nodes(id),
    queryFn: () =>
      api.get<{ candidates: NodeImportCandidate[] }>(`/devices/${id}/nodes`).then((r) => r.candidates),
    enabled: false,
    retry: false,
  });
}

export function useImportNodes() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { hosts: string[]; linkType?: AddDeviceRequest['linkType'] }) =>
      api.post<{ added: DeviceDetailDTO[]; failed: { host: string; error: string }[] }>(
        '/devices/import-nodes',
        body,
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.all }),
  });
}

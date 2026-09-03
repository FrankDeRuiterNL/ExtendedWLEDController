import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type { PixelScene, PixelSceneDTO, PixelSceneSummaryDTO } from '@ewc/core';
import { api } from './client.js';

const listKey = ['pixel-scenes'] as const;
const oneKey = (id: number) => ['pixel-scenes', id] as const;

export function usePixelScenes(): UseQueryResult<PixelSceneSummaryDTO[]> {
  return useQuery({
    queryKey: listKey,
    queryFn: () =>
      api.get<{ pixelScenes: PixelSceneSummaryDTO[] }>('/pixel-scenes').then((r) => r.pixelScenes),
  });
}

export function usePixelScene(id: number | null): UseQueryResult<PixelSceneDTO> {
  return useQuery({
    queryKey: id == null ? ['pixel-scenes', 'none'] : oneKey(id),
    enabled: id != null,
    queryFn: () => api.get<{ pixelScene: PixelSceneDTO }>(`/pixel-scenes/${id}`).then((r) => r.pixelScene),
  });
}

/** One-shot fetch of a full pixel scene (for the Paint page's load flow). */
export const fetchPixelScene = (id: number) =>
  api.get<{ pixelScene: PixelSceneDTO }>(`/pixel-scenes/${id}`).then((r) => r.pixelScene);

export function useCreatePixelScene() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; scene: PixelScene }) =>
      api.post<{ pixelScene: PixelSceneDTO }>('/pixel-scenes', body).then((r) => r.pixelScene),
    onSuccess: (s) => {
      qc.invalidateQueries({ queryKey: listKey });
      qc.setQueryData(oneKey(s.id), s);
    },
  });
}

export function useUpdatePixelScene() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name, scene }: { id: number; name: string; scene: PixelScene }) =>
      api.put<{ pixelScene: PixelSceneDTO }>(`/pixel-scenes/${id}`, { name, scene }).then((r) => r.pixelScene),
    onSuccess: (s) => {
      qc.invalidateQueries({ queryKey: listKey });
      qc.setQueryData(oneKey(s.id), s);
    },
  });
}

export function useDeletePixelScene() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.delete(`/pixel-scenes/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: listKey }),
  });
}

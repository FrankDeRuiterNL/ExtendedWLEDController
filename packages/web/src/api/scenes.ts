import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type { Scene, SceneDTO, SceneSummaryDTO } from '@ewc/core';
import { api } from './client.js';
import type { StreamStatusDTO } from './stage.js';

const listKey = ['scenes'] as const;
const oneKey = (id: number) => ['scenes', id] as const;
const streamKey = ['stream', 'status'] as const;

export function useScenes(): UseQueryResult<SceneSummaryDTO[]> {
  return useQuery({
    queryKey: listKey,
    queryFn: () => api.get<{ scenes: SceneSummaryDTO[] }>('/scenes').then((r) => r.scenes),
  });
}

export function useScene(id: number | null): UseQueryResult<SceneDTO> {
  return useQuery({
    queryKey: id == null ? ['scenes', 'none'] : oneKey(id),
    enabled: id != null,
    queryFn: () => api.get<{ scene: SceneDTO }>(`/scenes/${id}`).then((r) => r.scene),
  });
}

export function useCreateScene() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; scene: Scene }) =>
      api.post<{ scene: SceneDTO }>('/scenes', body).then((r) => r.scene),
    onSuccess: (s) => {
      qc.invalidateQueries({ queryKey: listKey });
      qc.setQueryData(oneKey(s.id), s);
    },
  });
}

export function useUpdateScene() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name, scene }: { id: number; name: string; scene: Scene }) =>
      api.put<{ scene: SceneDTO }>(`/scenes/${id}`, { name, scene }).then((r) => r.scene),
    onSuccess: (s) => {
      qc.invalidateQueries({ queryKey: listKey });
      qc.setQueryData(oneKey(s.id), s);
    },
  });
}

export function useDeleteScene() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.delete(`/scenes/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: listKey }),
  });
}

/** Start streaming a scene (inline, or by stored id). */
export function useStartScene() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { scene: Scene } | { sceneId: number }) =>
      api.post<StreamStatusDTO>('/stream/scene', body),
    onSuccess: (d) => qc.setQueryData(streamKey, d),
  });
}

import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type { Rundown, RundownDTO, RundownStatusDTO } from '@ewc/core';
import { api } from './client.js';
import type { StreamStatusDTO } from './stage.js';

const rundownKey = ['rundown'] as const;
const statusKey = ['rundown', 'status'] as const;
const streamKey = ['stream', 'status'] as const;

export function useRundown(): UseQueryResult<RundownDTO> {
  return useQuery({
    queryKey: rundownKey,
    queryFn: () => api.get<RundownDTO>('/rundown'),
  });
}

export function useSaveRundown() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (rundown: Rundown) =>
      api.put<RundownDTO>('/rundown', { rundown }).then((r) => r),
    onSuccess: (d) => qc.setQueryData(rundownKey, d),
  });
}

export function useRundownStatus(): UseQueryResult<RundownStatusDTO> {
  return useQuery({
    queryKey: statusKey,
    queryFn: () => api.get<RundownStatusDTO>('/rundown/status'),
    refetchInterval: (q) => (q.state.data?.active ? 500 : 4000),
  });
}

/** GO — start the first playable cue, or advance past the current one. */
export function useRundownGo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<RundownStatusDTO>('/rundown/go'),
    onSuccess: (d) => {
      qc.setQueryData(statusKey, d);
      qc.invalidateQueries({ queryKey: streamKey });
    },
  });
}

export function useRundownGoCue() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (cueId: string) => api.post<RundownStatusDTO>(`/rundown/go/${cueId}`),
    onSuccess: (d) => {
      qc.setQueryData(statusKey, d);
      qc.invalidateQueries({ queryKey: streamKey });
    },
  });
}

export function useRundownStop() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<RundownStatusDTO>('/rundown/stop'),
    onSuccess: (d) => {
      qc.setQueryData(statusKey, d);
      qc.invalidateQueries({ queryKey: streamKey });
      qc.setQueryData<StreamStatusDTO | undefined>(streamKey, (s) =>
        s ? { ...s, running: false, mode: 'idle' } : s,
      );
    },
  });
}

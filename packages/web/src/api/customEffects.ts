import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { customEffectToDef, type CustomEffectDTO, type CustomEffectSpec, type EffectDef } from '@ewc/core';
import { api } from './client.js';

const listKey = ['custom-effects'] as const;
const oneKey = (id: number) => ['custom-effects', id] as const;

export function useCustomEffects(): UseQueryResult<CustomEffectDTO[]> {
  return useQuery({
    queryKey: listKey,
    queryFn: () =>
      api.get<{ customEffects: CustomEffectDTO[] }>('/custom-effects').then((r) => r.customEffects),
  });
}

export function useCreateCustomEffect() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; spec: CustomEffectSpec }) =>
      api.post<{ customEffect: CustomEffectDTO }>('/custom-effects', body).then((r) => r.customEffect),
    onSuccess: (e) => {
      qc.invalidateQueries({ queryKey: listKey });
      qc.setQueryData(oneKey(e.id), e);
    },
  });
}

export function useUpdateCustomEffect() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name, spec }: { id: number; name: string; spec: CustomEffectSpec }) =>
      api.put<{ customEffect: CustomEffectDTO }>(`/custom-effects/${id}`, { name, spec }).then((r) => r.customEffect),
    onSuccess: (e) => {
      qc.invalidateQueries({ queryKey: listKey });
      qc.setQueryData(oneKey(e.id), e);
    },
  });
}

export function useDeleteCustomEffect() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.delete(`/custom-effects/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: listKey }),
  });
}

/** Compile every saved custom effect into the `Map` `sampleScene`/`CanvasPreview`
 *  expect, keyed by its runtime `custom:<id>` id. */
export function customEffectsMap(list: CustomEffectDTO[] | undefined): Map<string, EffectDef> {
  const map = new Map<string, EffectDef>();
  for (const row of list ?? []) {
    const id = `custom:${row.id}`;
    map.set(id, customEffectToDef({ id, name: row.name, blurb: row.blurb, layers: row.layers }));
  }
  return map;
}

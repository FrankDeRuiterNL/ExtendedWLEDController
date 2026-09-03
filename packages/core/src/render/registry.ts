/** Effect registry — the id → definition lookup used by the compositor and UI. */

import { EFFECT_LIST } from './effects.js';
import { defaultParamValues, type EffectDef, type ParamValues } from './types.js';

const BY_ID = new Map<string, EffectDef>(EFFECT_LIST.map((e) => [e.id, e]));

/** All effects in picker order. */
export function listEffects(): EffectDef[] {
  return EFFECT_LIST;
}

/** Look up an effect by its persisted id, or `undefined` if unknown. */
export function getEffect(id: string): EffectDef | undefined {
  return BY_ID.get(id);
}

/** Default param map for an effect id (empty if the id is unknown). */
export function effectDefaults(id: string): ParamValues {
  const def = BY_ID.get(id);
  return def ? defaultParamValues(def) : {};
}

/** Every known effect id. */
export function effectIds(): string[] {
  return EFFECT_LIST.map((e) => e.id);
}

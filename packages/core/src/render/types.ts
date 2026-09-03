/**
 * Render-engine core types. Effects are **pure functions over normalised canvas
 * coordinates** — identical code runs in the server's DDP frame loop and in the
 * browser preview, so the preview cannot drift from the wall.
 *
 *   type Effect = (x, y, t, params) => RGBA
 *
 * `x`, `y` are 0..1 with y pointing **down** (same as the layout canvas and the
 * mapping engine's `MappedLed`). `t` is seconds since the stream started.
 */

/** 0..255 per channel. */
export type RGB = [number, number, number];

/** rgb 0..255, alpha 0..1. */
export type RGBA = [number, number, number, number];

export type ParamType = 'number' | 'color' | 'bool' | 'select';

export interface ParamDef {
  key: string;
  label: string;
  type: ParamType;
  default: number | boolean | string | RGB;
  /** number only */
  min?: number;
  max?: number;
  step?: number;
  /** select only */
  options?: Array<{ value: string; label: string }>;
  /** optional one-liner shown under the control */
  hint?: string;
}

/** A colour param is stored as `[r,g,b]`; the wider `number[]` keeps it assignable
 *  from JSON / zod-parsed input without a tuple cast. */
export type ParamValue = number | boolean | string | number[];
export type ParamValues = Record<string, ParamValue>;

export interface EffectDef {
  /**
   * Persisted identifier. Saved scenes reference this string in SQLite — **never
   * rename or remove an id**; add a new effect instead. `sampleScene` skips
   * (with a one-time warning) any layer whose effect id is unknown.
   */
  id: string;
  name: string;
  /** One-line description for the picker. */
  blurb: string;
  params: ParamDef[];
  render: (x: number, y: number, t: number, p: ParamValues) => RGBA;
}

// --- param readers (tolerant of missing / wrong-typed values) ---------

export function numParam(p: ParamValues, key: string, fallback: number): number {
  const v = p[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

export function boolParam(p: ParamValues, key: string, fallback: boolean): boolean {
  const v = p[key];
  return typeof v === 'boolean' ? v : fallback;
}

export function strParam(p: ParamValues, key: string, fallback: string): string {
  const v = p[key];
  return typeof v === 'string' ? v : fallback;
}

export function colorParam(p: ParamValues, key: string, fallback: RGB): RGB {
  const v = p[key];
  if (Array.isArray(v) && v.length >= 3 && v.every((n) => typeof n === 'number')) {
    return [v[0]!, v[1]!, v[2]!];
  }
  return fallback;
}

/** Fill in every declared param default the caller didn't provide. */
export function withParamDefaults(def: EffectDef, partial: ParamValues | undefined): ParamValues {
  const out: ParamValues = {};
  for (const d of def.params) out[d.key] = d.default;
  if (partial) for (const k of Object.keys(partial)) out[k] = partial[k]!;
  return out;
}

/** Default param map for an effect. */
export function defaultParamValues(def: EffectDef): ParamValues {
  return withParamDefaults(def, undefined);
}

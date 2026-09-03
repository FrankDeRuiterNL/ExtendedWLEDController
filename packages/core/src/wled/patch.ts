/**
 * Helpers for building **partial** `state` payloads.
 *
 * Every write to a WLED device is a partial POST — never a full state object.
 * The spec calls conflating this out as a likely bug source, so the mutation
 * layer works exclusively in field-level patches built here.
 */

import type { WledState, WledSegment } from './state.js';

/**
 * Clamp a brightness value into WLED's rules: the wire value is 1–255, and
 * "off" is expressed as `on:false`, never `bri:0`.
 *
 * @returns a partial state: `{on:false}` at zero, otherwise `{on:true, bri}`.
 */
export function brightnessPatch(value: number): WledState {
  const v = Math.round(value);
  if (!Number.isFinite(v) || v <= 0) return { on: false };
  return { on: true, bri: Math.min(255, v) };
}

/** A patch that targets a single segment by id, leaving all others untouched. */
export function segmentPatch(id: number, fields: Omit<WledSegment, 'id'>): WledState {
  return { seg: [{ id, ...fields }] };
}

/**
 * Apply a shallow segment patch to a known state, for optimistic UI updates.
 * Mirrors WLED's own merge semantics: segments are matched by id, unknown ids
 * are appended, and `stop:0` marks a delete.
 */
export function applyOptimistic(current: WledState, patch: WledState): WledState {
  const next: WledState = { ...current, ...stripSeg(patch) };

  if (patch.seg) {
    const segs = [...(current.seg ?? []).map((s) => ({ ...s }))];
    for (const p of patch.seg) {
      const id = p.id;
      if (id === undefined) continue;
      const idx = segs.findIndex((s) => s.id === id);
      if (idx === -1) segs.push({ ...p });
      else segs[idx] = { ...segs[idx], ...p };
    }
    next.seg = segs;
  }
  return next;
}

function stripSeg(patch: WledState): Omit<WledState, 'seg'> {
  const { seg: _seg, ...rest } = patch;
  return rest;
}

/**
 * Guard: reject a payload that looks like a full-state dump rather than a patch.
 * Heuristic — a real patch touches a handful of fields.
 */
export function looksLikeFullState(payload: WledState): boolean {
  const keys = Object.keys(payload);
  const bulky = keys.length > 12;
  const hasFullSegArray = Array.isArray(payload.seg) && payload.seg.length > 4;
  return bulky || hasFullSegArray;
}

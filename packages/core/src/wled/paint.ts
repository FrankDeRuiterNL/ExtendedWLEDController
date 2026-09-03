/**
 * Direct per-pixel painting via a segment's `i` (individual LEDs) field.
 *
 * NOTE: the **Paint page streams over DDP**, not `seg.i` — these helpers are
 * built and unit-tested but currently unused by the UI. Kept for the milestone-6
 * bake path (writing a static image to the device before `psave`).
 *
 * `seg.i` is a **live tool only** (build spec, "Baking"):
 * - never persisted — lost on power-off, not stored in presets;
 * - writing it freezes the segment (the running effect stops advancing) — so no
 *   explicit `frz:true` is needed first; `paintRelease` sends `frz:false` to undo;
 * - indices are **segment-relative**;
 * - a matrix is addressed as a plain row-major 1-D run (`y*w + x`),
 *   **non-serpentine**, regardless of the panel's physical wiring — this is
 *   UNVERIFIED against a real panel, so the painter UI is 1-D-strip-only for now;
 * - grouping / spacing / mirror / reverse still apply;
 * - you must send it **sequentially in small chunks** (~256 colours), never in
 *   parallel; hex strings are cheaper on the wire than `[r,g,b]` arrays;
 * - set brightness / power **before** painting — turning on from off and setting
 *   pixels in the same request does not work.
 */

import type { WledSegment, WledState } from './state.js';

/** WLED-hex for an [r,g,b] (optionally +w) tuple, no `#`. */
export function rgbToWledHex(c: readonly number[]): string {
  const h = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n || 0)))
      .toString(16)
      .padStart(2, '0')
      .toUpperCase();
  const [r = 0, g = 0, b = 0, w] = c;
  return h(r) + h(g) + h(b) + (typeof w === 'number' ? h(w) : '');
}

/** Parse a WLED hex (`RRGGBB` or `RRGGBBWW`) to `[r,g,b(,w)]`. */
export function wledHexToRgb(hex: string): number[] {
  const s = hex.replace(/^#/, '');
  const out: number[] = [];
  for (let i = 0; i + 2 <= s.length; i += 2) out.push(parseInt(s.slice(i, i + 2), 16) || 0);
  while (out.length < 3) out.push(0);
  return out;
}

/** Row-major, non-serpentine index for a matrix cell — the addressing `seg.i` uses. */
export function matrixPaintIndex(x: number, y: number, width: number): number {
  return y * Math.max(1, Math.floor(width)) + x;
}

export const PAINT_CHUNK = 256;

export interface PaintChunkOptions {
  segId?: number;
  /** Max colours per `i` write. WLED chokes on large ones; keep ≤256. */
  chunkSize?: number;
}

/**
 * Build the sequential `seg.i` writes for a **dense** pixel run (index 0..n-1).
 * Uses the `[startIndex, "hex", "hex", …]` form — one contiguous block per chunk.
 */
export function buildDensePaint(
  pixels: ReadonlyArray<readonly number[] | string>,
  opts: PaintChunkOptions = {},
): WledSegment[] {
  const segId = opts.segId ?? 0;
  const size = Math.max(1, Math.min(PAINT_CHUNK, opts.chunkSize ?? PAINT_CHUNK));
  const chunks: WledSegment[] = [];
  for (let start = 0; start < pixels.length; start += size) {
    const slice = pixels.slice(start, start + size);
    const i: Array<number | string> = [start];
    for (const px of slice) i.push(typeof px === 'string' ? px.toUpperCase() : rgbToWledHex(px));
    chunks.push({ id: segId, i });
  }
  return chunks;
}

/**
 * Build `seg.i` writes for a **sparse** set of painted pixels (the rest of the
 * strip is left running its effect). Consecutive indices are coalesced into a
 * run; each chunk stays ≤ `chunkSize` colours.
 */
export function buildSparsePaint(
  painted: ReadonlyArray<{ index: number; color: readonly number[] | string }>,
  opts: PaintChunkOptions = {},
): WledSegment[] {
  const segId = opts.segId ?? 0;
  const size = Math.max(1, Math.min(PAINT_CHUNK, opts.chunkSize ?? PAINT_CHUNK));
  // Dedupe by index — last write wins — so run/chunk accounting matches reality.
  const byIndex = new Map<number, readonly number[] | string>();
  for (const p of painted) byIndex.set(p.index, p.color);
  const sorted = [...byIndex.entries()]
    .map(([index, color]) => ({ index, color }))
    .sort((a, b) => a.index - b.index);

  const chunks: WledSegment[] = [];
  let i: Array<number | string> = [];
  let count = 0;
  let expect = -1;

  const flush = () => {
    if (i.length) chunks.push({ id: segId, i });
    i = [];
    count = 0;
    expect = -1;
  };

  for (const p of sorted) {
    const hex = typeof p.color === 'string' ? p.color.toUpperCase() : rgbToWledHex(p.color);
    if (count >= size) flush();
    if (p.index === expect) {
      i.push(hex); // continues the current run
    } else {
      i.push(p.index, hex); // new run start
    }
    expect = p.index + 1;
    count++;
  }
  flush();
  return chunks;
}

/**
 * The state POST that must land **before** any `seg.i` write: power on and set
 * the working brightness with no transition. The `seg.i` writes freeze the
 * segment on their own — no `frz:true` here (unverified whether a pre-frozen
 * segment even accepts pixel data).
 */
export function paintPreamble(brightness: number): WledState {
  return {
    on: true,
    bri: Math.max(1, Math.min(255, Math.round(brightness))),
    tt: 0,
  };
}

/** Release the segment — un-freeze so the running effect resumes. */
export function paintRelease(segId: number): WledState {
  return { seg: [{ id: segId, frz: false }] };
}

/**
 * A **rundown** is an ordered list of **cues**. Each cue puts one saved scene on
 * the stream output, optionally fading in from black, holding for a duration,
 * then fading back to black. Cues advance either on a manual GO or automatically
 * off the previous cue (a *follow* fires relative to when it started, a *wait*
 * relative to when it finished).
 *
 * This module is pure data + time math — the server's `RundownEngine` owns
 * playback and the `DdpSender` owns the actual fade. One rundown for now; it
 * persists as a single row, same as the installation.
 */

/** Longest a fade may last (8min 20s). Matches the spec's 0…500000 ms range. */
export const CUE_FADE_MAX_MS = 500_000;
/** A cue must run for at least this long before it starts fading out. */
export const CUE_MIN_DURATION_MS = 1_000;

/**
 * How a cue starts once the rundown reaches it.
 * - `manual` — waits for a GO.
 * - `follow` — auto-starts `seconds` after the previous cue **started**.
 * - `wait`   — auto-starts `seconds` after the previous cue **finished** (i.e.
 *   after its hold + fade-out).
 */
export type CueTrigger =
  | { type: 'manual' }
  | { type: 'follow'; seconds: number }
  | { type: 'wait'; seconds: number };

export interface Cue {
  /** Stable id — the React key, and how M10 triggers will reference a cue. */
  id: string;
  /** Display label / position, free text ("1", "1.5", "10a"). Not the run order. */
  number: string;
  /** Optional human name for the cue. */
  name?: string;
  /** The saved scene this cue puts on the output. `null` = not set (cue is skipped). */
  sceneId: number | null;
  trigger: CueTrigger;
  /** 0…{@link CUE_FADE_MAX_MS}. Non-zero: output starts black and fades into the scene. */
  fadeInMs: number;
  /** 0…{@link CUE_FADE_MAX_MS}. Non-zero: at the end of the run the output fades to black. */
  fadeOutMs: number;
  /** How long the cue holds at full before it starts its fade-out (≥ {@link CUE_MIN_DURATION_MS}). */
  durationMs: number;
}

export interface Rundown {
  cues: Cue[];
}

export const EMPTY_RUNDOWN: Rundown = { cues: [] };

/** Total wall-clock time a cue occupies: fade-in + hold + fade-out. */
export function cueTotalMs(cue: Pick<Cue, 'fadeInMs' | 'durationMs' | 'fadeOutMs'>): number {
  return Math.max(0, cue.fadeInMs) + Math.max(0, cue.durationMs) + Math.max(0, cue.fadeOutMs);
}

export type CuePhase = 'fade-in' | 'hold' | 'fade-out' | 'done';

/** Which part of its run a cue is in, `ms` after it started. */
export function cuePhaseAt(
  cue: Pick<Cue, 'fadeInMs' | 'durationMs' | 'fadeOutMs'>,
  ms: number,
): CuePhase {
  const fi = Math.max(0, cue.fadeInMs);
  const hold = fi + Math.max(0, cue.durationMs);
  const end = hold + Math.max(0, cue.fadeOutMs);
  if (ms < fi) return 'fade-in';
  if (ms < hold) return 'hold';
  if (ms < end) return 'fade-out';
  return 'done';
}

/**
 * Master output level (0…1) a cue wants `ms` after it started — the ramp the
 * `DdpSender` applies. Linear, matching `DdpSender.fadeTo`.
 */
export function cueLevelAt(
  cue: Pick<Cue, 'fadeInMs' | 'durationMs' | 'fadeOutMs'>,
  ms: number,
): number {
  const fi = Math.max(0, cue.fadeInMs);
  const hold = fi + Math.max(0, cue.durationMs);
  const fo = Math.max(0, cue.fadeOutMs);
  if (ms <= 0) return fi > 0 ? 0 : 1;
  if (ms < fi) return ms / fi;
  if (ms < hold) return 1;
  if (fo <= 0) return 0;
  const t = (ms - hold) / fo;
  return t >= 1 ? 0 : 1 - t;
}

/**
 * When cue `next` should auto-fire relative to the start of cue `prev`, in ms —
 * or `null` if `next` is manual (waits for a GO). A `follow` is measured from
 * `prev` starting, a `wait` from `prev` finishing (`cueTotalMs(prev)` later).
 */
export function autoFireDelayMs(prev: Cue, next: Cue): number | null {
  switch (next.trigger.type) {
    case 'manual':
      return null;
    case 'follow':
      return Math.max(0, next.trigger.seconds * 1000);
    case 'wait':
      return cueTotalMs(prev) + Math.max(0, next.trigger.seconds * 1000);
  }
}

const pad = (n: number) => String(n).padStart(2, '0');

/** ms → `h:mm:ss` (or `m:ss` under an hour). Used for cue durations + countdowns. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * Parse a duration entered as `h:mm:ss`, `m:ss`, or bare seconds (`35`, `1.5`)
 * into ms. Returns `null` when it can't be read. Colon-delimited parts don't
 * have to be zero-padded; the last part may be fractional.
 */
export function parseDuration(text: string): number | null {
  const t = text.trim();
  if (!t) return null;
  const parts = t.split(':').map((p) => p.trim());
  if (parts.some((p) => p === '' || !/^\d*\.?\d*$/.test(p) || Number.isNaN(Number(p)))) return null;
  if (parts.length > 3) return null;
  const nums = parts.map(Number);
  let seconds = 0;
  if (nums.length === 1) seconds = nums[0]!;
  else if (nums.length === 2) seconds = nums[0]! * 60 + nums[1]!;
  else seconds = nums[0]! * 3600 + nums[1]! * 60 + nums[2]!;
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.round(seconds * 1000);
}

let cueSeq = 0;
/** Fresh cue id — time + counter so a burst of adds stays unique. */
export function newCueId(): string {
  return `cue-${Date.now().toString(36)}-${cueSeq++}`;
}

/** A new cue with sane defaults: manual, no fades, 5s hold. */
export function makeCue(number: string): Cue {
  return {
    id: newCueId(),
    number,
    sceneId: null,
    trigger: { type: 'manual' },
    fadeInMs: 0,
    fadeOutMs: 0,
    durationMs: 5_000,
  };
}

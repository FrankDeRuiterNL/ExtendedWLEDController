/** DTOs for the rundown store + engine (milestone 9). */

import type { Cue, CueTrigger, Rundown } from '../rundown/model.js';

export interface RundownDTO {
  rundown: Rundown;
  updatedAt: string;
}

export interface SaveRundownRequest {
  rundown: Rundown;
}

/** Live playback state — everything is derived from wall-clock, safe to poll. */
export interface RundownStatusDTO {
  /** A cue is loaded (started and not stopped) — the rundown has a playhead. */
  active: boolean;
  /** The stream is actually sending frames for this rundown. */
  streaming: boolean;
  currentCueId: string | null;
  /** `fade-in` | `hold` | `fade-out` | `done` (`done` = holding at black, awaiting the next trigger/GO). */
  phase: 'idle' | 'fade-in' | 'hold' | 'fade-out' | 'done';
  /** ms since the current cue started (covers its whole fade-in + hold + fade-out). */
  elapsedMs: number;
  /** fade-in + hold + fade-out for the current cue. */
  cueTotalMs: number;
  /** Current master output level 0…1 — drives the progress/level bar. */
  level: number;
  nextCueId: string | null;
  nextTrigger: CueTrigger | null;
  /** ms until the next cue auto-fires, or `null` when it's manual (waiting for GO). */
  nextFiresInMs: number | null;
  /** Set when the current cue's scene id no longer resolves to a saved scene. */
  warning: string | null;
}

export type { Cue, CueTrigger, Rundown };

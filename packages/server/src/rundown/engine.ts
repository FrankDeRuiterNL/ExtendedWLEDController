import {
  autoFireDelayMs,
  cueLevelAt,
  cuePhaseAt,
  cueTotalMs,
  type Cue,
  type RundownStatusDTO,
} from '@ewc/core';
import { log } from '../logger.js';
import type { SceneStore } from '../render/sceneStore.js';
import type { StreamService } from '../realtime/streamService.js';
import type { RundownStore } from './store.js';

/**
 * Plays a rundown: on GO (manual or an auto-follow/wait off the previous cue) it
 * loads the cue's saved scene onto the stream, fades it in from black, holds for
 * the cue's duration, then fades to black. All playback state is wall-clock —
 * `status()` derives phase / elapsed / level from `startedMs`, so a 1 s poll
 * never drifts.
 *
 * The engine owns exactly one thing the `DdpSender` doesn't: the schedule. Every
 * pending transition is a timer in {@link timers}; {@link clearTimers} is the one
 * place they're cancelled, and {@link halt} is idempotent.
 */
export class RundownEngine {
  private currentCueId: string | null = null;
  private startedMs = 0;
  private timers: NodeJS.Timeout[] = [];
  private warning: string | null = null;

  constructor(
    private readonly store: RundownStore,
    private readonly scenes: SceneStore,
    private readonly stream: StreamService,
  ) {
    // The stream leaving our control (a manual scene/solid/pattern/paint
    // takeover, or a plain Stop) must drop the playhead and kill our timers —
    // but NOT re-stop the stream, which the other side is already handling.
    this.stream.onExternalStreamStart = () => this.dropPlayhead();
    this.stream.onStopped = () => this.dropPlayhead();
  }

  private cues(): Cue[] {
    return this.store.get().cues;
  }

  private clearTimers(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  /** Next cue index at/after `from` whose scene still resolves, or -1. */
  private nextPlayable(from: number): number {
    const cues = this.cues();
    for (let i = Math.max(0, from); i < cues.length; i++) {
      const c = cues[i]!;
      if (c.sceneId != null && this.scenes.get(c.sceneId)) return i;
    }
    return -1;
  }

  private indexOf(cueId: string | null): number {
    if (!cueId) return -1;
    return this.cues().findIndex((c) => c.id === cueId);
  }

  /** Manual GO — start the first playable cue, or advance past the current one. */
  go(): RundownStatusDTO {
    const from = this.currentCueId == null ? 0 : this.indexOf(this.currentCueId) + 1;
    const idx = this.nextPlayable(from);
    if (idx < 0) {
      if (this.currentCueId == null) this.warning = 'No playable cue — every cue is missing its scene.';
      return this.status();
    }
    this.startCue(this.cues()[idx]!);
    return this.status();
  }

  /** Jump straight to a specific cue (a row click), even one earlier in the list. */
  goCue(cueId: string): RundownStatusDTO {
    const cue = this.cues().find((c) => c.id === cueId);
    if (!cue) return this.status();
    if (cue.sceneId == null || !this.scenes.get(cue.sceneId)) {
      this.warning = `Cue ${cue.number} has no saved scene.`;
      return this.status();
    }
    this.startCue(cue);
    return this.status();
  }

  /** Explicit Stop — drop the playhead AND tear the stream down (releases devices). */
  halt(): RundownStatusDTO {
    const wasActive = this.currentCueId != null || this.timers.length > 0;
    this.dropPlayhead();
    void this.stream.stop();
    if (wasActive) log.info('rundown: halted');
    return this.status();
  }

  /** Cancel timers + drop the playhead. Does NOT touch the stream — the caller
   *  (or the takeover that triggered this) owns that. */
  private dropPlayhead(): void {
    this.clearTimers();
    this.currentCueId = null;
    this.startedMs = 0;
  }

  /** Re-resolve a cue by id at fire time — it may have been deleted or reordered
   *  while the previous cue was running (editing during playback is allowed). */
  private startCueById(cueId: string): void {
    const cue = this.cues().find((c) => c.id === cueId);
    if (!cue) {
      // The scheduled cue is gone — end the run cleanly rather than throw.
      this.dropPlayhead();
      void this.stream.stop();
      return;
    }
    this.startCue(cue);
  }

  private startCue(cue: Cue): void {
    this.clearTimers();
    const stored = cue.sceneId != null ? this.scenes.get(cue.sceneId) : null;
    if (!stored) {
      this.warning = `Cue ${cue.number} has no saved scene.`;
      return;
    }
    this.warning = null;

    const fadeIn = Math.max(0, cue.fadeInMs);
    // Come up black so a non-zero fade-in always fades *from* black (spec), even
    // cue-to-cue where the previous look was at full.
    this.stream.setMaster(fadeIn > 0 ? 0 : 1);
    this.stream.streamRundownCue(stored.scene);
    this.stream.setMaster(fadeIn > 0 ? 0 : 1); // streamRundownCue may have called sender.start(), which resets to 1
    if (fadeIn > 0) this.stream.fadeMaster(1, fadeIn);

    this.currentCueId = cue.id;
    this.startedMs = Date.now();
    log.info(`rundown: cue ${cue.number} "${stored.name}" — fade ${fadeIn}ms / hold ${cue.durationMs}ms`);

    // Fade-out at the end of the hold.
    const holdEnd = fadeIn + Math.max(0, cue.durationMs);
    const fadeOut = Math.max(0, cue.fadeOutMs);
    this.timers.push(
      setTimeout(() => {
        if (fadeOut > 0) this.stream.fadeMaster(0, fadeOut);
        else this.stream.setMaster(0);
      }, holdEnd),
    );

    // Auto-advance to the next cue, if it isn't Manual. The timer captures the
    // cue *id* — the list may be edited before it fires.
    const cues = this.cues();
    const nextIdx = this.nextPlayable(cues.findIndex((c) => c.id === cue.id) + 1);
    if (nextIdx >= 0) {
      const next = cues[nextIdx]!;
      const delay = autoFireDelayMs(cue, next);
      if (delay != null) {
        this.timers.push(setTimeout(() => this.startCueById(next.id), Math.max(0, delay)));
      }
    }
  }

  status(): RundownStatusDTO {
    const cues = this.cues();
    // The current cue may have been deleted mid-run — drop the playhead so the
    // status reads idle rather than "active with no cue".
    if (this.currentCueId != null && !cues.some((c) => c.id === this.currentCueId)) {
      this.dropPlayhead();
    }
    const idx = this.indexOf(this.currentCueId);
    const cue = idx >= 0 ? cues[idx] : undefined;

    let phase: RundownStatusDTO['phase'] = 'idle';
    let elapsedMs = 0;
    let total = 0;
    if (cue) {
      elapsedMs = Date.now() - this.startedMs;
      total = cueTotalMs(cue);
      phase = cuePhaseAt(cue, elapsedMs);
    }

    // Next cue + when it fires.
    let nextCueId: string | null = null;
    let nextTrigger: RundownStatusDTO['nextTrigger'] = null;
    let nextFiresInMs: number | null = null;
    if (cue) {
      const nextIdx = this.nextPlayable(idx + 1);
      if (nextIdx >= 0) {
        const next = cues[nextIdx]!;
        nextCueId = next.id;
        nextTrigger = next.trigger;
        const delay = autoFireDelayMs(cue, next);
        nextFiresInMs = delay == null ? null : Math.max(0, delay - elapsedMs);
      }
    } else if (this.currentCueId == null) {
      const firstIdx = this.nextPlayable(0);
      if (firstIdx >= 0) {
        nextCueId = cues[firstIdx]!.id;
        nextTrigger = { type: 'manual' };
      }
    }

    return {
      active: this.currentCueId != null,
      streaming: this.currentCueId != null && this.stream.running,
      currentCueId: this.currentCueId,
      phase,
      elapsedMs: Math.max(0, elapsedMs),
      cueTotalMs: total,
      level: cue ? cueLevelAt(cue, elapsedMs) : this.stream.masterLevel,
      nextCueId,
      nextTrigger,
      nextFiresInMs,
      warning: this.warning,
    };
  }

  shutdown(): void {
    this.clearTimers();
  }
}

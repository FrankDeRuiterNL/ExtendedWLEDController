import type { Scene } from '@ewc/core';

/**
 * A snapshot of the Scenes editor that outlives navigating away from the page.
 * `StudioPage` keeps everything in local `useState`, so leaving the route used
 * to discard an unsaved scene even while it was still streaming to the wall —
 * you'd come back to an empty canvas with the fixtures still lit. We stash the
 * draft here whenever there are unsaved changes (or it's on the wire) and
 * restore it on the next mount.
 *
 * Storage: a module variable (survives client-side navigation) mirrored to
 * `sessionStorage` (survives an accidental reload, dies with the tab — which is
 * the right lifetime for a scratch edit). The sessionStorage write is debounced
 * so a param-slider drag doesn't stringify the scene on every tick.
 */
export interface StudioDraft {
  scene: Scene;
  /** The saved scene this draft is based on, or null for an unsaved "New scene". */
  sceneId: number | null;
  dirty: boolean;
  /** Was this draft the scene being streamed when the user left? */
  liveSync: boolean;
  selectedLayerId: string | null;
}

const KEY = 'ewc.studio.draft';

let mem: StudioDraft | null = null;
let flushTimer: ReturnType<typeof setTimeout> | undefined;

export function saveStudioDraft(draft: StudioDraft): void {
  mem = draft;
  clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    try {
      sessionStorage.setItem(KEY, JSON.stringify(mem));
    } catch {
      /* private mode / quota — the module var still carries the draft */
    }
  }, 250);
}

export function loadStudioDraft(): StudioDraft | null {
  if (mem) return mem;
  try {
    const raw = sessionStorage.getItem(KEY);
    if (raw) {
      mem = JSON.parse(raw) as StudioDraft;
      return mem;
    }
  } catch {
    /* corrupt / unavailable — no draft */
  }
  return null;
}

export function clearStudioDraft(): void {
  mem = null;
  clearTimeout(flushTimer);
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

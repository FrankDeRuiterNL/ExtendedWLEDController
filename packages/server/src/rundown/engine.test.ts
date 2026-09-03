import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeCue, type Cue, type Scene } from '@ewc/core';
import { RundownEngine } from './engine.js';
import type { RundownStore } from './store.js';
import type { SceneStore } from '../render/sceneStore.js';
import type { StreamService } from '../realtime/streamService.js';

const scene = (name: string): Scene => ({ name, background: [0, 0, 0], layers: [] });

/** Records every stream call the engine makes. */
function fakeStream() {
  const calls: string[] = [];
  let running = false;
  let master = 1;
  const s = {
    calls,
    get running() {
      return running;
    },
    get masterLevel() {
      return master;
    },
    onExternalStreamStart: undefined as undefined | (() => void),
    onStopped: undefined as undefined | (() => void),
    setMaster(l: number) {
      master = l;
      calls.push(`setMaster(${l})`);
    },
    fadeMaster(l: number, ms: number) {
      calls.push(`fadeMaster(${l},${ms})`);
    },
    streamRundownCue(sc: Scene) {
      running = true;
      calls.push(`stream(${sc.name})`);
    },
    async stop() {
      running = false;
      calls.push('stop');
      s.onStopped?.();
    },
  };
  return s as unknown as StreamService & { calls: string[] };
}

function engineWith(cues: Cue[], sceneIds: number[] = [1, 2, 3]) {
  const store = { get: () => ({ cues }) } as unknown as RundownStore;
  const scenes = {
    get: (id: number) => (sceneIds.includes(id) ? { id, name: `S${id}`, scene: scene(`S${id}`) } : null),
  } as unknown as SceneStore;
  const stream = fakeStream();
  const engine = new RundownEngine(store, scenes, stream);
  return { engine, stream };
}

const cue = (over: Partial<Cue>): Cue => ({ ...makeCue('1'), sceneId: 1, durationMs: 4000, ...over });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('RundownEngine', () => {
  it('GO with no playable cue stays idle', () => {
    const { engine } = engineWith([]);
    const st = engine.go();
    expect(st.active).toBe(false);
    expect(st.currentCueId).toBeNull();
  });

  it('GO starts the first cue and fades in from black', () => {
    const c1 = cue({ id: 'a', number: '1', fadeInMs: 1000, fadeOutMs: 500, durationMs: 4000 });
    const { engine, stream } = engineWith([c1]);
    const st = engine.go();

    expect(stream.calls).toEqual(['setMaster(0)', 'stream(S1)', 'setMaster(0)', 'fadeMaster(1,1000)']);
    expect(st.active).toBe(true);
    expect(st.currentCueId).toBe('a');
    expect(st.phase).toBe('fade-in');
  });

  it('no fade-in → comes up at full', () => {
    const { engine, stream } = engineWith([cue({ id: 'a', fadeInMs: 0 })]);
    engine.go();
    expect(stream.calls).toEqual(['setMaster(1)', 'stream(S1)', 'setMaster(1)']);
  });

  it('starts the fade-out when the hold ends', () => {
    const { engine, stream } = engineWith([
      cue({ id: 'a', fadeInMs: 1000, durationMs: 4000, fadeOutMs: 2000, trigger: { type: 'manual' } }),
    ]);
    engine.go();
    stream.calls.length = 0;

    vi.advanceTimersByTime(4999); // still in the hold
    expect(stream.calls).toEqual([]);
    vi.advanceTimersByTime(1); // holdEnd = fadeIn 1000 + duration 4000
    expect(stream.calls).toEqual(['fadeMaster(0,2000)']);
  });

  it('a Follow cue auto-fires N seconds after the previous cue STARTS', () => {
    const c1 = cue({ id: 'a', fadeInMs: 0, durationMs: 10_000 });
    const c2 = cue({ id: 'b', sceneId: 2, fadeInMs: 0, trigger: { type: 'follow', seconds: 3 } });
    const { engine, stream } = engineWith([c1, c2]);
    engine.go();
    stream.calls.length = 0;

    vi.advanceTimersByTime(2999);
    expect(stream.calls).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(stream.calls).toContain('stream(S2)');
    expect(engine.status().currentCueId).toBe('b');
  });

  it('a Wait cue auto-fires after the previous cue FINISHES (whole run + delay)', () => {
    // c1 total = 0 + 4000 + 1000 = 5000; wait +2s → fires at 7000
    const c1 = cue({ id: 'a', fadeInMs: 0, durationMs: 4000, fadeOutMs: 1000 });
    const c2 = cue({ id: 'b', sceneId: 2, fadeInMs: 0, trigger: { type: 'wait', seconds: 2 } });
    const { engine, stream } = engineWith([c1, c2]);
    engine.go();
    stream.calls.length = 0;

    vi.advanceTimersByTime(4000); // holdEnd → fade-out starts, but c2 hasn't fired
    expect(stream.calls).toEqual(['fadeMaster(0,1000)']);
    vi.advanceTimersByTime(2999); // still before 7000
    expect(stream.calls.filter((c) => c.startsWith('stream'))).toEqual([]);
    vi.advanceTimersByTime(1); // t = 7000 → c2 fires
    expect(stream.calls).toContain('stream(S2)');
  });

  it('halt cancels every pending timer and stops the stream', () => {
    const c1 = cue({ id: 'a', durationMs: 10_000 });
    const c2 = cue({ id: 'b', sceneId: 2, trigger: { type: 'follow', seconds: 5 } });
    const { engine, stream } = engineWith([c1, c2]);
    engine.go();
    stream.calls.length = 0;

    engine.halt();
    expect(stream.calls).toContain('stop');
    expect(engine.status().active).toBe(false);

    vi.advanceTimersByTime(60_000);
    expect(stream.calls.filter((c) => c.startsWith('stream'))).toEqual([]);
  });

  it('an external stream takeover drops the playhead without re-stopping the stream', () => {
    const c1 = cue({ id: 'a', durationMs: 10_000 });
    const c2 = cue({ id: 'b', sceneId: 2, trigger: { type: 'follow', seconds: 5 } });
    const { engine, stream } = engineWith([c1, c2]);
    engine.go();
    stream.calls.length = 0;

    stream.onExternalStreamStart!(); // Scenes page "Stream this scene"
    expect(engine.status().active).toBe(false);
    expect(stream.calls).not.toContain('stop'); // the new owner handles the stream

    vi.advanceTimersByTime(60_000);
    expect(stream.calls.filter((c) => c.startsWith('stream'))).toEqual([]);
  });

  it('status reports the next cue and its manual/auto countdown', () => {
    const c1 = cue({ id: 'a', fadeInMs: 0, durationMs: 10_000, fadeOutMs: 0 });
    const c2 = cue({ id: 'b', sceneId: 2, trigger: { type: 'follow', seconds: 4 } });
    const { engine } = engineWith([c1, c2]);
    engine.go();

    const st = engine.status();
    expect(st.nextCueId).toBe('b');
    expect(st.nextFiresInMs).toBeGreaterThan(3000);
    expect(st.nextFiresInMs).toBeLessThanOrEqual(4000);
  });

  it('survives the pending next cue being deleted mid-run', () => {
    const cues: Cue[] = [
      cue({ id: 'a', fadeInMs: 0, durationMs: 10_000, fadeOutMs: 0 }),
      cue({ id: 'b', sceneId: 2, trigger: { type: 'follow', seconds: 3 } }),
    ];
    const store = { get: () => ({ cues }) } as unknown as RundownStore;
    const scenes = {
      get: (id: number) => ([1, 2].includes(id) ? { id, name: `S${id}`, scene: scene(`S${id}`) } : null),
    } as unknown as SceneStore;
    const stream = fakeStream();
    const engine = new RundownEngine(store, scenes, stream);

    engine.go();
    stream.calls.length = 0;
    // Edit the list: drop cue b while cue a runs with b's follow timer pending.
    cues.splice(1, 1);

    expect(() => vi.advanceTimersByTime(10_000)).not.toThrow();
    expect(stream.calls.filter((c) => c.startsWith('stream'))).toEqual([]);
    expect(engine.status().active).toBe(false);
  });

  it('status drops the playhead if the running cue is deleted', () => {
    const cues: Cue[] = [cue({ id: 'a', fadeInMs: 0, durationMs: 10_000 })];
    const store = { get: () => ({ cues }) } as unknown as RundownStore;
    const scenes = {
      get: (id: number) => (id === 1 ? { id, name: 'S1', scene: scene('S1') } : null),
    } as unknown as SceneStore;
    const engine = new RundownEngine(store, scenes, fakeStream());
    engine.go();
    expect(engine.status().active).toBe(true);
    cues.splice(0, 1);
    expect(engine.status().active).toBe(false);
    expect(engine.status().phase).toBe('idle');
  });

  it('skips cues whose scene is missing', () => {
    const c1 = cue({ id: 'a', sceneId: 99, fadeInMs: 0 }); // no such scene
    const c2 = cue({ id: 'b', sceneId: 2, fadeInMs: 0 });
    const { engine, stream } = engineWith([c1, c2]);
    engine.go();
    expect(stream.calls).toContain('stream(S2)');
    expect(engine.status().currentCueId).toBe('b');
  });
});

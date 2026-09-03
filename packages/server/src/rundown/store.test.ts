import { describe, expect, it } from 'vitest';
import { openDb } from '../db/index.js';
import { RundownStore } from './store.js';

describe('RundownStore', () => {
  it('starts empty and round-trips a cue list through SQLite', () => {
    const db = openDb(':memory:');
    const store = new RundownStore(db);

    expect(store.get()).toEqual({ cues: [] });

    const rundown = {
      cues: [
        {
          id: 'c1',
          number: '1',
          name: 'Opening',
          sceneId: 3,
          trigger: { type: 'manual' as const },
          fadeInMs: 2000,
          fadeOutMs: 0,
          durationMs: 30_000,
        },
        {
          id: 'c2',
          number: '2',
          sceneId: 4,
          trigger: { type: 'wait' as const, seconds: 5 },
          fadeInMs: 0,
          fadeOutMs: 1500,
          durationMs: 12_000,
        },
      ],
    };
    store.save(rundown);

    const back = new RundownStore(db).get();
    expect(back.cues).toHaveLength(2);
    expect(back.cues[0]!.name).toBe('Opening');
    expect(back.cues[1]!.trigger).toEqual({ type: 'wait', seconds: 5 });

    db.close();
  });

  it('rejects a bad fade and an unknown trigger type', () => {
    const db = openDb(':memory:');
    const store = new RundownStore(db);
    expect(() =>
      store.save({ cues: [{ ...validCue(), fadeInMs: 9_999_999 }] }),
    ).toThrow();
    expect(() =>
      store.save({ cues: [{ ...validCue(), trigger: { type: 'nope' } }] }),
    ).toThrow();
    db.close();
  });
});

const validCue = () => ({
  id: 'x',
  number: '1',
  sceneId: null,
  trigger: { type: 'manual' as const },
  fadeInMs: 0,
  fadeOutMs: 0,
  durationMs: 5000,
});

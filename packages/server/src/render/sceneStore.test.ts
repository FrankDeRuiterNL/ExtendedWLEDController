import { describe, expect, it } from 'vitest';
import type { Scene } from '@ewc/core';
import { openDb } from '../db/index.js';
import { SceneStore } from './sceneStore.js';

const videoScene = (): Scene => ({
  name: 'v',
  background: [0, 0, 0],
  layers: [
    {
      id: 'm',
      effectId: '',
      params: {},
      blend: 'normal',
      opacity: 1,
      enabled: true,
      rect: { x: 0, y: 0, w: 1, h: 1 },
      mask: null,
      media: {
        assetId: 'abc',
        filename: 'clip.mp4',
        kind: 'video',
        naturalWidth: 640,
        naturalHeight: 360,
        durationMs: 4000,
        trimInMs: 500,
        trimOutMs: 3500,
        playbackType: 'hold',
        playback: { state: 'paused', anchorMs: 123, headMs: 900 },
      },
    },
  ],
});

describe('SceneStore — media layer persistence', () => {
  it('persists trim + playbackType but strips the transient playback state', () => {
    const db = openDb(':memory:');
    const store = new SceneStore(db);

    const created = store.create('v', videoScene());
    const media = created.scene.layers[0]!.media!;
    expect(media.trimInMs).toBe(500);
    expect(media.trimOutMs).toBe(3500);
    expect(media.playbackType).toBe('hold');
    expect(media.durationMs).toBe(4000);
    expect(media.playback ?? null).toBeNull();

    // and it's actually gone from the stored JSON, not just the DTO
    const raw = db.prepare('SELECT data_json FROM scenes WHERE id = ?').get(created.id) as {
      data_json: string;
    };
    const storedMedia = JSON.parse(raw.data_json).layers[0].media;
    expect(storedMedia).not.toHaveProperty('playback');
    expect(storedMedia.playbackType).toBe('hold');

    db.close();
  });
});

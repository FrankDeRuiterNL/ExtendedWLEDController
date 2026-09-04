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

const textScene = (): Scene => ({
  name: 'tx',
  background: [0, 0, 0],
  layers: [
    {
      id: 't',
      effectId: '',
      params: {},
      blend: 'normal',
      opacity: 1,
      enabled: true,
      rect: { x: 0, y: 0, w: 1, h: 1 },
      mask: null,
      text: {
        value: 'STAGE 3',
        fontId: 'oswald',
        sizePx: 120,
        bold: true,
        color: [255, 180, 0],
        assetId: 'txt-asset',
        naturalWidth: 512,
        naturalHeight: 128,
        renderHash: '["STAGE 3","oswald",120,true,false,false,[255,180,0]]',
      },
    },
  ],
});

describe('SceneStore — text layer persistence', () => {
  it('round-trips a text layer spec through save + load', () => {
    const db = openDb(':memory:');
    const store = new SceneStore(db);

    const created = store.create('tx', textScene());
    const reloaded = store.get(created.id)!.scene.layers[0]!.text!;
    expect(reloaded.value).toBe('STAGE 3');
    expect(reloaded.fontId).toBe('oswald');
    expect(reloaded.sizePx).toBe(120);
    expect(reloaded.bold).toBe(true);
    expect(reloaded.color).toEqual([255, 180, 0]);
    expect(reloaded.assetId).toBe('txt-asset');

    db.close();
  });
});

describe('SceneStore — layer rect rotation', () => {
  it('round-trips rect.rot and rejects an out-of-range angle', () => {
    const db = openDb(':memory:');
    const store = new SceneStore(db);

    const scene: Scene = {
      name: 'r',
      background: [0, 0, 0],
      layers: [
        {
          id: 'a',
          effectId: 'solid',
          params: { color: [1, 2, 3] },
          blend: 'normal',
          opacity: 1,
          enabled: true,
          rect: { x: 0.1, y: 0.1, w: 0.5, h: 0.3, rot: -37 },
          mask: null,
        },
      ],
    };
    const created = store.create('r', scene);
    expect(store.get(created.id)!.scene.layers[0]!.rect!.rot).toBe(-37);

    const bad = structuredClone(scene);
    bad.layers[0]!.rect!.rot = 720;
    expect(() => store.create('bad', bad)).toThrow();

    db.close();
  });
});

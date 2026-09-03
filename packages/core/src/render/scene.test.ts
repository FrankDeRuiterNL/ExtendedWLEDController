import { describe, expect, it } from 'vitest';
import { mapInstallation } from '../mapping/engine.js';
import type { Installation } from '../mapping/model.js';
import { blend } from './blend.js';
import { listEffects, getEffect, effectIds } from './registry.js';
import { EMPTY_SCENE, makeLayer, sampleScene, unknownEffectIds, type Scene } from './scene.js';
import { defaultParamValues } from './types.js';

describe('blend', () => {
  it('normal at alpha 1 replaces the destination', () => {
    expect(blend([10, 20, 30], [200, 100, 50, 1], 'normal')).toEqual([200, 100, 50]);
  });
  it('alpha 0 is a no-op regardless of mode', () => {
    for (const m of ['normal', 'add', 'screen', 'multiply', 'lighten'] as const) {
      expect(blend([10, 20, 30], [255, 255, 255, 0], m)).toEqual([10, 20, 30]);
    }
  });
  it('add sums and clamps at 255', () => {
    expect(blend([200, 10, 0], [100, 20, 0, 1], 'add')).toEqual([255, 30, 0]);
  });
  it('multiply by black is black, by white is unchanged', () => {
    expect(blend([180, 90, 40], [0, 0, 0, 1], 'multiply')).toEqual([0, 0, 0]);
    expect(blend([180, 90, 40], [255, 255, 255, 1], 'multiply')).toEqual([180, 90, 40]);
  });
  it('half alpha cross-fades toward the blended colour', () => {
    expect(blend([0, 0, 0], [255, 255, 255, 0.5], 'normal')).toEqual([128, 128, 128]);
  });
});

describe('effect registry', () => {
  it('exposes all ten starter effects with unique ids', () => {
    const ids = effectIds();
    expect(ids).toHaveLength(10);
    expect(new Set(ids).size).toBe(10);
    expect(ids).toEqual(
      expect.arrayContaining([
        'solid', 'gradient', 'rainbow', 'plasma', 'fire',
        'wipe', 'chase', 'comet', 'scanner', 'sparkle',
      ]),
    );
  });

  it('every effect returns a 4-tuple in range for a spread of coords/times', () => {
    for (const def of listEffects()) {
      const p = defaultParamValues(def);
      for (const [x, y, t] of [[0, 0, 0], [0.5, 0.5, 1.3], [1, 1, 9.9], [0.2, 0.8, 4]]) {
        const c = def.render(x!, y!, t!, p);
        expect(c).toHaveLength(4);
        for (let i = 0; i < 3; i++) expect(c[i]).toBeGreaterThanOrEqual(0);
        for (let i = 0; i < 3; i++) expect(c[i]).toBeLessThanOrEqual(255);
        expect(c[3]).toBeGreaterThanOrEqual(0);
        expect(c[3]).toBeLessThanOrEqual(1);
      }
    }
  });

  it('effects are pure — same inputs, same output', () => {
    for (const def of listEffects()) {
      const p = defaultParamValues(def);
      expect(def.render(0.31, 0.42, 2.5, p)).toEqual(def.render(0.31, 0.42, 2.5, p));
    }
  });

  it('solid returns exactly its colour, fully opaque', () => {
    const solid = getEffect('solid')!;
    expect(solid.render(0.7, 0.1, 5, { color: [12, 34, 56] })).toEqual([12, 34, 56, 1]);
  });

  it('gradient hits its endpoint colours', () => {
    const g = getEffect('gradient')!;
    const p = { from: [255, 0, 0], to: [0, 0, 255], angle: 0, mirror: false };
    expect(g.render(0, 0.5, 0, p)).toEqual([255, 0, 0, 1]);
    expect(g.render(1, 0.5, 0, p)).toEqual([0, 0, 255, 1]);
  });
});

describe('sampleScene', () => {
  it('empty scene is the background colour', () => {
    const s: Scene = { ...EMPTY_SCENE, background: [7, 8, 9] };
    expect(sampleScene(s, 0.5, 0.5, 0)).toEqual([7, 8, 9]);
  });

  it('one opaque solid layer overrides the background', () => {
    const s: Scene = {
      name: 't', background: [0, 0, 0],
      layers: [{ ...makeLayer('a', 'solid'), params: { color: [10, 20, 30] } }],
    };
    expect(sampleScene(s, 0.5, 0.5, 0)).toEqual([10, 20, 30]);
  });

  it('a layer at opacity 0 is byte-identical to removing it', () => {
    const base: Scene = {
      name: 't', background: [5, 5, 5],
      layers: [{ ...makeLayer('a', 'gradient'), params: { from: [255, 0, 0], to: [0, 255, 0] } }],
    };
    const withDisabled: Scene = {
      ...base,
      layers: [...base.layers, { ...makeLayer('b', 'solid'), opacity: 0, params: { color: [1, 2, 3] } }],
    };
    const withEnabledFalse: Scene = {
      ...base,
      layers: [...base.layers, { ...makeLayer('c', 'solid'), enabled: false, params: { color: [1, 2, 3] } }],
    };
    for (const [x, y, t] of [[0, 0, 0], [0.4, 0.6, 2], [1, 1, 7]]) {
      const want = sampleScene(base, x!, y!, t!);
      expect(sampleScene(withDisabled, x!, y!, t!)).toEqual(want);
      expect(sampleScene(withEnabledFalse, x!, y!, t!)).toEqual(want);
    }
  });

  it('opacity 0.5 normal-blends against the layer below', () => {
    const s: Scene = {
      name: 't', background: [0, 0, 0],
      layers: [
        { ...makeLayer('a', 'solid'), params: { color: [0, 0, 0] } },
        { ...makeLayer('b', 'solid'), opacity: 0.5, params: { color: [255, 255, 255] } },
      ],
    };
    expect(sampleScene(s, 0.5, 0.5, 0)).toEqual([128, 128, 128]);
  });

  it('a solid black mask hides the layer; white mask passes it', () => {
    const lit: Scene = {
      name: 't', background: [0, 0, 0],
      layers: [{
        ...makeLayer('a', 'solid'),
        params: { color: [200, 200, 200] },
        mask: { effectId: 'solid', params: { color: [255, 255, 255] } },
      }],
    };
    const hidden: Scene = {
      ...lit,
      layers: [{ ...lit.layers[0]!, mask: { effectId: 'solid', params: { color: [0, 0, 0] } } }],
    };
    expect(sampleScene(lit, 0.5, 0.5, 0)).toEqual([200, 200, 200]);
    expect(sampleScene(hidden, 0.5, 0.5, 0)).toEqual([0, 0, 0]);
  });

  it('samples consistently with the mapping engine (preview == wire coords)', () => {
    // one 50-LED strip spanning the whole canvas, wire index 0..49 → x 0..1
    const inst: Installation = {
      canvas: { width: 16, height: 9 },
      fixtures: [{
        id: 'f', deviceId: 1, name: 's', startIndex: 0,
        geometry: { kind: 'strip', count: 50 },
        transform: { position: { x: 8, y: 4.5 }, rotationDeg: 0, size: { x: 16, y: 1 } },
        enabled: true,
      }],
    };
    const scene: Scene = {
      name: 't', background: [0, 0, 0],
      layers: [{
        ...makeLayer('a', 'gradient'),
        params: { from: [255, 0, 0], to: [0, 0, 255], angle: 0, mirror: false },
      }],
    };
    const mapped = mapInstallation(inst);
    const first = mapped.find((m) => m.index === 0)!;
    const last = mapped.find((m) => m.index === 49)!;
    expect(sampleScene(scene, first.x, first.y, 0)).toEqual([255, 0, 0]);
    expect(sampleScene(scene, last.x, last.y, 0)).toEqual([0, 0, 255]);
  });

  it('a layer rect confines the effect to its box; outside shows the background', () => {
    const s: Scene = {
      name: 't', background: [5, 6, 7],
      layers: [{
        ...makeLayer('a', 'solid'),
        params: { color: [200, 100, 0] },
        rect: { x: 0, y: 0, w: 0.5, h: 1 }, // left half only
      }],
    };
    expect(sampleScene(s, 0.25, 0.5, 0)).toEqual([200, 100, 0]); // inside box
    expect(sampleScene(s, 0.75, 0.5, 0)).toEqual([5, 6, 7]); // outside → background
  });

  it('a rect of {0,0,1,1} matches an absent rect', () => {
    const params = { from: [255, 0, 0], to: [0, 0, 255], angle: 0, mirror: false };
    const noRect: Scene = {
      name: 't', background: [0, 0, 0],
      layers: [{ ...makeLayer('a', 'gradient'), rect: undefined, params }],
    };
    const fullRect: Scene = {
      name: 't', background: [0, 0, 0],
      layers: [{ ...makeLayer('a', 'gradient'), rect: { x: 0, y: 0, w: 1, h: 1 }, params }],
    };
    for (const x of [0, 0.3, 0.5, 0.9, 1]) {
      expect(sampleScene(fullRect, x, 0.5, 0)).toEqual(sampleScene(noRect, x, 0.5, 0));
    }
  });

  it('the effect is scaled to fill its box (endpoints land at the box edges)', () => {
    const s: Scene = {
      name: 't', background: [0, 0, 0],
      layers: [{
        ...makeLayer('a', 'gradient'),
        params: { from: [255, 0, 0], to: [0, 0, 255], angle: 0, mirror: false },
        rect: { x: 0.25, y: 0, w: 0.5, h: 1 },
      }],
    };
    expect(sampleScene(s, 0.25, 0.5, 0)).toEqual([255, 0, 0]); // box left edge = gradient "from"
    expect(sampleScene(s, 0.75, 0.5, 0)).toEqual([0, 0, 255]); // box right edge = gradient "to"
    expect(sampleScene(s, 0.5, 0.5, 0)).toEqual([128, 0, 128]); // box centre
  });

  it('non-overlapping boxes run independently; overlapping boxes blend', () => {
    const s: Scene = {
      name: 't', background: [0, 0, 0],
      layers: [
        { ...makeLayer('a', 'solid'), params: { color: [255, 0, 0] }, rect: { x: 0, y: 0, w: 0.5, h: 1 } },
        { ...makeLayer('b', 'solid'), params: { color: [0, 0, 255] }, blend: 'add', rect: { x: 0.4, y: 0, w: 0.6, h: 1 } },
      ],
    };
    expect(sampleScene(s, 0.1, 0.5, 0)).toEqual([255, 0, 0]); // only layer a
    expect(sampleScene(s, 0.9, 0.5, 0)).toEqual([0, 0, 255]); // only layer b
    expect(sampleScene(s, 0.45, 0.5, 0)).toEqual([255, 0, 255]); // overlap → add
  });

  it('unknown effect ids are reported and their layers skipped', () => {
    const s: Scene = {
      name: 't', background: [1, 2, 3],
      layers: [
        { ...makeLayer('a', 'solid'), effectId: 'does-not-exist', params: {} },
        { ...makeLayer('b', 'solid'), params: { color: [9, 9, 9] } },
      ],
    };
    expect(unknownEffectIds(s)).toEqual(['does-not-exist']);
    expect(sampleScene(s, 0.5, 0.5, 0)).toEqual([9, 9, 9]);
  });
});

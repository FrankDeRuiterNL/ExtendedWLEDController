import { describe, expect, it } from 'vitest';
import { openDb } from '../db/index.js';
import { CustomEffectStore } from './customEffectStore.js';

const oneLayerSpec = (color: [number, number, number] = [10, 20, 30]) => ({
  blurb: 'Test recipe',
  layers: [
    {
      id: 'a',
      effectId: 'solid',
      params: { color },
      blend: 'normal',
      opacity: 1,
      enabled: true,
    },
  ],
});

describe('CustomEffectStore', () => {
  it('round-trips create/get/list/update/remove', () => {
    const db = openDb(':memory:');
    const store = new CustomEffectStore(db);

    const created = store.create('My Effect', oneLayerSpec());
    expect(created.name).toBe('My Effect');
    expect(created.blurb).toBe('Test recipe');
    expect(created.layers).toHaveLength(1);

    expect(store.get(created.id)).toEqual(created);
    expect(store.list().map((e) => e.id)).toContain(created.id);

    const updated = store.update(created.id, 'Renamed', oneLayerSpec([1, 2, 3]));
    expect(updated?.name).toBe('Renamed');
    expect(updated?.layers[0]?.params).toEqual({ color: [1, 2, 3] });

    expect(store.remove(created.id)).toBe(true);
    expect(store.get(created.id)).toBeNull();
    expect(store.remove(created.id)).toBe(false);

    db.close();
  });

  it('rejects a layer whose effectId is not a known built-in', () => {
    const db = openDb(':memory:');
    const store = new CustomEffectStore(db);
    const spec = oneLayerSpec();
    spec.layers[0]!.effectId = 'not-a-real-effect';
    expect(() => store.create('Bad', spec)).toThrow();
    db.close();
  });

  it('rejects nesting — a layer effectId (or mask effectId) starting with custom:', () => {
    const db = openDb(':memory:');
    const store = new CustomEffectStore(db);

    const nestedMain = oneLayerSpec();
    nestedMain.layers[0]!.effectId = 'custom:1';
    expect(() => store.create('Nested main', nestedMain)).toThrow();

    const nestedMask = {
      ...oneLayerSpec(),
      layers: [{ ...oneLayerSpec().layers[0]!, mask: { effectId: 'custom:2', params: {} } }],
    };
    expect(() => store.create('Nested mask', nestedMask)).toThrow();

    db.close();
  });

  it('toEffectDefMap() produces a Map keyed custom:<id>, rendering the recipe', () => {
    const db = openDb(':memory:');
    const store = new CustomEffectStore(db);
    const created = store.create('Map me', oneLayerSpec([9, 8, 7]));

    const map = store.toEffectDefMap();
    const def = map.get(`custom:${created.id}`);
    expect(def).toBeDefined();
    expect(def!.render(0, 0, 0, {})).toEqual([9, 8, 7, 1]);

    db.close();
  });
});

import { describe, expect, it } from 'vitest';
import { blend } from './blend.js';
import { customEffectToDef, type CustomEffectRecipe } from './customEffect.js';
import { sampleScene, unknownEffectIds, type Scene } from './scene.js';

const solidLayer = (id: string, color: [number, number, number], opacity = 1) => ({
  id,
  effectId: 'solid',
  params: { color },
  blend: 'normal' as const,
  opacity,
  enabled: true,
});

describe('customEffectToDef', () => {
  it('a one-layer recipe renders that layer\'s own colour, fully opaque', () => {
    const recipe: CustomEffectRecipe = {
      id: 'custom:1',
      name: 'Red',
      layers: [solidLayer('a', [10, 20, 30])],
    };
    const def = customEffectToDef(recipe);
    expect(def.id).toBe('custom:1');
    expect(def.params).toEqual([]);
    expect(def.render(0.3, 0.7, 5, {})).toEqual([10, 20, 30, 1]);
  });

  it('composites multiple layers exactly like a Scene does', () => {
    const recipe: CustomEffectRecipe = {
      id: 'custom:2',
      name: 'Layered',
      layers: [solidLayer('a', [255, 0, 0]), solidLayer('b', [0, 0, 255], 0.5)],
    };
    const def = customEffectToDef(recipe);
    const expected = blend([255, 0, 0], [0, 0, 255, 0.5], 'normal');
    expect(def.render(0, 0, 0, {})).toEqual([...expected, 1]);
  });

  it('a masked sub-layer is gated by the mask\'s luma, same as a Scene layer', () => {
    const recipe: CustomEffectRecipe = {
      id: 'custom:3',
      name: 'Masked',
      layers: [
        solidLayer('bg', [0, 0, 0]),
        {
          ...solidLayer('fg', [200, 200, 200]),
          mask: { effectId: 'solid', params: { color: [0, 0, 0] } }, // black mask → fully gated off
        },
      ],
    };
    const def = customEffectToDef(recipe);
    expect(def.render(0, 0, 0, {})).toEqual([0, 0, 0, 1]);
  });
});

describe('sampleScene / unknownEffectIds — custom effect resolution', () => {
  const customDef = customEffectToDef({
    id: 'custom:9',
    name: 'Nine',
    layers: [solidLayer('a', [1, 2, 3])],
  });
  const customMap = new Map([[customDef.id, customDef]]);

  const scene: Scene = {
    name: 's',
    background: [9, 9, 9],
    layers: [
      { id: 'l', effectId: 'custom:9', params: {}, blend: 'normal', opacity: 1, enabled: true },
    ],
  };

  it('resolves a custom effect id when the map is supplied', () => {
    expect(sampleScene(scene, 0, 0, 0, undefined, 1, customMap)).toEqual([1, 2, 3]);
  });

  it('falls back to the background (layer skipped) when the map is omitted', () => {
    expect(sampleScene(scene, 0, 0, 0)).toEqual([9, 9, 9]);
  });

  it('also resolves a custom effect used as a mask', () => {
    const maskedScene: Scene = {
      name: 's2',
      background: [0, 0, 0],
      layers: [
        {
          id: 'l',
          effectId: 'solid',
          params: { color: [200, 200, 200] },
          blend: 'normal',
          opacity: 1,
          enabled: true,
          mask: { effectId: 'custom:9', params: {} },
        },
      ],
    };
    // custom:9 renders [1,2,3] — luma is low but non-zero, so the masked
    // layer shows through only very faintly rather than at full brightness.
    const withMask = sampleScene(maskedScene, 0, 0, 0, undefined, 1, customMap);
    // Without the map, the mask's effectId can't resolve at all — an
    // unresolved mask is treated as no mask (sampleScene's existing
    // behaviour), so the layer shows through at full strength instead.
    const withoutMap = sampleScene(maskedScene, 0, 0, 0);
    expect(withMask).not.toEqual([0, 0, 0]);
    expect(withoutMap).toEqual([200, 200, 200]);
  });

  it('unknownEffectIds clears once the map is passed, and flags it otherwise', () => {
    expect(unknownEffectIds(scene)).toEqual(['custom:9']);
    expect(unknownEffectIds(scene, customMap)).toEqual([]);
  });
});

/**
 * A **custom effect** is a small, saved stack of *built-in* effects — the
 * same blend/opacity/mask compositing model a Scene's layer stack uses,
 * captured once and re-exposed as a single new effect id. Recipe layers may
 * only reference a built-in effect (never another custom effect — no
 * nesting, enforced by the server store, not just here) so this can compose
 * with a plain, non-recursive call into {@link sampleScene}.
 */

import type { BlendMode } from './blend.js';
import type { LayerMask } from './scene.js';
import { sampleScene } from './scene.js';
import type { EffectDef, ParamValues } from './types.js';

export interface RecipeLayer {
  id: string;
  name?: string;
  /** Must resolve via {@link getEffect} — a built-in id, never another custom effect. */
  effectId: string;
  params: ParamValues;
  blend: BlendMode;
  /** 0..1 */
  opacity: number;
  enabled: boolean;
  mask?: LayerMask | null;
}

export interface CustomEffectRecipe {
  /** `custom:<db id>` — namespaced so it never collides with a built-in id. */
  id: string;
  name: string;
  blurb?: string;
  layers: RecipeLayer[];
}

/**
 * Compile a saved recipe into an ordinary {@link EffectDef}. The recipe's own
 * layers composite over black exactly like a Scene does; the result is always
 * returned **fully opaque** (alpha 1) — a custom effect always fully fills
 * whatever box it's placed in on the host Scene, same as Solid/Gradient/
 * Rainbow do today. `params` is empty: a custom effect's look is baked from
 * its recipe, not exposed as tunable params on the host layer.
 */
export function customEffectToDef(recipe: CustomEffectRecipe): EffectDef {
  return {
    id: recipe.id,
    name: recipe.name,
    blurb: recipe.blurb ?? 'Custom effect',
    params: [],
    render: (x, y, t) => {
      const rgb = sampleScene(
        { name: recipe.name, background: [0, 0, 0], layers: recipe.layers },
        x,
        y,
        t,
        // No mediaFrames, no customEffects passed down — a recipe layer can
        // only ever resolve to a built-in, never another custom effect.
      );
      return [rgb[0], rgb[1], rgb[2], 1];
    },
  };
}

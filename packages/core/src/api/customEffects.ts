/** DTOs for the custom-effect recipe store (M10b). */

import type { RecipeLayer } from '../render/customEffect.js';

/** The saved shape of a custom effect — a small stack of built-in-effect layers. */
export interface CustomEffectSpec {
  blurb?: string;
  layers: RecipeLayer[];
}

export interface CustomEffectDTO {
  id: number;
  name: string;
  blurb?: string;
  layers: RecipeLayer[];
  createdAt: string;
  updatedAt: string;
}

export interface SaveCustomEffectRequest {
  name: string;
  spec: CustomEffectSpec;
}

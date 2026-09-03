/** DTOs for the pixel-painter scene store (milestone 5). */

/**
 * A saved pixel-painter canvas. Device-agnostic — `width` records the segment
 * length it was painted for; on load it is mapped by index onto the selected
 * device/segment (truncated / padded with `null`).
 */
export interface PixelScene {
  width: number;
  /** Working brightness 1..255. */
  brightness: number;
  /** One entry per LED: a `RRGGBB` hex string, or `null` to leave that LED to its effect. */
  pixels: Array<string | null>;
}

export interface PixelSceneSummaryDTO {
  id: number;
  name: string;
  width: number;
  paintedCount: number;
  updatedAt: string;
}

export interface PixelSceneDTO {
  id: number;
  name: string;
  scene: PixelScene;
  createdAt: string;
  updatedAt: string;
}

export interface SavePixelSceneRequest {
  name: string;
  scene: PixelScene;
}

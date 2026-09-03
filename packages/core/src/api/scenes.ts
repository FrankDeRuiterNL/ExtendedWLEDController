/** DTOs for the scene store (milestone 4). */

import type { Scene } from '../render/scene.js';

export interface SceneSummaryDTO {
  id: number;
  name: string;
  layerCount: number;
  updatedAt: string;
}

export interface SceneDTO {
  id: number;
  name: string;
  scene: Scene;
  createdAt: string;
  updatedAt: string;
}

export interface SaveSceneRequest {
  name: string;
  scene: Scene;
}

/** Start the DDP stream from a stored scene id, or an inline scene. */
export interface StartSceneRequest {
  sceneId?: number;
  scene?: Scene;
}

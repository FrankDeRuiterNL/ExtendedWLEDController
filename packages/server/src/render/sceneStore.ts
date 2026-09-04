import { EMPTY_SCENE, type Scene } from '@ewc/core';
import { z } from 'zod';
import type { SceneDTO, SceneSummaryDTO } from '@ewc/core';
import type { Db } from '../db/index.js';

const rgb = z.tuple([z.number(), z.number(), z.number()]);
const paramValue = z.union([z.number(), z.boolean(), z.string(), z.array(z.number()).max(4)]);
const params = z.record(z.string(), paramValue);
const blendMode = z.enum(['normal', 'add', 'screen', 'multiply', 'lighten']);

const rect = z.object({
  x: z.number().min(-1).max(2),
  y: z.number().min(-1).max(2),
  w: z.number().min(0).max(3),
  h: z.number().min(0).max(3),
  rot: z.number().min(-360).max(360).optional(),
});

const media = z.object({
  assetId: z.string().min(1).max(64),
  filename: z.string().max(200),
  kind: z.enum(['image', 'video']).optional(),
  naturalWidth: z.number().positive(),
  naturalHeight: z.number().positive(),
  // video (8b/8c)
  durationMs: z.number().nonnegative().optional(),
  trimInMs: z.number().nonnegative().optional(),
  trimOutMs: z.number().nonnegative().optional(),
  playbackType: z.enum(['loop', 'hold', 'hide']).optional(),
  // Transient transport state — accepted so it reaches the live producer, but
  // stripped before persistence (see `stripTransient`).
  playback: z
    .object({
      state: z.enum(['playing', 'paused', 'stopped']),
      anchorMs: z.number(),
      headMs: z.number(),
    })
    .nullish(),
});

const textLayer = z.object({
  value: z.string().max(1000),
  fontId: z.string().max(40),
  sizePx: z.number().positive().max(512),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  strikethrough: z.boolean().optional(),
  color: rgb.optional(),
  assetId: z.string().min(1).max(64).optional(),
  naturalWidth: z.number().positive().optional(),
  naturalHeight: z.number().positive().optional(),
  renderHash: z.string().max(4000).optional(),
});

const layer = z.object({
  id: z.string().min(1).max(64),
  name: z.string().max(64).optional(),
  // Empty for a media layer; otherwise an effect id.
  effectId: z.string().max(64),
  params,
  blend: blendMode,
  opacity: z.number().min(0).max(1),
  enabled: z.boolean(),
  rect: rect.optional(),
  mask: z
    .object({ effectId: z.string().min(1).max(64), params, invert: z.boolean().optional() })
    .nullish(),
  media: media.nullish(),
  text: textLayer.nullish(),
});

export const sceneSchema = z.object({
  name: z.string().min(1).max(120),
  background: rgb,
  layers: z.array(layer).max(24),
});

type ParsedScene = z.infer<typeof sceneSchema>;

/**
 * Remove state that must not persist: a video layer's `playback` is a live
 * transport position (like a console fader) — on reload it's reconstructed from
 * `playbackType`. `trimInMs` / `trimOutMs` / `playbackType` DO persist.
 */
function stripTransient(scene: ParsedScene): ParsedScene {
  return {
    ...scene,
    layers: scene.layers.map((l) =>
      l.media ? { ...l, media: { ...l.media, playback: undefined } } : l,
    ),
  };
}

interface SceneRow {
  id: number;
  name: string;
  data_json: string;
  created_at: string;
  updated_at: string;
}

/** CRUD for saved scenes. The whole {@link Scene} lives in `data_json`. */
export class SceneStore {
  constructor(private readonly db: Db) {}

  private parse(row: SceneRow): SceneDTO {
    let scene: Scene;
    try {
      scene = sceneSchema.parse(JSON.parse(row.data_json)) as Scene;
    } catch {
      scene = { ...structuredClone(EMPTY_SCENE), name: row.name };
    }
    return {
      id: row.id,
      name: row.name,
      scene,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  list(): SceneSummaryDTO[] {
    const rows = this.db
      .prepare('SELECT id, name, data_json, updated_at FROM scenes ORDER BY updated_at DESC')
      .all() as Array<Pick<SceneRow, 'id' | 'name' | 'data_json' | 'updated_at'>>;
    return rows.map((r) => {
      let layerCount = 0;
      try {
        layerCount = (JSON.parse(r.data_json).layers ?? []).length;
      } catch {
        /* leave 0 */
      }
      return { id: r.id, name: r.name, layerCount, updatedAt: r.updated_at };
    });
  }

  get(id: number): SceneDTO | null {
    const row = this.db.prepare('SELECT * FROM scenes WHERE id = ?').get(id) as SceneRow | undefined;
    return row ? this.parse(row) : null;
  }

  create(name: string, scene: unknown): SceneDTO {
    const parsed = stripTransient(sceneSchema.parse({ ...(scene as object), name }));
    const info = this.db
      .prepare('INSERT INTO scenes (name, data_json) VALUES (?, ?)')
      .run(name, JSON.stringify(parsed));
    return this.get(Number(info.lastInsertRowid))!;
  }

  update(id: number, name: string, scene: unknown): SceneDTO | null {
    const parsed = stripTransient(sceneSchema.parse({ ...(scene as object), name }));
    const info = this.db
      .prepare(`UPDATE scenes SET name = ?, data_json = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(name, JSON.stringify(parsed), id);
    return info.changes ? this.get(id) : null;
  }

  remove(id: number): boolean {
    return this.db.prepare('DELETE FROM scenes WHERE id = ?').run(id).changes > 0;
  }
}

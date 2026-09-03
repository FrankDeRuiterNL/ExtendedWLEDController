import { z } from 'zod';
import type { PixelScene, PixelSceneDTO, PixelSceneSummaryDTO } from '@ewc/core';
import type { Db } from '../db/index.js';

export const pixelSceneSchema = z.object({
  width: z.number().int().min(1).max(4096),
  brightness: z.number().int().min(1).max(255),
  pixels: z
    .array(z.string().regex(/^[0-9A-Fa-f]{6}$/, 'expected RRGGBB').nullable())
    .max(4096),
});

interface PixelSceneRow {
  id: number;
  name: string;
  data_json: string;
  created_at: string;
  updated_at: string;
}

const paintedCount = (s: PixelScene) => s.pixels.reduce((n, p) => (p ? n + 1 : n), 0);

/** CRUD for saved pixel-painter canvases. The whole {@link PixelScene} lives in `data_json`. */
export class PixelSceneStore {
  constructor(private readonly db: Db) {}

  private parse(row: PixelSceneRow): PixelSceneDTO {
    const scene = pixelSceneSchema.parse(JSON.parse(row.data_json)) as PixelScene;
    return {
      id: row.id,
      name: row.name,
      scene,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  list(): PixelSceneSummaryDTO[] {
    const rows = this.db
      .prepare('SELECT id, name, data_json, updated_at FROM pixel_scenes ORDER BY updated_at DESC')
      .all() as Array<Pick<PixelSceneRow, 'id' | 'name' | 'data_json' | 'updated_at'>>;
    return rows.map((r) => {
      let width = 0;
      let painted = 0;
      try {
        const s = JSON.parse(r.data_json) as PixelScene;
        width = s.width ?? (Array.isArray(s.pixels) ? s.pixels.length : 0);
        painted = Array.isArray(s.pixels) ? paintedCount(s) : 0;
      } catch {
        /* leave zeros */
      }
      return { id: r.id, name: r.name, width, paintedCount: painted, updatedAt: r.updated_at };
    });
  }

  get(id: number): PixelSceneDTO | null {
    const row = this.db.prepare('SELECT * FROM pixel_scenes WHERE id = ?').get(id) as
      | PixelSceneRow
      | undefined;
    return row ? this.parse(row) : null;
  }

  create(name: string, scene: unknown): PixelSceneDTO {
    const parsed = pixelSceneSchema.parse(scene);
    const info = this.db
      .prepare('INSERT INTO pixel_scenes (name, data_json) VALUES (?, ?)')
      .run(name, JSON.stringify(parsed));
    return this.get(Number(info.lastInsertRowid))!;
  }

  update(id: number, name: string, scene: unknown): PixelSceneDTO | null {
    const parsed = pixelSceneSchema.parse(scene);
    const info = this.db
      .prepare(
        `UPDATE pixel_scenes SET name = ?, data_json = ?, updated_at = datetime('now') WHERE id = ?`,
      )
      .run(name, JSON.stringify(parsed), id);
    return info.changes ? this.get(id) : null;
  }

  remove(id: number): boolean {
    return this.db.prepare('DELETE FROM pixel_scenes WHERE id = ?').run(id).changes > 0;
  }
}

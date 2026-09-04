import { z } from 'zod';
import {
  customEffectToDef,
  getEffect,
  type CustomEffectDTO,
  type CustomEffectSpec,
  type EffectDef,
} from '@ewc/core';
import type { Db } from '../db/index.js';

const paramValue = z.union([z.number(), z.boolean(), z.string(), z.array(z.number()).max(4)]);
const params = z.record(z.string(), paramValue);
const blendMode = z.enum(['normal', 'add', 'screen', 'multiply', 'lighten']);

const recipeLayer = z.object({
  id: z.string().min(1).max(64),
  name: z.string().max(64).optional(),
  effectId: z.string().min(1).max(64),
  params,
  blend: blendMode,
  opacity: z.number().min(0).max(1),
  enabled: z.boolean(),
  mask: z
    .object({ effectId: z.string().min(1).max(64), params, invert: z.boolean().optional() })
    .nullish(),
});

/**
 * Every `effectId` in a recipe (main layer + mask) must be a known **built-in**
 * — never another custom effect. The `custom:*` namespace is reserved for the
 * runtime id this store itself produces, so a recipe layer referencing one
 * would either be a stale/foreign id or an attempt at nesting; both are
 * rejected here, as a zod issue (→ the same 400 path any other bad body takes).
 */
const customEffectSpecSchema = z
  .object({
    blurb: z.string().max(200).optional(),
    layers: z.array(recipeLayer).min(1).max(12),
  })
  .superRefine((spec, ctx) => {
    spec.layers.forEach((l, i) => {
      const refs: Array<[(string | number)[], string]> = [[['layers', i, 'effectId'], l.effectId]];
      if (l.mask) refs.push([['layers', i, 'mask', 'effectId'], l.mask.effectId]);
      for (const [path, id] of refs) {
        if (id.startsWith('custom:')) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path,
            message: `A custom effect can't reference another custom effect (${id})`,
          });
        } else if (!getEffect(id)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: `Unknown effect id: ${id}` });
        }
      }
    });
  });

interface CustomEffectRow {
  id: number;
  name: string;
  data_json: string;
  created_at: string;
  updated_at: string;
}

/** CRUD for saved custom effects. The whole {@link CustomEffectSpec} lives in `data_json`. */
export class CustomEffectStore {
  constructor(private readonly db: Db) {}

  private parse(row: CustomEffectRow): CustomEffectDTO {
    const spec = customEffectSpecSchema.parse(JSON.parse(row.data_json)) as CustomEffectSpec;
    return {
      id: row.id,
      name: row.name,
      blurb: spec.blurb,
      layers: spec.layers,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  list(): CustomEffectDTO[] {
    const rows = this.db
      .prepare('SELECT * FROM custom_effects ORDER BY updated_at DESC')
      .all() as CustomEffectRow[];
    return rows.map((r) => this.parse(r));
  }

  get(id: number): CustomEffectDTO | null {
    const row = this.db.prepare('SELECT * FROM custom_effects WHERE id = ?').get(id) as
      | CustomEffectRow
      | undefined;
    return row ? this.parse(row) : null;
  }

  create(name: string, spec: unknown): CustomEffectDTO {
    const parsed = customEffectSpecSchema.parse(spec);
    const info = this.db
      .prepare('INSERT INTO custom_effects (name, data_json) VALUES (?, ?)')
      .run(name, JSON.stringify(parsed));
    return this.get(Number(info.lastInsertRowid))!;
  }

  update(id: number, name: string, spec: unknown): CustomEffectDTO | null {
    const parsed = customEffectSpecSchema.parse(spec);
    const info = this.db
      .prepare(`UPDATE custom_effects SET name = ?, data_json = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(name, JSON.stringify(parsed), id);
    return info.changes ? this.get(id) : null;
  }

  remove(id: number): boolean {
    return this.db.prepare('DELETE FROM custom_effects WHERE id = ?').run(id).changes > 0;
  }

  /**
   * Every custom effect, compiled to an `EffectDef` and keyed by its runtime
   * id (`custom:<row id>`). Built once per producer rebuild — mirrors how
   * `sceneProducer.ts` builds its media provider once, outside the 40 Hz tick.
   */
  toEffectDefMap(): Map<string, EffectDef> {
    const map = new Map<string, EffectDef>();
    for (const row of this.list()) {
      const id = `custom:${row.id}`;
      map.set(id, customEffectToDef({ id, name: row.name, blurb: row.blurb, layers: row.layers }));
    }
    return map;
  }
}

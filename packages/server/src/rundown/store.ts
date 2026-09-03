import { CUE_FADE_MAX_MS, EMPTY_RUNDOWN, type Rundown } from '@ewc/core';
import { z } from 'zod';
import type { Db } from '../db/index.js';

const trigger = z.discriminatedUnion('type', [
  z.object({ type: z.literal('manual') }),
  z.object({ type: z.literal('follow'), seconds: z.number().min(0).max(86_400) }),
  z.object({ type: z.literal('wait'), seconds: z.number().min(0).max(86_400) }),
]);

const cue = z.object({
  id: z.string().min(1).max(64),
  number: z.string().max(32),
  name: z.string().max(120).optional(),
  sceneId: z.number().int().positive().nullable(),
  trigger,
  fadeInMs: z.number().min(0).max(CUE_FADE_MAX_MS),
  fadeOutMs: z.number().min(0).max(CUE_FADE_MAX_MS),
  // 0 is accepted on the wire (older payloads) but the editor enforces a floor.
  durationMs: z.number().min(0).max(24 * 3_600_000),
});

export const rundownSchema = z.object({
  cues: z.array(cue).max(500),
});

export class RundownStore {
  constructor(private readonly db: Db) {}

  get(): Rundown {
    const row = this.db.prepare('SELECT data_json FROM rundown WHERE id = 1').get() as
      | { data_json: string }
      | undefined;
    if (!row) return structuredClone(EMPTY_RUNDOWN);
    try {
      return rundownSchema.parse(JSON.parse(row.data_json));
    } catch {
      return structuredClone(EMPTY_RUNDOWN);
    }
  }

  save(input: unknown): Rundown {
    const rundown = rundownSchema.parse(input);
    this.db
      .prepare(`UPDATE rundown SET data_json = ?, updated_at = datetime('now') WHERE id = 1`)
      .run(JSON.stringify(rundown));
    return rundown;
  }

  updatedAt(): string {
    const row = this.db.prepare('SELECT updated_at FROM rundown WHERE id = 1').get() as
      | { updated_at: string }
      | undefined;
    return row?.updated_at ?? new Date().toISOString();
  }
}

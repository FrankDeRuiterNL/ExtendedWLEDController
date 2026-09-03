import { EMPTY_INSTALLATION, type Installation } from '@ewc/core';
import { z } from 'zod';
import type { Db } from '../db/index.js';

const vec2 = z.object({ x: z.number(), y: z.number() });

const shapeKind = z.enum(['line', 'rectangle', 'square', 'triangle', 'diamond', 'circle']);
const fixtureShape = z.union([
  z.object({ type: shapeKind }),
  z.object({ type: z.literal('custom'), points: z.array(vec2).min(2).max(512), closed: z.boolean().optional() }),
]);

const geometry = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('strip'), count: z.number().int().min(0).max(65536) }),
  z.object({
    kind: z.literal('matrix'),
    width: z.number().int().min(1).max(1024),
    height: z.number().int().min(1).max(1024),
    serpentine: z.boolean(),
    origin: z.enum(['top-left', 'top-right', 'bottom-left', 'bottom-right']),
    columnMajor: z.boolean().optional(),
  }),
  z.object({ kind: z.literal('points'), points: z.array(vec2).max(65536) }),
  z.object({
    kind: z.literal('shape'),
    count: z.number().int().min(0).max(65536),
    shape: fixtureShape,
  }),
]);

const fixture = z.object({
  id: z.string().min(1).max(64),
  deviceId: z.number().int(),
  name: z.string().max(120),
  startIndex: z.number().int().min(0),
  geometry,
  transform: z.object({
    position: vec2,
    rotationDeg: z.number(),
    size: vec2,
  }),
  enabled: z.boolean(),
});

const floorplan = z.object({
  asset: z.string().min(1).max(200),
  rev: z.number().int().min(0),
  naturalWidth: z.number().positive(),
  naturalHeight: z.number().positive(),
  position: vec2,
  size: vec2,
});

const outputHardware = z.object({
  ledTypeId: z.string().max(40).optional(),
  ledsPerMeter: z.number().positive().max(1000).optional(),
});

export const installationSchema = z.object({
  fixtures: z.array(fixture).max(512),
  canvas: z.object({ width: z.number().positive(), height: z.number().positive() }),
  floorplan: floorplan.optional(),
  outputs: z.record(z.string(), outputHardware).optional(),
});

export class InstallationStore {
  constructor(private readonly db: Db) {}

  get(): Installation {
    const row = this.db.prepare('SELECT data_json FROM installation WHERE id = 1').get() as
      | { data_json: string }
      | undefined;
    if (!row) return structuredClone(EMPTY_INSTALLATION);
    try {
      return installationSchema.parse(JSON.parse(row.data_json));
    } catch {
      return structuredClone(EMPTY_INSTALLATION);
    }
  }

  save(input: unknown): Installation {
    const inst = installationSchema.parse(input);
    this.db
      .prepare(`UPDATE installation SET data_json = ?, updated_at = datetime('now') WHERE id = 1`)
      .run(JSON.stringify(inst));
    return inst;
  }

  /** Merge (or clear, with `null`) just the floorplan reference and persist. */
  setFloorplan(ref: Installation['floorplan'] | null): Installation {
    const current = this.get();
    const next: Installation = { ...current };
    if (ref) next.floorplan = ref;
    else delete next.floorplan;
    return this.save(next);
  }
}

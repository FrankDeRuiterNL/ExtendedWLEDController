import { Router } from 'express';
import { z } from 'zod';
import type { DmxService } from '../dmx/service.js';
import type { InstallationStore } from '../installation/store.js';
import { SceneStore, sceneSchema } from '../render/sceneStore.js';
import type { StreamService } from './streamService.js';

const rgb = z.tuple([
  z.number().int().min(0).max(255),
  z.number().int().min(0).max(255),
  z.number().int().min(0).max(255),
]);

export function dmxRoutes(dmx: DmxService): Router {
  const r = Router();

  r.get('/patch', (_req, res) => res.json(dmx.patch()));

  r.put('/config', async (req, res, next) => {
    try {
      const body = z
        .object({
          config: z
            .object({
              baseUniverse: z.number().int().min(1).max(63000).optional(),
              ledsPerUniverseRgb: z.number().int().min(1).max(170).optional(),
              ledsPerUniverseRgbw: z.number().int().min(1).max(128).optional(),
              packing: z.enum(['boundary', 'packed']).optional(),
            })
            .default({}),
          replan: z.boolean().optional(),
        })
        .parse(req.body);
      dmx.setConfig(body.config);
      if (body.replan) await dmx.replanAll();
      res.json(dmx.patch());
    } catch (err) {
      next(err);
    }
  });

  r.post('/replan', async (_req, res, next) => {
    try {
      await dmx.replanAll();
      res.json(dmx.patch());
    } catch (err) {
      next(err);
    }
  });

  r.post('/:id/assign', async (req, res, next) => {
    try {
      await dmx.assign(Number(req.params.id));
      res.json(dmx.patch());
    } catch (err) {
      next(err);
    }
  });

  r.put('/:id/managed', (req, res, next) => {
    try {
      const { managed } = z.object({ managed: z.boolean() }).parse(req.body);
      dmx.setManaged(Number(req.params.id), managed);
      res.json(dmx.patch());
    } catch (err) {
      next(err);
    }
  });

  return r;
}

export function streamRoutes(stream: StreamService, scenes: SceneStore): Router {
  const r = Router();

  r.get('/status', (_req, res) => res.json(stream.status()));

  r.post('/scene', (req, res, next) => {
    try {
      const body = z
        .object({ sceneId: z.number().int().positive().optional(), scene: sceneSchema.optional() })
        .parse(req.body);
      let scene = body.scene;
      if (!scene && body.sceneId != null) {
        const stored = scenes.get(body.sceneId);
        if (!stored) return res.status(404).json({ error: { message: `no scene ${body.sceneId}` } });
        scene = stored.scene;
      }
      if (!scene) return res.status(400).json({ error: { message: 'sceneId or scene required' } });
      res.json(stream.startScene(scene));
    } catch (err) {
      next(err);
    }
  });

  r.post('/paint', (req, res, next) => {
    try {
      const body = z
        .object({
          deviceId: z.number().int().positive(),
          segStart: z.number().int().min(0).max(65535).optional(),
          brightness: z.number().int().min(1).max(255).default(255),
          pixels: z
            .array(z.string().regex(/^[0-9a-fA-F]{6}$/).nullable())
            .max(4096),
        })
        .parse(req.body);
      const pixels = body.pixels.map((hex) =>
        hex
          ? ([
              parseInt(hex.slice(0, 2), 16),
              parseInt(hex.slice(2, 4), 16),
              parseInt(hex.slice(4, 6), 16),
            ] as [number, number, number])
          : null,
      );
      res.json(
        stream.startPaint({
          deviceId: body.deviceId,
          segStart: body.segStart ?? 0,
          brightness: body.brightness,
          pixels,
        }),
      );
    } catch (err) {
      next(err);
    }
  });

  r.post('/solid', (req, res, next) => {
    try {
      const { color } = z.object({ color: rgb }).parse(req.body);
      res.json(stream.startSolid(color));
    } catch (err) {
      next(err);
    }
  });

  r.post('/pattern', (_req, res, next) => {
    try {
      res.json(stream.startPattern());
    } catch (err) {
      next(err);
    }
  });

  r.post('/stop', async (_req, res, next) => {
    try {
      await stream.stop();
      res.json(stream.status());
    } catch (err) {
      next(err);
    }
  });

  r.put('/:id/pixel-offset', (req, res, next) => {
    try {
      const { offset } = z.object({ offset: z.number().int().min(-64).max(64) }).parse(req.body);
      stream.setPixelOffset(Number(req.params.id), offset);
      res.json(stream.status());
    } catch (err) {
      next(err);
    }
  });

  return r;
}

export function installationRoutes(store: InstallationStore, onChange?: () => void): Router {
  const r = Router();
  r.get('/', (_req, res) => res.json({ installation: store.get() }));
  r.put('/', (req, res, next) => {
    try {
      const installation = store.save(req.body?.installation ?? req.body);
      onChange?.();
      res.json({ installation });
    } catch (err) {
      next(err);
    }
  });
  return r;
}

export function sceneRoutes(store: SceneStore): Router {
  const r = Router();

  r.get('/', (_req, res) => res.json({ scenes: store.list() }));

  r.get('/:id', (req, res) => {
    const scene = store.get(Number(req.params.id));
    if (!scene) return res.status(404).json({ error: { message: 'not found' } });
    res.json({ scene });
  });

  r.post('/', (req, res, next) => {
    try {
      const { name, scene } = z.object({ name: z.string().min(1).max(120), scene: sceneSchema }).parse(req.body);
      res.status(201).json({ scene: store.create(name, scene) });
    } catch (err) {
      next(err);
    }
  });

  r.put('/:id', (req, res, next) => {
    try {
      const { name, scene } = z.object({ name: z.string().min(1).max(120), scene: sceneSchema }).parse(req.body);
      const updated = store.update(Number(req.params.id), name, scene);
      if (!updated) return res.status(404).json({ error: { message: 'not found' } });
      res.json({ scene: updated });
    } catch (err) {
      next(err);
    }
  });

  r.delete('/:id', (req, res) => {
    const ok = store.remove(Number(req.params.id));
    res.status(ok ? 204 : 404).end();
  });

  return r;
}

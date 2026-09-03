import express, { Router } from 'express';
import { z } from 'zod';
import type { DmxService } from '../dmx/service.js';
import { FLOORPLAN_MIME_TYPES, type FloorplanStore } from '../installation/floorplanStore.js';
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

/** Fit a `w`×`h` image fully inside the canvas, keeping its aspect ratio. */
export function fitToCanvas(
  w: number,
  h: number,
  canvas: { width: number; height: number },
): { position: { x: number; y: number }; size: { x: number; y: number } } {
  const ar = w > 0 && h > 0 ? w / h : 1;
  let sx = canvas.width;
  let sy = canvas.width / ar;
  if (sy > canvas.height) {
    sy = canvas.height;
    sx = canvas.height * ar;
  }
  return { position: { x: canvas.width / 2, y: canvas.height / 2 }, size: { x: sx, y: sy } };
}

export function installationRoutes(
  store: InstallationStore,
  floorplans: FloorplanStore,
  onChange?: () => void,
): Router {
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

  // --- floorplan reference image (preview-only, never reaches the wire) ------

  r.get('/floorplan', (_req, res) => {
    const fp = store.get().floorplan;
    if (!fp) return res.status(404).json({ error: { code: 'not-found', message: 'no floorplan' } });
    res.type(floorplans.mimeFor(fp.asset));
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return res.sendFile(floorplans.path(fp.asset), (err) => {
      if (err && !res.headersSent) res.status(404).end();
    });
  });

  r.put(
    '/floorplan',
    express.raw({ type: FLOORPLAN_MIME_TYPES, limit: '16mb' }),
    (req, res, next) => {
      try {
        const bytes = req.body;
        if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
          return res.status(400).json({ error: { code: 'empty', message: 'no image body' } });
        }
        const mime = (req.headers['content-type'] ?? '').split(';')[0]!.trim();
        const dims = z
          .object({ w: z.coerce.number().positive(), h: z.coerce.number().positive() })
          .parse(req.query);

        const asset = floorplans.write(bytes, mime);
        const current = store.get();
        const prev = current.floorplan;
        // Keep an existing placement, but re-derive the box height from the new
        // image's aspect (anchored on the kept width) so `size` and `natural*`
        // can never disagree — both renderers force the box and the resize
        // handle reads the aspect from `natural*`. First upload: fit to canvas.
        const aspect = dims.w / dims.h;
        const placement =
          prev && prev.position && prev.size
            ? { position: prev.position, size: { x: prev.size.x, y: prev.size.x / aspect } }
            : fitToCanvas(dims.w, dims.h, current.canvas);
        const installation = store.setFloorplan({
          asset,
          rev: (prev?.rev ?? 0) + 1,
          naturalWidth: dims.w,
          naturalHeight: dims.h,
          ...placement,
        });
        onChange?.();
        return res.json({ installation });
      } catch (err) {
        return next(err);
      }
    },
  );

  r.delete('/floorplan', (_req, res, next) => {
    try {
      floorplans.clear();
      const installation = store.setFloorplan(null);
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

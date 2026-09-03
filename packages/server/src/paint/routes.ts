import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { PaintError, type PaintService } from './service.js';
import { pixelSceneSchema, type PixelSceneStore } from './pixelSceneStore.js';

const color = z.union([
  z.string().regex(/^#?[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/, 'expected RRGGBB[WW] hex'),
  z.array(z.number().min(0).max(255)).min(3).max(4),
]);

const paintBody = z
  .object({
    segId: z.number().int().min(0).max(63).optional(),
    brightness: z.number().int().min(1).max(255).optional(),
    mode: z.enum(['dense', 'sparse']),
    pixels: z.array(color).max(4096).optional(),
    painted: z
      .array(z.object({ index: z.number().int().min(0).max(65535), color }))
      .max(4096)
      .optional(),
  })
  .refine((v) => (v.mode === 'dense' ? !!v.pixels?.length : !!v.painted?.length), {
    message: 'dense needs pixels[], sparse needs painted[]',
  });

const releaseBody = z.object({ segId: z.number().int().min(0).max(63).optional() });

function idParam(req: Request): number {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new PaintError('Invalid device id', 400, 'invalid-id');
  return id;
}

export function paintRoutes(service: PaintService): Router {
  const r = Router();

  r.post('/:id/paint', async (req, res, next) => {
    try {
      const body = paintBody.parse(req.body);
      res.json(await service.paint(idParam(req), body));
    } catch (err) {
      next(err);
    }
  });

  r.post('/:id/paint/release', async (req, res, next) => {
    try {
      const { segId } = releaseBody.parse(req.body ?? {});
      res.json(await service.release(idParam(req), segId));
    } catch (err) {
      next(err);
    }
  });

  return r;
}

const savePixelSceneBody = z.object({
  name: z.string().min(1).max(120),
  scene: pixelSceneSchema,
});

export function pixelSceneRoutes(store: PixelSceneStore): Router {
  const r = Router();

  r.get('/', (_req, res) => {
    res.json({ pixelScenes: store.list() });
  });

  r.post('/', (req, res, next) => {
    try {
      const { name, scene } = savePixelSceneBody.parse(req.body);
      res.status(201).json({ pixelScene: store.create(name, scene) });
    } catch (err) {
      next(err);
    }
  });

  r.get('/:id', (req, res, next) => {
    try {
      const scene = store.get(idParam(req));
      if (!scene) throw new PaintError(`No pixel scene ${req.params.id}`, 404, 'not-found');
      res.json({ pixelScene: scene });
    } catch (err) {
      next(err);
    }
  });

  r.put('/:id', (req, res, next) => {
    try {
      const { name, scene } = savePixelSceneBody.parse(req.body);
      const updated = store.update(idParam(req), name, scene);
      if (!updated) throw new PaintError(`No pixel scene ${req.params.id}`, 404, 'not-found');
      res.json({ pixelScene: updated });
    } catch (err) {
      next(err);
    }
  });

  r.delete('/:id', (req, res, next) => {
    try {
      if (!store.remove(idParam(req))) throw new PaintError(`No pixel scene ${req.params.id}`, 404, 'not-found');
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  return r;
}

export function paintErrorHandler(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (err instanceof PaintError) {
    res.status(err.httpStatus).json({ error: { code: err.code, message: err.message } });
    return;
  }
  next(err);
}

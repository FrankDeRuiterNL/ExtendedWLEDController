import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import type { CustomEffectStore } from './customEffectStore.js';

export class CustomEffectError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'CustomEffectError';
  }
}

export function customEffectErrorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (err instanceof CustomEffectError) {
    res.status(err.httpStatus).json({ error: { code: err.code, message: err.message } });
    return;
  }
  next(err);
}

function idParam(req: Request): number {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new CustomEffectError('Invalid id', 400, 'bad-id');
  return id;
}

const saveCustomEffectBody = z.object({
  name: z.string().min(1).max(120),
  spec: z.unknown(), // validated by CustomEffectStore's own zod schema
});

/**
 * `onChanged` fires after every create/update/delete so a currently-streaming
 * Scene using the edited custom effect hot-swaps (`StreamService
 * .onCustomEffectsChanged()`), same as the installation-changed hook.
 */
export function customEffectRoutes(store: CustomEffectStore, onChanged?: () => void): Router {
  const r = Router();

  r.get('/', (_req, res) => {
    res.json({ customEffects: store.list() });
  });

  r.post('/', (req, res, next) => {
    try {
      const { name, spec } = saveCustomEffectBody.parse(req.body);
      const created = store.create(name, spec);
      onChanged?.();
      res.status(201).json({ customEffect: created });
    } catch (err) {
      next(err);
    }
  });

  r.get('/:id', (req, res, next) => {
    try {
      const effect = store.get(idParam(req));
      if (!effect) throw new CustomEffectError(`No custom effect ${req.params.id}`, 404, 'not-found');
      res.json({ customEffect: effect });
    } catch (err) {
      next(err);
    }
  });

  r.put('/:id', (req, res, next) => {
    try {
      const { name, spec } = saveCustomEffectBody.parse(req.body);
      const updated = store.update(idParam(req), name, spec);
      if (!updated) throw new CustomEffectError(`No custom effect ${req.params.id}`, 404, 'not-found');
      onChanged?.();
      res.json({ customEffect: updated });
    } catch (err) {
      next(err);
    }
  });

  r.delete('/:id', (req, res, next) => {
    try {
      if (!store.remove(idParam(req))) {
        throw new CustomEffectError(`No custom effect ${req.params.id}`, 404, 'not-found');
      }
      onChanged?.();
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  return r;
}

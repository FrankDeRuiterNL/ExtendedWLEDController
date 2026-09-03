import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { DeviceError, DeviceService } from './service.js';

const linkType = z.enum(['wifi', 'ethernet', 'unknown']);

const addBody = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).optional(),
  name: z.string().max(120).optional(),
  linkType: linkType.optional(),
});

const updateBody = z
  .object({
    name: z.string().min(1).max(120).optional(),
    linkType: linkType.optional(),
    enabled: z.boolean().optional(),
    ethSpeedMbps: z
      .union([z.literal(10), z.literal(100), z.literal(1000)])
      .nullable()
      .optional(),
    brightnessPolicy: z
      .object({
        mode: z.enum(['passthrough', 'pin255']),
        softwareGamma: z.number().min(0.1).max(5).nullable(),
      })
      .optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'empty update' });

// A partial WLED state patch. We intentionally keep this permissive — the device
// is the validator — but block obviously-wrong shapes and full-state dumps.
const statePatch = z.record(z.string(), z.unknown()).refine(
  (v) => Object.keys(v).length > 0 && Object.keys(v).length <= 20,
  { message: 'state patch must have 1–20 fields' },
);

const importNodesBody = z.object({
  hosts: z.array(z.string().min(1)).min(1).max(64),
  linkType: linkType.optional(),
});

function idParam(req: Request): number {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new DeviceError('Invalid device id', 400, 'invalid-id');
  return id;
}

export function deviceRoutes(service: DeviceService): Router {
  const r = Router();

  r.get('/', (_req, res) => {
    res.json({ devices: service.list() });
  });

  r.post('/', async (req, res, next) => {
    try {
      const body = addBody.parse(req.body);
      res.status(201).json({ device: await service.add(body) });
    } catch (err) {
      next(err);
    }
  });

  r.get('/:id', (req, res, next) => {
    try {
      res.json({ device: service.detail(idParam(req)) });
    } catch (err) {
      next(err);
    }
  });

  r.patch('/:id', async (req, res, next) => {
    try {
      const body = updateBody.parse(req.body);
      res.json({ device: await service.update(idParam(req), body) });
    } catch (err) {
      next(err);
    }
  });

  r.delete('/:id', (req, res, next) => {
    try {
      service.remove(idParam(req));
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  r.post('/:id/refresh', async (req, res, next) => {
    try {
      res.json({ device: await service.refresh(idParam(req)) });
    } catch (err) {
      next(err);
    }
  });

  r.post('/:id/refresh-fxdata', async (req, res, next) => {
    try {
      res.json({ device: await service.refreshFxData(idParam(req)) });
    } catch (err) {
      next(err);
    }
  });

  r.post('/:id/state', async (req, res, next) => {
    try {
      const patch = statePatch.parse(req.body);
      res.json(await service.control(idParam(req), patch));
    } catch (err) {
      next(err);
    }
  });

  r.get('/:id/nodes', async (req, res, next) => {
    try {
      res.json({ candidates: await service.discoverNodes(idParam(req)) });
    } catch (err) {
      next(err);
    }
  });

  r.post('/import-nodes', async (req, res, next) => {
    try {
      const { hosts, linkType: lt } = importNodesBody.parse(req.body);
      const results = await Promise.allSettled(
        hosts.map((host) => service.add({ host, linkType: lt })),
      );
      res.json({
        added: results.filter((x) => x.status === 'fulfilled').map((x) => (x as PromiseFulfilledResult<unknown>).value),
        failed: results
          .map((x, i) => ({ host: hosts[i]!, x }))
          .filter(({ x }) => x.status === 'rejected')
          .map(({ host, x }) => ({ host, error: String((x as PromiseRejectedResult).reason?.message ?? x) })),
      });
    } catch (err) {
      next(err);
    }
  });

  return r;
}

/** Express error handler translating our errors + zod errors to JSON. */
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof DeviceError) {
    res.status(err.httpStatus).json({ error: { code: err.code, message: err.message } });
    return;
  }
  if (err instanceof z.ZodError) {
    res.status(400).json({ error: { code: 'validation', message: 'Invalid request body', issues: err.issues } });
    return;
  }
  const message = err instanceof Error ? err.message : 'Internal error';
  res.status(500).json({ error: { code: 'internal', message } });
}

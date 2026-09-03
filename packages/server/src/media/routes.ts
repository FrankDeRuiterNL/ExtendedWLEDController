import express, { Router } from 'express';
import { z } from 'zod';
import { MEDIA_MAX_EDGE } from '@ewc/core';
import { MEDIA_MAX_BYTES, type MediaStore } from './mediaStore.js';

/**
 * Media assets for Studio media layers. The client uploads an already-decoded,
 * downscaled RGBA buffer (`application/octet-stream`) with the dimensions and
 * original filename in the query string.
 */
export function mediaRoutes(store: MediaStore): Router {
  const r = Router();

  r.post(
    '/',
    express.raw({ type: 'application/octet-stream', limit: MEDIA_MAX_BYTES + 1024 }),
    (req, res, next) => {
      try {
        const q = z
          .object({
            w: z.coerce.number().int().min(1).max(MEDIA_MAX_EDGE),
            h: z.coerce.number().int().min(1).max(MEDIA_MAX_EDGE),
            name: z.string().max(200).default('image'),
          })
          .parse(req.query);

        const data = req.body;
        if (!Buffer.isBuffer(data) || data.length !== q.w * q.h * 4) {
          return res.status(400).json({
            error: { code: 'bad-rgba', message: `expected ${q.w * q.h * 4} RGBA bytes, got ${data?.length ?? 0}` },
          });
        }

        const asset = store.create(data, { width: q.w, height: q.h, filename: q.name });
        return res.status(201).json({
          media: { assetId: asset.id, width: asset.width, height: asset.height, filename: asset.filename },
        });
      } catch (err) {
        return next(err);
      }
    },
  );

  // Raw RGBA bytes + dimensions in headers — the browser rebuilds an ImageData.
  r.get('/:id', (req, res) => {
    const asset = store.get(req.params.id);
    if (!asset) return res.status(404).json({ error: { code: 'not-found', message: 'no media asset' } });
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('X-Media-Width', String(asset.width));
    res.setHeader('X-Media-Height', String(asset.height));
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return res.send(asset.data);
  });

  return r;
}

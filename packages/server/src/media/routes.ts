import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import express, { Router } from 'express';
import { z } from 'zod';
import { MEDIA_MAX_EDGE } from '@ewc/core';
import { MEDIA_MAX_BYTES, type MediaStore } from './mediaStore.js';
import {
  MEDIA_VIDEO_MAX_BYTES,
  MEDIA_VIDEO_MAX_SECONDS,
  transcodeToPreviewMp4,
} from './videoTranscode.js';
import { getDecodedVideo } from './videoCache.js';
import { log } from '../logger.js';

export interface MediaRouteOptions {
  /** Whether ffmpeg/ffprobe are available — gates the video upload route. */
  ffmpeg: boolean;
  /** Directory for in-progress upload temp files (under the data volume). */
  tmpDir: string;
  /** Override the video upload byte cap (tests). Defaults to {@link MEDIA_VIDEO_MAX_BYTES}. */
  maxVideoBytes?: number;
}

/**
 * Media assets for Studio media layers.
 *
 * - `POST /`        image: client uploads a decoded, downscaled RGBA buffer
 *                   (`application/octet-stream`) with `?w=&h=&name=`.
 * - `POST /video`   video: client streams the raw file; the server transcodes it
 *                   with ffmpeg to a small no-audio mp4.
 * - `GET /:id`      image → raw RGBA + `X-Media-*` headers; video → the mp4.
 */
export function mediaRoutes(store: MediaStore, opts: MediaRouteOptions): Router {
  const r = Router();
  const maxVideoBytes = opts.maxVideoBytes ?? MEDIA_VIDEO_MAX_BYTES;

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

        const asset = store.createImage(data, { width: q.w, height: q.h, filename: q.name });
        return res.status(201).json({
          media: {
            assetId: asset.id,
            kind: 'image',
            width: asset.width,
            height: asset.height,
            filename: asset.filename,
          },
        });
      } catch (err) {
        return next(err);
      }
    },
  );

  r.post('/video', (req, res) => {
    if (!opts.ffmpeg) {
      return res.status(501).json({
        error: {
          code: 'no-ffmpeg',
          message: 'Video transcoding needs ffmpeg — it is available in the Docker container.',
        },
      });
    }

    const name = z.string().max(200).default('video').parse(req.query.name ?? 'video');
    const uploadPath = join(opts.tmpDir, `up-${randomBytes(9).toString('base64url')}`);
    const outPath = `${uploadPath}.mp4`;
    const ws = createWriteStream(uploadPath);

    let received = 0;
    // One guard for the whole request: set true before any teardown, so the
    // secondary events that teardown itself emits (`req` close, `ws` error) are
    // no-ops and nothing runs — or cleans up — twice.
    let settled = false;
    const cleanup = () => {
      void rm(uploadPath, { force: true });
      void rm(outPath, { force: true });
    };

    const reject = (status: number, code: string, message: string) => {
      if (settled) return;
      settled = true;
      req.unpipe(ws);
      ws.destroy();
      cleanup();
      if (!res.headersSent) res.status(status).json({ error: { code, message } });
      // Stop the (possibly huge) upload now that the response is on its way.
      req.destroy();
    };

    req.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > maxVideoBytes) {
        reject(413, 'too-large', `Video exceeds the ${Math.round(MEDIA_VIDEO_MAX_BYTES / 1024 / 1024)} MB limit.`);
      }
    });
    req.on('error', () => reject(400, 'upload-failed', 'Upload stream error.'));
    ws.on('error', () => reject(500, 'write-failed', 'Could not buffer the upload.'));
    req.on('close', () => {
      // 'close' also fires on a normal, fully-read request — only a close while
      // the body is still incomplete is a client abort.
      if (!req.readableEnded) reject(400, 'aborted', 'Upload aborted.');
    });

    ws.on('finish', () => {
      if (settled) return;
      void (async () => {
        try {
          const meta = await transcodeToPreviewMp4(uploadPath, outPath);
          const asset = store.createVideo(outPath, {
            width: meta.width,
            height: meta.height,
            filename: name,
            fps: meta.fps,
            frameCount: meta.frameCount,
            durationMs: meta.durationMs,
          });
          settled = true;
          cleanup();
          // Pre-warm the frame decode so the first stream of this asset doesn't
          // start with a second of black on that layer.
          void getDecodedVideo({
            assetId: asset.id,
            path: store.videoPath(asset.id),
            width: asset.width,
            height: asset.height,
          });
          log.info(
            `media: video ${asset.id} — ${asset.width}×${asset.height}, ${asset.frameCount} frames @ ${asset.fps} fps`,
          );
          res.status(201).json({
            media: {
              assetId: asset.id,
              kind: 'video',
              width: asset.width,
              height: asset.height,
              filename: asset.filename,
              fps: asset.fps,
              frameCount: asset.frameCount,
              durationMs: asset.durationMs,
              originalWidth: meta.originalWidth,
              originalHeight: meta.originalHeight,
              maxSeconds: MEDIA_VIDEO_MAX_SECONDS,
            },
          });
        } catch (err) {
          settled = true;
          cleanup();
          log.warn('media: video transcode failed', { err: String(err) });
          if (!res.headersSent) {
            res.status(422).json({
              error: { code: 'transcode-failed', message: (err as Error).message || 'Could not process the video.' },
            });
          }
        }
      })();
    });

    req.pipe(ws);
  });

  // Image → raw RGBA bytes + dimensions in headers (the browser rebuilds an
  // ImageData). Video → the transcoded mp4 (the browser plays it in <video>).
  r.get('/:id', (req, res) => {
    const asset = store.get(req.params.id);
    if (!asset) return res.status(404).json({ error: { code: 'not-found', message: 'no media asset' } });
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('X-Media-Kind', asset.kind);
    res.setHeader('X-Media-Width', String(asset.width));
    res.setHeader('X-Media-Height', String(asset.height));
    if (asset.kind === 'video') {
      res.setHeader('X-Media-Fps', String(asset.fps));
      res.setHeader('X-Media-Frame-Count', String(asset.frameCount));
      return res.type('video/mp4').sendFile(asset.path);
    }
    res.setHeader('Content-Type', 'application/octet-stream');
    return res.send(asset.data);
  });

  return r;
}

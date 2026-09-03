import { Router } from 'express';
import { z } from 'zod';
import type { RundownEngine } from './engine.js';
import type { RundownStore } from './store.js';

/**
 * `/api/rundown`
 * - `GET  /`         the saved rundown (cue list) + when it was last saved
 * - `PUT  /`         replace the whole cue list
 * - `GET  /status`   live playback state (poll while running)
 * - `POST /go`       manual GO — start the first playable cue / advance past the current one
 * - `POST /go/:cueId` jump straight to a cue
 * - `POST /stop`     halt playback, fade nothing — devices released
 */
export function rundownRoutes(store: RundownStore, engine: RundownEngine): Router {
  const r = Router();

  r.get('/', (_req, res) => res.json({ rundown: store.get(), updatedAt: store.updatedAt() }));

  r.put('/', (req, res, next) => {
    try {
      const { rundown } = z.object({ rundown: z.unknown() }).parse(req.body);
      const saved = store.save(rundown);
      res.json({ rundown: saved, updatedAt: store.updatedAt() });
    } catch (err) {
      next(err);
    }
  });

  r.get('/status', (_req, res) => res.json(engine.status()));

  r.post('/go', (_req, res) => res.json(engine.go()));

  r.post('/go/:cueId', (req, res) => {
    const cueId = z.string().min(1).max(64).parse(req.params.cueId);
    res.json(engine.goCue(cueId));
  });

  r.post('/stop', (_req, res) => res.json(engine.halt()));

  return r;
}

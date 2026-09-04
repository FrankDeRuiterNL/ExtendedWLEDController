import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import express, { Router } from 'express';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { log } from '../logger.js';
import { applyRestore, buildBackupZip, RestoreError, validateRestoreZip } from './backup.js';

export interface SystemRouteDeps {
  db: Db;
  config: Config;
  mediaDir: string;
  floorplanDir: string;
  /** Stop the live DDP stream / rundown / hubs before the DB is swapped. */
  teardownServices: () => Promise<void>;
}

/**
 * `GET  /api/system/backup`  → downloads the whole install as one `.zip`.
 * `POST /api/system/restore` → uploads that `.zip`, overwrites everything, exits
 *                              (the container's `restart: unless-stopped` brings
 *                              it back on the restored data).
 */
export function systemRoutes(deps: SystemRouteDeps): Router {
  const r = Router();
  const tmpDir = join(deps.config.dataDir, 'tmp');

  r.get('/backup', (_req, res, next) => {
    try {
      const { zip, manifest } = buildBackupZip({
        db: deps.db,
        tmpDir,
        mediaDir: deps.mediaDir,
        floorplanDir: deps.floorplanDir,
      });
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="ewc-backup-${manifest.createdAt.slice(0, 10)}.zip"`,
      );
      res.type('application/zip').send(Buffer.from(zip));
      log.info(
        `system: backup downloaded — ${(zip.length / 1024 / 1024).toFixed(1)} MB, db v${manifest.dbVersion}`,
      );
    } catch (err) {
      next(err);
    }
  });

  r.post(
    '/restore',
    // Any content-type: the browser sends the raw zip bytes. The global
    // express.json() ignores it (wrong type) and would cap it at 2 MB anyway.
    express.raw({ type: () => true, limit: '256mb' }),
    async (req, res) => {
      const body = req.body as unknown;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        return res.status(400).json({ error: { code: 'empty', message: 'No backup file uploaded.' } });
      }

      const stagingDir = join(tmpDir, `restore-${randomBytes(9).toString('hex')}`);
      let staged;
      try {
        staged = validateRestoreZip(body, stagingDir);
      } catch (err) {
        rmSync(stagingDir, { recursive: true, force: true });
        const message =
          err instanceof RestoreError ? err.message : 'The backup could not be read.';
        return res.status(422).json({ error: { code: 'bad-backup', message } });
      }

      log.warn(
        `system: RESTORE starting — wiping all data, applying backup from ${staged.manifest.app} (${staged.manifest.createdAt})`,
      );
      try {
        await deps.teardownServices();
        deps.db.close();
        applyRestore({
          staged,
          dbPath: deps.config.dbPath,
          mediaDir: deps.mediaDir,
          floorplanDir: deps.floorplanDir,
        });
      } catch (err) {
        log.error('system: restore failed mid-apply — data may be inconsistent', {
          err: String(err),
        });
        res.status(500).json({
          error: {
            code: 'restore-failed',
            message: 'Restore failed while applying. The app will restart — check its data.',
          },
        });
        res.on('finish', () => setTimeout(() => process.exit(1), 250));
        return;
      }

      log.warn('system: RESTORE applied — restarting');
      res.json({ ok: true, restarting: true, manifest: staged.manifest });
      res.on('finish', () => setTimeout(() => process.exit(0), 250));
    },
  );

  return r;
}

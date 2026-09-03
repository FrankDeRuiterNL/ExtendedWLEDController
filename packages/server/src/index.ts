import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import { APP_VERSION } from '@ewc/core';
import { loadConfig } from './config.js';
import { openDb } from './db/index.js';
import { deviceRoutes, errorHandler } from './devices/routes.js';
import { DeviceService } from './devices/service.js';
import { DmxService } from './dmx/service.js';
import { FloorplanStore } from './installation/floorplanStore.js';
import { InstallationStore } from './installation/store.js';
import { MediaStore } from './media/mediaStore.js';
import { mediaRoutes } from './media/routes.js';
import { probeFfmpeg } from './media/videoTranscode.js';
import { BrowserHub } from './realtime/browserHub.js';
import { RealtimeHub } from './realtime/hub.js';
import { dmxRoutes, installationRoutes, sceneRoutes, streamRoutes } from './realtime/routes.js';
import { bakeRoutes, paintErrorHandler, paintRoutes, pixelSceneRoutes } from './paint/routes.js';
import { PaintService } from './paint/service.js';
import { PixelSceneStore } from './paint/pixelSceneStore.js';
import { BakeService } from './paint/bakeService.js';
import { SceneStore } from './render/sceneStore.js';
import { StreamService } from './realtime/streamService.js';
import { RundownStore } from './rundown/store.js';
import { RundownEngine } from './rundown/engine.js';
import { rundownRoutes } from './rundown/routes.js';
import { log } from './logger.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const db = openDb(config.dbPath);

  const hub = new RealtimeHub(db, config);
  const dmx = new DmxService(db, config);
  const service = new DeviceService(db, config, hub, dmx);
  const installation = new InstallationStore(db);
  const floorplans = new FloorplanStore(join(config.dataDir, 'floorplan'));
  const media = new MediaStore(join(config.dataDir, 'media'));
  // Scratch space for in-progress media uploads — on the data volume, not the
  // container's writable layer. Wiped on boot so a crash mid-upload can't leak.
  const mediaTmpDir = join(config.dataDir, 'tmp');
  rmSync(mediaTmpDir, { recursive: true, force: true });
  mkdirSync(mediaTmpDir, { recursive: true });
  const ffmpegAvailable = await probeFfmpeg();
  log.info(ffmpegAvailable ? 'ffmpeg found — video media layers enabled' : 'ffmpeg not found — video media layers disabled');
  const scenes = new SceneStore(db);
  const stream = new StreamService(db, config, hub, installation, media);
  const rundownStore = new RundownStore(db);
  const rundown = new RundownEngine(rundownStore, scenes, stream);
  const paint = new PaintService(db, config);
  const pixelScenes = new PixelSceneStore(db);
  const bake = new BakeService(db, config);

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', app: APP_VERSION, core: APP_VERSION, uptime: process.uptime() });
  });

  app.use('/api/devices', paintRoutes(paint));
  app.use('/api/devices', bakeRoutes(bake));
  app.use('/api/pixel-scenes', pixelSceneRoutes(pixelScenes));
  app.use('/api/devices', deviceRoutes(service));
  app.use('/api/dmx', dmxRoutes(dmx));
  app.use('/api/stream', streamRoutes(stream, scenes));
  app.use('/api/scenes', sceneRoutes(scenes));
  app.use('/api/rundown', rundownRoutes(rundownStore, rundown));
  app.use('/api/media', mediaRoutes(media, { ffmpeg: ffmpegAvailable, tmpDir: mediaTmpDir }));
  app.use(
    '/api/installation',
    installationRoutes(installation, floorplans, () => stream.onInstallationChanged()),
  );

  const webDir =
    config.webDir ?? (existsSync(join(process.cwd(), 'packages/web/dist')) ? join(process.cwd(), 'packages/web/dist') : null);
  if (webDir && existsSync(webDir)) {
    app.use(express.static(webDir));
    app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(join(webDir, 'index.html')));
    log.info(`serving web client from ${webDir}`);
  } else {
    log.info('no built web client found; run the Vite dev server separately');
  }

  app.use(paintErrorHandler);
  app.use(errorHandler);

  const server = app.listen(config.port, config.host, () => {
    log.info(`Extended WLED Controller listening on http://${config.host}:${config.port}`, {
      env: config.nodeEnv,
      db: config.dbPath,
    });
  });

  const browserHub = new BrowserHub(server, hub);
  await hub.sync(service.registrySnapshot());

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`${signal} received, shutting down`);
    rundown.shutdown();
    await stream.stop().catch(() => undefined);
    stream.shutdown();
    browserHub.close();
    await hub.stop();
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5_000).unref();
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

void main();

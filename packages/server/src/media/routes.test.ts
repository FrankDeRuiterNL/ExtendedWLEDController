import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MediaStore } from './mediaStore.js';
import { mediaRoutes, type MediaRouteOptions } from './routes.js';

describe('media video upload route', () => {
  let dir: string;
  let tmpDir: string;
  let store: MediaStore;
  let server: ReturnType<express.Express['listen']>;
  let base: string;

  const start = (opts: Partial<MediaRouteOptions>) => {
    const app = express();
    app.use('/api/media', mediaRoutes(store, { ffmpeg: true, tmpDir, ...opts }));
    server = app.listen(0);
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ewc-mr-'));
    tmpDir = join(dir, 'tmp');
    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(tmpDir, { recursive: true });
    store = new MediaStore(join(dir, 'media'));
  });
  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });

  it('answers 501 when ffmpeg is unavailable', async () => {
    start({ ffmpeg: false });
    const res = await fetch(`${base}/api/media/video?name=x.mp4`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: new Uint8Array(16),
    });
    expect(res.status).toBe(501);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('no-ffmpeg');
  });

  it('rejects a body over the byte cap with 413 and leaves no temp file', async () => {
    start({ maxVideoBytes: 1024 });
    const res = await fetch(`${base}/api/media/video?name=big.mp4`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: new Uint8Array(64 * 1024),
    }).catch((e) => e as Error);

    // The server writes 413 then destroys the socket to stop the upload — fetch
    // usually sees the 413, but a connection reset is also acceptable here. The
    // invariant that matters: no temp file is left behind.
    if (res instanceof Response) expect(res.status).toBe(413);
    await new Promise((r) => setTimeout(r, 50));
    expect(readdirSync(tmpDir)).toEqual([]);
  });

  it('rejects a non-video upload with 422 and cleans up', async () => {
    start({});
    const res = await fetch(`${base}/api/media/video?name=notes.txt`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: new TextEncoder().encode('this is not a video'),
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('transcode-failed');
    await new Promise((r) => setTimeout(r, 50));
    expect(readdirSync(tmpDir)).toEqual([]);
  });
});

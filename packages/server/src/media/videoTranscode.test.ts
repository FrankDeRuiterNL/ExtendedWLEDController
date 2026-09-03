import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MEDIA_VIDEO_FPS,
  MEDIA_VIDEO_MAX_EDGE,
  decodeMp4ToRgba,
  probeFfmpeg,
  transcodeToPreviewMp4,
} from './videoTranscode.js';

const hasFfmpeg = await probeFfmpeg();
const d = hasFfmpeg ? describe : describe.skip;

d('video transcode pipeline (needs ffmpeg)', () => {
  let dir: string;
  let srcPath: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ewc-vt-'));
    srcPath = join(dir, 'src.mp4');
    // 2 s of colour bars at 320×240, 30 fps, no audio.
    const res = spawnSync('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=320x240:rate=30:duration=2',
      '-pix_fmt',
      'yuv420p',
      srcPath,
    ]);
    if (res.status !== 0) throw new Error(`fixture ffmpeg failed: ${res.stderr}`);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('downscales, drops audio, caps fps, and reports original size', async () => {
    const out = join(dir, 'out.mp4');
    const meta = await transcodeToPreviewMp4(srcPath, out);

    expect(Math.max(meta.width, meta.height)).toBe(MEDIA_VIDEO_MAX_EDGE);
    expect(meta.width % 2).toBe(0);
    expect(meta.height % 2).toBe(0);
    expect(meta.fps).toBe(MEDIA_VIDEO_FPS);
    expect(meta.originalWidth).toBe(320);
    expect(meta.originalHeight).toBe(240);
    // ~2 s at 20 fps
    expect(meta.frameCount).toBeGreaterThanOrEqual(35);
    expect(meta.frameCount).toBeLessThanOrEqual(45);
  });

  it('decodes the transcoded clip to a flat RGBA buffer', async () => {
    const out = join(dir, 'out2.mp4');
    const meta = await transcodeToPreviewMp4(srcPath, out);
    const decoded = await decodeMp4ToRgba(out, meta.width, meta.height);

    expect(decoded.width).toBe(meta.width);
    expect(decoded.height).toBe(meta.height);
    expect(decoded.frameCount).toBe(meta.frameCount);
    expect(decoded.data.length).toBe(meta.frameCount * meta.width * meta.height * 4);
    // testsrc is a bright pattern — the buffer can't be all-zero.
    expect(decoded.data.some((b) => b > 0)).toBe(true);
  });

  it('rejects a file with no video stream', async () => {
    const notVideo = join(dir, 'notes.txt');
    rmSync(notVideo, { force: true });
    spawnSync('node', ['-e', `require('fs').writeFileSync(${JSON.stringify(notVideo)}, 'hello')`]);
    await expect(transcodeToPreviewMp4(notVideo, join(dir, 'never.mp4'))).rejects.toThrow();
  });
});

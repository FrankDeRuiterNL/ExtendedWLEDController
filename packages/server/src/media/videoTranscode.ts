import { spawn } from 'node:child_process';

/**
 * ffmpeg wrapper for Studio **video** media layers (milestone 8b).
 *
 * Uploaded clips are transcoded once, on upload, to a small no-audio H.264 mp4
 * (`MEDIA_VIDEO_MAX_EDGE` long edge, `MEDIA_VIDEO_FPS`, capped at
 * `MEDIA_VIDEO_MAX_SECONDS`). That single artifact feeds both consumers: the
 * browser plays it in a hidden `<video>` for the preview, and the server decodes
 * it to raw RGBA frames in memory (see {@link decodeMp4ToRgba}) for the DDP wire.
 *
 * ffmpeg is only present in the Docker image (`apk add ffmpeg`); on a bare dev
 * host {@link probeFfmpeg} returns false and the upload route answers 501.
 */

/** Longest edge (px) the transcoded clip is scaled to. Sparse fixtures don't
 *  resolve more, and it keeps the in-memory decode small. */
export const MEDIA_VIDEO_MAX_EDGE = 128;
/** Frame rate of the transcoded clip. */
export const MEDIA_VIDEO_FPS = 20;
/** Clips longer than this are truncated to the first N seconds on transcode. */
export const MEDIA_VIDEO_MAX_SECONDS = 90;
/** Upload hard limit (matches the spec's 500 MB). Enforced while streaming in. */
export const MEDIA_VIDEO_MAX_BYTES = 500 * 1024 * 1024;

export interface TranscodeResult {
  /** Transcoded (downscaled) frame size. */
  width: number;
  height: number;
  fps: number;
  frameCount: number;
  durationMs: number;
  /** Native size of the *original* upload — used for the layer's aspect lock. */
  originalWidth: number;
  originalHeight: number;
}

export interface DecodedVideo {
  width: number;
  height: number;
  frameCount: number;
  /** `frameCount * width * height * 4` bytes, RGBA, frame 0 first. */
  data: Uint8ClampedArray;
}

let ffmpegProbe: Promise<boolean> | null = null;

/** Whether an `ffmpeg` (and `ffprobe`) binary is on PATH. Cached after the first call. */
export function probeFfmpeg(): Promise<boolean> {
  if (!ffmpegProbe) {
    ffmpegProbe = Promise.all([which('ffmpeg'), which('ffprobe')]).then(([a, b]) => a && b);
  }
  return ffmpegProbe;
}

function which(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn(bin, ['-version'], { stdio: 'ignore' });
    p.on('error', () => resolve(false));
    p.on('close', (code) => resolve(code === 0));
  });
}

function run(
  bin: string,
  args: string[],
  opts: { captureStdout?: boolean; maxStdoutBytes?: number } = {},
): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', opts.captureStdout ? 'pipe' : 'ignore', 'pipe'] });
    const out: Buffer[] = [];
    let outLen = 0;
    let err = '';
    p.stdout?.on('data', (c: Buffer) => {
      outLen += c.length;
      if (opts.maxStdoutBytes && outLen > opts.maxStdoutBytes) {
        p.kill('SIGKILL');
        reject(new Error(`${bin}: output exceeded ${opts.maxStdoutBytes} bytes`));
        return;
      }
      out.push(c);
    });
    p.stderr?.on('data', (c: Buffer) => {
      err += c.toString();
      if (err.length > 64_000) err = err.slice(-64_000);
    });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) resolve({ stdout: Buffer.concat(out), stderr: err });
      else reject(new Error(`${bin} exited ${code}: ${err.trim().split('\n').slice(-3).join(' / ')}`));
    });
  });
}

interface ProbeStream {
  width?: number;
  height?: number;
  nb_read_frames?: string;
  r_frame_rate?: string;
  duration?: string;
}

async function probe(path: string, countFrames: boolean): Promise<ProbeStream> {
  const args = [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    ...(countFrames ? ['-count_frames'] : []),
    '-show_entries',
    `stream=width,height,r_frame_rate,duration${countFrames ? ',nb_read_frames' : ''}`,
    '-of',
    'json',
    path,
  ];
  const { stdout } = await run('ffprobe', args, { captureStdout: true, maxStdoutBytes: 1_000_000 });
  const parsed = JSON.parse(stdout.toString() || '{}') as { streams?: ProbeStream[] };
  return parsed.streams?.[0] ?? {};
}

/**
 * Transcode `srcPath` (any ffmpeg-readable video) to a small no-audio H.264 mp4
 * at `destPath`. Rejects if the source has no usable video stream.
 */
export async function transcodeToPreviewMp4(
  srcPath: string,
  destPath: string,
): Promise<TranscodeResult> {
  const src = await probe(srcPath, false);
  const originalWidth = src.width ?? 0;
  const originalHeight = src.height ?? 0;
  if (!originalWidth || !originalHeight) {
    throw new Error('no video stream found in the upload');
  }

  await run('ffmpeg', [
    '-y',
    '-t',
    String(MEDIA_VIDEO_MAX_SECONDS),
    '-i',
    srcPath,
    '-an',
    '-sn',
    '-vf',
    `scale=${MEDIA_VIDEO_MAX_EDGE}:${MEDIA_VIDEO_MAX_EDGE}:force_original_aspect_ratio=decrease:force_divisible_by=2,fps=${MEDIA_VIDEO_FPS}`,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    destPath,
  ]);

  const out = await probe(destPath, true);
  const width = out.width ?? 0;
  const height = out.height ?? 0;
  const frameCount = Number(out.nb_read_frames) || 0;
  if (!width || !height || !frameCount) {
    throw new Error('transcode produced no frames');
  }
  const durationMs = Math.round((frameCount / MEDIA_VIDEO_FPS) * 1000);
  return {
    width,
    height,
    fps: MEDIA_VIDEO_FPS,
    frameCount,
    durationMs,
    originalWidth,
    originalHeight,
  };
}

/**
 * Decode a transcoded mp4 to a flat RGBA frame buffer in memory. Bounded by the
 * transcode caps: {@link MEDIA_VIDEO_MAX_EDGE}² × 4 × {@link MEDIA_VIDEO_FPS} ×
 * {@link MEDIA_VIDEO_MAX_SECONDS} ≈ 118 MB worst case (typically far less).
 */
export async function decodeMp4ToRgba(
  mp4Path: string,
  width: number,
  height: number,
): Promise<DecodedVideo> {
  const frameBytes = width * height * 4;
  const cap = frameBytes * MEDIA_VIDEO_FPS * MEDIA_VIDEO_MAX_SECONDS + frameBytes;
  const { stdout } = await run(
    'ffmpeg',
    ['-v', 'error', '-i', mp4Path, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'],
    { captureStdout: true, maxStdoutBytes: cap },
  );
  const frameCount = Math.floor(stdout.length / frameBytes);
  if (frameCount <= 0) throw new Error('decode produced no frames');
  const data = new Uint8ClampedArray(stdout.buffer, stdout.byteOffset, frameCount * frameBytes);
  return { width, height, frameCount, data };
}

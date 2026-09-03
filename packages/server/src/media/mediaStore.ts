import { randomBytes } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { MEDIA_MAX_EDGE } from '@ewc/core';

/** Upper bound on a stored **image** RGBA blob (256×256×4 ≈ 256 KB, with headroom). */
export const MEDIA_MAX_BYTES = MEDIA_MAX_EDGE * MEDIA_MAX_EDGE * 4;

export type MediaKind = 'image' | 'video';

interface MediaMetaBase {
  kind: MediaKind;
  /** Stored (downscaled) pixel size. */
  width: number;
  height: number;
  filename: string;
  createdAt: string;
}

export interface ImageMeta extends MediaMetaBase {
  kind: 'image';
}

export interface VideoMeta extends MediaMetaBase {
  kind: 'video';
  fps: number;
  frameCount: number;
  durationMs: number;
}

export type MediaMeta = ImageMeta | VideoMeta;

export interface ImageAsset extends ImageMeta {
  id: string;
  /** Tightly packed RGBA, `width * height * 4` bytes. */
  data: Buffer;
}

export interface VideoAsset extends VideoMeta {
  id: string;
  /** Absolute path to the transcoded no-audio mp4. */
  path: string;
}

export type MediaAsset = ImageAsset | VideoAsset;

/**
 * Stores media for Studio media layers under the data dir.
 *
 * **Images** (8a): the browser decodes the upload (it has to, for the preview)
 * and ships raw downscaled RGBA, so the server runs no image codec and the
 * preview and the wire sample byte-identical data. Stored as `<id>.rgba` +
 * `<id>.json`.
 *
 * **Videos** (8b): ffmpeg transcodes the upload once to a small no-audio mp4
 * (see `videoTranscode.ts`). That one file feeds the browser `<video>` preview
 * and the server's in-memory frame decode. Stored as `<id>.mp4` + `<id>.json`.
 */
export class MediaStore {
  constructor(private readonly dir: string) {}

  private ensureDir(): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
  }

  private metaPath(id: string): string {
    return join(this.dir, `${id}.json`);
  }
  private blobPath(id: string): string {
    return join(this.dir, `${id}.rgba`);
  }
  /** Path the transcoded mp4 for a video asset lives at. */
  videoPath(id: string): string {
    return join(this.dir, `${id}.mp4`);
  }

  private newId(): string {
    return randomBytes(9).toString('base64url');
  }

  /** Store a new decoded **image** RGBA blob, returning its generated id. */
  createImage(
    data: Buffer,
    meta: { width: number; height: number; filename: string },
  ): ImageAsset {
    if (data.length !== meta.width * meta.height * 4) {
      throw new Error(
        `RGBA length ${data.length} ≠ ${meta.width}×${meta.height}×4 (${meta.width * meta.height * 4})`,
      );
    }
    this.ensureDir();
    const id = this.newId();
    const record: ImageMeta = {
      kind: 'image',
      width: meta.width,
      height: meta.height,
      filename: meta.filename.slice(0, 200),
      createdAt: new Date().toISOString(),
    };
    writeFileSync(this.blobPath(id), data);
    writeFileSync(this.metaPath(id), JSON.stringify(record));
    return { id, data, ...record };
  }

  /**
   * Store a new **video** asset: move the already-transcoded mp4 at
   * `transcodedMp4Path` into the store and write its meta.
   */
  createVideo(
    transcodedMp4Path: string,
    meta: {
      width: number;
      height: number;
      filename: string;
      fps: number;
      frameCount: number;
      durationMs: number;
    },
  ): VideoAsset {
    this.ensureDir();
    const id = this.newId();
    const record: VideoMeta = {
      kind: 'video',
      width: meta.width,
      height: meta.height,
      filename: meta.filename.slice(0, 200),
      createdAt: new Date().toISOString(),
      fps: meta.fps,
      frameCount: meta.frameCount,
      durationMs: meta.durationMs,
    };
    const dest = this.videoPath(id);
    copyFileSync(transcodedMp4Path, dest);
    writeFileSync(this.metaPath(id), JSON.stringify(record));
    return { id, path: dest, ...record };
  }

  has(id: string): boolean {
    return existsSync(this.metaPath(id));
  }

  get(id: string): MediaAsset | null {
    if (!existsSync(this.metaPath(id))) return null;
    let record: MediaMeta;
    try {
      record = JSON.parse(readFileSync(this.metaPath(id), 'utf8')) as MediaMeta;
    } catch {
      return null;
    }
    if (record.kind === 'video') {
      const path = this.videoPath(id);
      if (!existsSync(path)) return null;
      return { id, path, ...record };
    }
    if (!existsSync(this.blobPath(id))) return null;
    return { id, data: readFileSync(this.blobPath(id)), ...record };
  }

  /** Ids of every stored asset. */
  list(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((n) => n.endsWith('.json'))
      .map((n) => n.slice(0, -'.json'.length));
  }

  remove(id: string): void {
    rmSync(this.metaPath(id), { force: true });
    rmSync(this.blobPath(id), { force: true });
    rmSync(this.videoPath(id), { force: true });
  }
}

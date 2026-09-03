import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MEDIA_MAX_EDGE } from '@ewc/core';

/** Upper bound on a stored RGBA blob (256×256×4 ≈ 256 KB, with headroom). */
export const MEDIA_MAX_BYTES = MEDIA_MAX_EDGE * MEDIA_MAX_EDGE * 4;

export interface MediaMeta {
  width: number;
  height: number;
  filename: string;
  createdAt: string;
}

export interface MediaAsset extends MediaMeta {
  id: string;
  /** Tightly packed RGBA, `width * height * 4` bytes. */
  data: Buffer;
}

/**
 * Stores decoded, downscaled **RGBA blobs** for media layers under the data dir.
 * The browser decodes the uploaded image (it has to, for the preview) and ships
 * the raw pixels, so the server never runs an image codec — and the preview and
 * the wire sample byte-identical data.
 *
 * Each asset is `<id>.rgba` (pixels) + `<id>.json` (dimensions + original name).
 */
export class MediaStore {
  constructor(private readonly dir: string) {}

  private ensureDir(): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
  }

  private paths(id: string): { blob: string; meta: string } {
    return { blob: join(this.dir, `${id}.rgba`), meta: join(this.dir, `${id}.json`) };
  }

  /** Store a new RGBA blob, returning its generated id. */
  create(data: Buffer, meta: { width: number; height: number; filename: string }): MediaAsset {
    if (data.length !== meta.width * meta.height * 4) {
      throw new Error(
        `RGBA length ${data.length} ≠ ${meta.width}×${meta.height}×4 (${meta.width * meta.height * 4})`,
      );
    }
    this.ensureDir();
    const id = randomBytes(9).toString('base64url');
    const record: MediaMeta = {
      width: meta.width,
      height: meta.height,
      filename: meta.filename.slice(0, 200),
      createdAt: new Date().toISOString(),
    };
    const { blob, meta: metaPath } = this.paths(id);
    writeFileSync(blob, data);
    writeFileSync(metaPath, JSON.stringify(record));
    return { id, data, ...record };
  }

  has(id: string): boolean {
    return existsSync(this.paths(id).blob);
  }

  get(id: string): MediaAsset | null {
    const { blob, meta } = this.paths(id);
    if (!existsSync(blob) || !existsSync(meta)) return null;
    try {
      const record = JSON.parse(readFileSync(meta, 'utf8')) as MediaMeta;
      return { id, data: readFileSync(blob), ...record };
    } catch {
      return null;
    }
  }

  /** Ids of every stored asset. */
  list(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((n) => n.endsWith('.rgba'))
      .map((n) => n.slice(0, -'.rgba'.length));
  }

  remove(id: string): void {
    const { blob, meta } = this.paths(id);
    rmSync(blob, { force: true });
    rmSync(meta, { force: true });
  }
}

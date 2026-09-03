import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** MIME → file extension for the image formats a floorplan may be uploaded as. */
const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export const FLOORPLAN_MIME_TYPES = Object.keys(EXT_BY_MIME);

/** Content-type to serve a stored floorplan file back with, keyed by extension. */
const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

/**
 * Stores the single floorplan image on disk under the data dir. The file name is
 * deterministic (`floorplan.<ext>`) so a re-upload overwrites in place; the
 * installation JSON carries a `rev` counter for cache-busting instead.
 */
export class FloorplanStore {
  constructor(private readonly dir: string) {}

  private ensureDir(): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
  }

  /** Absolute path of a stored asset by its file name. */
  path(asset: string): string {
    return join(this.dir, asset);
  }

  mimeFor(asset: string): string {
    const ext = asset.split('.').pop() ?? '';
    return MIME_BY_EXT[ext] ?? 'application/octet-stream';
  }

  /**
   * Write new floorplan bytes, replacing any previous file (possibly a different
   * extension). Returns the stored file name.
   */
  write(bytes: Buffer, mime: string): string {
    const ext = EXT_BY_MIME[mime];
    if (!ext) throw new Error(`unsupported floorplan type: ${mime}`);
    this.ensureDir();
    this.clear();
    const asset = `floorplan.${ext}`;
    writeFileSync(join(this.dir, asset), bytes);
    return asset;
  }

  /** Remove every stored floorplan file. */
  clear(): void {
    if (!existsSync(this.dir)) return;
    for (const name of readdirSync(this.dir)) {
      if (name.startsWith('floorplan.')) rmSync(join(this.dir, name), { force: true });
    }
  }
}

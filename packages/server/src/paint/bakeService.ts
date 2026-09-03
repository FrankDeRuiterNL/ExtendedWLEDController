// `gifenc`'s package `main` is a CommonJS bundle whose named exports Node's ESM
// loader can't see; its `module` (ESM) bundle has real named exports. Import that
// directly so it works identically under Node and under vitest.
import { GIFEncoder, applyPalette, quantize } from 'gifenc/dist/gifenc.esm.js';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { log } from '../logger.js';
import { WledHttpError, fetchInfo, postState, uploadFile, type WledEndpoint } from '../wled/httpClient.js';
import { DeviceRepo, type DeviceRow } from '../devices/repo.js';
import { PixelSceneStore } from './pixelSceneStore.js';

export class BakeError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'BakeError';
  }
}

/** Filesystem headroom to keep free after an upload (KB). */
const FS_MARGIN_KB = 12;

/**
 * Encode a single-frame GIF, `width × 1`, from one row of pixels. `null` = black.
 * `pixels` are `RRGGBB` hex (no `#`).
 */
export function encodePixelRowGif(pixels: ReadonlyArray<string | null>): Uint8Array {
  const w = Math.max(1, pixels.length);
  const rgba = new Uint8ClampedArray(w * 4);
  for (let i = 0; i < w; i++) {
    const hex = pixels[i];
    const o = i * 4;
    if (hex) {
      rgba[o] = parseInt(hex.slice(0, 2), 16) || 0;
      rgba[o + 1] = parseInt(hex.slice(2, 4), 16) || 0;
      rgba[o + 2] = parseInt(hex.slice(4, 6), 16) || 0;
    }
    rgba[o + 3] = 255;
  }
  const palette = quantize(rgba, 256);
  const index = applyPalette(rgba, palette);
  const gif = GIFEncoder();
  gif.writeFrame(index, w, 1, { palette, repeat: 0, delay: 0 });
  gif.finish();
  return gif.bytesView();
}

export interface BakeInput {
  segId?: number;
  /** 1..250 — `psave` to this preset after the GIF is loaded. */
  preset?: number;
  /** Segment-relative; `RRGGBB` hex or null. */
  pixels: Array<string | null>;
  /** Deterministic file stem (no extension) — one `.gif` per stem, overwritten in place. */
  name: string;
}

export interface BakeResult {
  ok: true;
  filename: string;
  bytes: number;
  freeKbBefore: number | null;
  freeKbAfter: number | null;
  preset: number | null;
  imageEffect: number | null;
}

/**
 * Bake a static pixel image to a device: encode a one-frame GIF, upload it to the
 * device filesystem, point the target segment at it (`seg.n` + the Image effect),
 * and optionally `psave` it as a preset so it survives a reboot.
 *
 * Deterministic filenames (overwrite in place) — the `/edit` delete route 404s on
 * real 16.0.1 hardware, so accumulating uniquely-named files would fill the ~1 MB
 * filesystem with no way to clean up.
 */
export class BakeService {
  private readonly repo: DeviceRepo;
  private readonly scenes: PixelSceneStore;

  constructor(
    db: Db,
    private readonly config: Config,
  ) {
    this.repo = new DeviceRepo(db);
    this.scenes = new PixelSceneStore(db);
  }

  private endpoint(row: DeviceRow): WledEndpoint {
    return { host: row.host, port: row.port, timeoutMs: this.config.wledHttpTimeoutMs };
  }

  private requireRow(id: number): DeviceRow {
    const row = this.repo.get(id);
    if (!row) throw new BakeError(`No device ${id}`, 404, 'not-found');
    return row;
  }

  /** Resolve a saved pixel scene to a hex/null pixel array. */
  pixelsForScene(sceneId: number): { pixels: Array<string | null>; name: string } {
    const dto = this.scenes.get(sceneId);
    if (!dto) throw new BakeError(`No pixel scene ${sceneId}`, 404, 'not-found');
    return { pixels: dto.scene.pixels.slice(), name: `px${sceneId}` };
  }

  private imageEffectId(deviceId: number): number | null {
    const effects = this.repo.rawPayloads(deviceId).effects ?? [];
    const idx = effects.findIndex((e) => e.toLowerCase() === 'image');
    return idx >= 0 ? idx : null;
  }

  async bake(deviceId: number, input: BakeInput): Promise<BakeResult> {
    const row = this.requireRow(deviceId);
    const ep = this.endpoint(row);

    if (input.pixels.length === 0) throw new BakeError('nothing to bake', 400, 'empty');
    const stem = input.name.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'bake';
    const filename = `${stem}.gif`;

    // No Image effect = no GIF decoder (typical on ESP8266). Refuse before we
    // leave an unplayable file on a device that can't remove it.
    const imageEffect = this.imageEffectId(deviceId);
    if (imageEffect == null) {
      throw new BakeError(
        `${row.name} has no "Image" effect — its firmware can't play a baked GIF (ESP8266 builds omit it).`,
        422,
        'no-gif-support',
      );
    }

    const gif = encodePixelRowGif(input.pixels);

    // Free-space gate — the GIF decoder fails outright on a full filesystem.
    let freeKbBefore: number | null = null;
    try {
      const info = await fetchInfo(ep);
      if (info.fs && typeof info.fs.t === 'number' && typeof info.fs.u === 'number') {
        freeKbBefore = info.fs.t - info.fs.u;
        const needKb = Math.ceil(gif.length / 1024) + FS_MARGIN_KB;
        if (needKb > freeKbBefore) {
          throw new BakeError(
            `Not enough space on ${row.name}: need ~${needKb} KB, ${freeKbBefore} KB free.`,
            507,
            'no-space',
          );
        }
      }
    } catch (err) {
      if (err instanceof BakeError) throw err;
      // couldn't read fs — proceed, the upload itself will fail if truly full
      log.debug(`bake: could not read fs info for device ${deviceId}`, { err: String(err) });
    }

    try {
      await uploadFile(ep, filename, gif, 'image/gif');
    } catch (err) {
      throw this.wrap(err, 'upload rejected');
    }

    try {
      await postState(ep, { on: true, seg: [{ id: input.segId ?? 0, n: filename, fx: imageEffect }] });
    } catch (err) {
      throw this.wrap(err, 'could not point the segment at the GIF');
    }

    let preset: number | null = null;
    if (input.preset != null) {
      try {
        await postState(ep, { psave: input.preset, n: `Bake ${stem}` });
        preset = input.preset;
      } catch (err) {
        throw this.wrap(err, `GIF is playing but psave to preset ${input.preset} failed`);
      }
    }

    let freeKbAfter: number | null = null;
    try {
      const after = await fetchInfo(ep);
      if (after.fs && typeof after.fs.t === 'number' && typeof after.fs.u === 'number') {
        freeKbAfter = after.fs.t - after.fs.u;
      }
    } catch {
      /* best effort */
    }

    log.info(`baked ${filename} to device ${deviceId}`, { bytes: gif.length, preset, imageEffect });
    return { ok: true, filename, bytes: gif.length, freeKbBefore, freeKbAfter, preset, imageEffect };
  }

  private wrap(err: unknown, what: string): BakeError {
    if (err instanceof BakeError) return err;
    if (err instanceof WledHttpError) {
      return new BakeError(`Device did not accept the bake — ${what}: ${err.message}`, 502, 'device-unreachable');
    }
    return new BakeError(`Bake failed — ${what}: ${(err as Error).message}`, 500, 'bake-failed');
  }
}

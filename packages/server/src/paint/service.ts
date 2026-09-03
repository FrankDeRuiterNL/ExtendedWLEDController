import {
  buildDensePaint,
  buildSparsePaint,
  paintPreamble,
  paintRelease,
  type WledSegment,
} from '@ewc/core';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { log } from '../logger.js';
import { WledHttpError, postState, type WledEndpoint } from '../wled/httpClient.js';
import { DeviceRepo, type DeviceRow } from '../devices/repo.js';

export class PaintError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'PaintError';
  }
}

/** A colour as [r,g,b] (0..255) or a WLED hex string (`RRGGBB`, no `#`). */
export type PaintColor = readonly number[] | string;

export interface PaintInput {
  segId?: number;
  /** Working brightness for the paint (1..255). */
  brightness?: number;
  /**
   * `dense` — `pixels` is the whole run from segment-relative index 0; every
   * addressed LED is set, the effect is fully replaced.
   * `sparse` — only `painted` indices are set; the rest keep running the effect.
   */
  mode: 'dense' | 'sparse';
  pixels?: PaintColor[];
  painted?: Array<{ index: number; color: PaintColor }>;
}

/** Gap between sequential `seg.i` chunk POSTs — WLED's HTTP buffer is small. */
const INTER_CHUNK_MS = 40;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Direct per-pixel painting via a segment's `i` field (`seg.i`).
 *
 * Live tool only — never persisted, lost on power-off. Writing `seg.i` freezes
 * the segment; `release()` un-freezes it and the effect resumes. Chunks go out
 * strictly sequentially with a small delay, and a failed chunk aborts the rest
 * (the strip is left half-painted — the caller is told which chunk failed).
 *
 * The painter is **1-D-strip only** for now: the matrix `y*w+x` addressing in
 * `@ewc/core` is unverified against a real panel.
 */
export class PaintService {
  private readonly repo: DeviceRepo;

  constructor(
    db: Db,
    private readonly config: Config,
  ) {
    this.repo = new DeviceRepo(db);
  }

  private endpoint(row: DeviceRow): WledEndpoint {
    return { host: row.host, port: row.port, timeoutMs: this.config.wledHttpTimeoutMs };
  }

  private requireRow(id: number): DeviceRow {
    const row = this.repo.get(id);
    if (!row) throw new PaintError(`No device ${id}`, 404, 'not-found');
    return row;
  }

  async paint(id: number, input: PaintInput): Promise<{ ok: true; chunks: number; pixels: number }> {
    const row = this.requireRow(id);
    const ep = this.endpoint(row);
    const segId = input.segId ?? 0;

    let chunks: WledSegment[];
    let pixelCount: number;
    if (input.mode === 'dense') {
      const pixels = input.pixels ?? [];
      if (pixels.length === 0) throw new PaintError('dense paint has no pixels', 400, 'empty');
      chunks = buildDensePaint(pixels, { segId });
      pixelCount = pixels.length;
    } else {
      const painted = input.painted ?? [];
      if (painted.length === 0) throw new PaintError('sparse paint has no pixels', 400, 'empty');
      chunks = buildSparsePaint(painted, { segId });
      pixelCount = painted.length;
    }

    // Power / brightness MUST land before any pixel write.
    try {
      await postState(ep, paintPreamble(input.brightness ?? 128));
    } catch (err) {
      throw this.wrap(err, 'preamble (power/brightness) rejected');
    }

    for (let k = 0; k < chunks.length; k++) {
      try {
        await postState(ep, { seg: [chunks[k]!] });
      } catch (err) {
        throw this.wrap(err, `chunk ${k + 1}/${chunks.length} rejected — strip left partially painted`);
      }
      if (k < chunks.length - 1) await sleep(INTER_CHUNK_MS);
    }

    log.info(`painted device ${id}`, { segId, mode: input.mode, chunks: chunks.length, pixels: pixelCount });
    return { ok: true, chunks: chunks.length, pixels: pixelCount };
  }

  /** Un-freeze the segment so its effect resumes. */
  async release(id: number, segId = 0): Promise<{ ok: true }> {
    const row = this.requireRow(id);
    try {
      await postState(this.endpoint(row), paintRelease(segId));
    } catch (err) {
      throw this.wrap(err, 'release rejected');
    }
    log.info(`released paint on device ${id}`, { segId });
    return { ok: true };
  }

  private wrap(err: unknown, what: string): PaintError {
    if (err instanceof WledHttpError) {
      return new PaintError(`Device did not accept the paint — ${what}: ${err.message}`, 502, 'device-unreachable');
    }
    return new PaintError(`Paint failed — ${what}: ${(err as Error).message}`, 500, 'paint-failed');
  }
}

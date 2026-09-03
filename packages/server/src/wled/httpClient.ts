import type { WledCfg, WledInfo, WledState } from '@ewc/core';
import { padStringArray, salvageJsonStringArray } from '@ewc/core';
import { log } from '../logger.js';

export class WledHttpError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'WledHttpError';
  }
}

export interface WledEndpoint {
  host: string;
  port: number;
  timeoutMs: number;
  /**
   * How many times to re-request `/json/fxdata` (and `/json/cfg`) when the
   * device returns a truncated body. Real WLED 16.0.x / QuinLED hardware serves
   * these chunked and cuts them off under load ~85% of the time; retrying is
   * the only reliable fix. See `salvageJsonStringArray`.
   */
  bulkRetries?: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** WLED has no TLS — always plain http. */
function baseUrl(e: WledEndpoint): string {
  const hostPart = e.host.includes(':') && !e.host.startsWith('[') ? `[${e.host}]` : e.host;
  return e.port === 80 ? `http://${hostPart}` : `http://${hostPart}:${e.port}`;
}

async function getJson<T>(e: WledEndpoint, path: string): Promise<T> {
  const url = `${baseUrl(e)}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(e.timeoutMs),
    });
  } catch (err) {
    throw new WledHttpError(`GET ${path} failed: ${(err as Error).message}`, err);
  }
  if (!res.ok) throw new WledHttpError(`GET ${path} → HTTP ${res.status}`, undefined, res.status);
  try {
    return (await res.json()) as T;
  } catch (err) {
    throw new WledHttpError(`GET ${path}: invalid JSON`, err, res.status);
  }
}

async function getText(e: WledEndpoint, path: string): Promise<string> {
  const url = `${baseUrl(e)}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(e.timeoutMs),
    });
  } catch (err) {
    throw new WledHttpError(`GET ${path} failed: ${(err as Error).message}`, err);
  }
  if (!res.ok) throw new WledHttpError(`GET ${path} → HTTP ${res.status}`, undefined, res.status);
  return res.text();
}

export interface FxDataResult {
  fxdata: string[];
  /** True when a full, untruncated array was received. */
  complete: boolean;
  /** Number of requests it took. */
  attempts: number;
}

/**
 * Fetch `/json/fxdata`, retrying past the device's frequent chunked-response
 * truncation. Accepts the first response that parses to `expectedCount` entries;
 * failing that, returns the best salvaged partial padded to length.
 */
export async function fetchFxData(
  e: WledEndpoint,
  expectedCount: number | undefined,
): Promise<FxDataResult> {
  const maxAttempts = Math.max(1, e.bulkRetries ?? 15);
  let best: string[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let text: string;
    try {
      text = await getText(e, '/json/fxdata');
    } catch (err) {
      log.debug(`/json/fxdata attempt ${attempt} failed`, { err: String(err) });
      await sleep(150 + attempt * 50);
      continue;
    }

    const salvage = salvageJsonStringArray(text);
    if (salvage.values.length > best.length) best = salvage.values;

    const longEnough = expectedCount === undefined || salvage.values.length >= expectedCount;
    if (salvage.complete && longEnough) {
      return { fxdata: salvage.values, complete: true, attempts: attempt };
    }
    log.debug(`/json/fxdata attempt ${attempt}: ${salvage.values.length}/${expectedCount ?? '?'} entries`);
    await sleep(150 + attempt * 50);
  }

  const padded = expectedCount ? padStringArray(best, expectedCount) : best;
  log.warn(`/json/fxdata never returned in full after ${maxAttempts} tries`, {
    host: e.host,
    salvaged: best.length,
    expected: expectedCount ?? null,
  });
  return { fxdata: padded, complete: false, attempts: maxAttempts };
}

async function getJsonWithRetry<T>(e: WledEndpoint, path: string, tries: number): Promise<T | null> {
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const text = await getText(e, path);
      return JSON.parse(text) as T;
    } catch (err) {
      log.debug(`${path} attempt ${attempt}/${tries} failed`, { err: String(err) });
      if (attempt < tries) await sleep(150 + attempt * 50);
    }
  }
  return null;
}

async function postJson<T>(e: WledEndpoint, path: string, body: unknown): Promise<T> {
  const url = `${baseUrl(e)}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(e.timeoutMs),
    });
  } catch (err) {
    throw new WledHttpError(`POST ${path} failed: ${(err as Error).message}`, err);
  }
  if (!res.ok) throw new WledHttpError(`POST ${path} → HTTP ${res.status}`, undefined, res.status);
  try {
    return (await res.json()) as T;
  } catch {
    // Some WLED builds answer POST /json with an empty body on success.
    return {} as T;
  }
}

export interface WledSnapshot {
  info: WledInfo;
  state: WledState;
  effects: string[];
  palettes: string[];
  fxdata: string[];
  /** False when fxdata had to be salvaged/padded past device truncation. */
  fxdataComplete: boolean;
  cfg: WledCfg | null;
}

/**
 * Fetch everything the registry needs on device add / refresh.
 *
 * `/json` (combined) carries state + info + effects + palettes and — unlike the
 * individual `/json/eff` and `/json/pal` sub-resources — comes back complete
 * reliably on real hardware. `/json/fxdata` and `/json/cfg` have no combined
 * form and must be fetched (and retried past truncation) on their own.
 */
export async function fetchSnapshot(e: WledEndpoint): Promise<WledSnapshot> {
  const combined = await getJson<{
    state: WledState;
    info: WledInfo;
    effects: string[];
    palettes: string[];
  }>(e, '/json');

  const fxcount = typeof combined.info?.fxcount === 'number' ? combined.info.fxcount : undefined;

  const [fx, cfg] = await Promise.all([
    fetchFxData(e, fxcount),
    getJsonWithRetry<WledCfg>(e, '/json/cfg', 4),
  ]);

  if (!fx.complete) {
    log.warn(`fxdata for ${e.host} is partial`, { salvaged: fx.fxdata.filter(Boolean).length });
  }
  if (!cfg) log.warn(`/json/cfg unavailable for ${e.host}`);

  return {
    info: combined.info,
    state: combined.state,
    effects: combined.effects ?? [],
    palettes: combined.palettes ?? [],
    fxdata: fx.fxdata,
    fxdataComplete: fx.complete,
    cfg,
  };
}

/** Lightweight poll for the health loop. */
export function fetchInfo(e: WledEndpoint): Promise<WledInfo> {
  return getJson<WledInfo>(e, '/json/info');
}

export function fetchState(e: WledEndpoint): Promise<WledState> {
  return getJson<WledState>(e, '/json/state');
}

/** Discovered peers, for node import. */
export function fetchNodes(e: WledEndpoint): Promise<{ nodes?: Array<Record<string, unknown>> }> {
  return getJson(e, '/json/nodes');
}

/** POST a PARTIAL state object. Never send a full state. */
export function postState(e: WledEndpoint, patch: WledState): Promise<WledState | { success?: boolean }> {
  return postJson(e, '/json/state', patch);
}

/**
 * POST a PARTIAL `cfg` object. Verified on real hardware: WLED deep-merges, so
 * `{if:{live:{dmx:{uni:5}}}}` changes only that field.
 */
export function postCfg(e: WledEndpoint, patch: Record<string, unknown>): Promise<{ success?: boolean }> {
  return postJson(e, '/json/cfg', patch);
}

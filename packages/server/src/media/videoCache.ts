import { decodeMp4ToRgba, type DecodedVideo } from './videoTranscode.js';
import { log } from '../logger.js';

/**
 * Process-wide cache of decoded video frame buffers, keyed by asset id.
 *
 * `sceneFrameProducer` is rebuilt on **every** scene edit while live-sync is on
 * (~90 ms debounce), so decoding must not live in the producer — a keystroke in
 * the layer-name field would re-run ffmpeg. The cache makes the first use of a
 * video pay the decode cost (~1–2 s) and every rebuild after that O(1).
 *
 * Entries are never evicted: they're bounded by the number of distinct video
 * assets in play, each ≲ 120 MB (usually far less). Eviction while a scene is
 * streaming that asset would mean a re-decode mid-stream, so it's deliberately
 * omitted — if many large videos become a real workload, a frame ring buffer is
 * the fix, not LRU here.
 */
const cache = new Map<string, Promise<DecodedVideo>>();

export interface CacheableVideo {
  assetId: string;
  path: string;
  width: number;
  height: number;
}

/** Decode (or return the cached decode of) a video asset's frames. */
export function getDecodedVideo(asset: CacheableVideo): Promise<DecodedVideo> {
  let p = cache.get(asset.assetId);
  if (!p) {
    log.info(`media: decoding video ${asset.assetId} (${asset.width}×${asset.height})`);
    p = decodeMp4ToRgba(asset.path, asset.width, asset.height);
    p.then(
      (d) => log.info(`media: video ${asset.assetId} decoded — ${d.frameCount} frames`),
      (err) => {
        cache.delete(asset.assetId); // let a later use retry
        log.warn(`media: video ${asset.assetId} decode failed`, { err: String(err) });
      },
    );
    cache.set(asset.assetId, p);
  }
  return p;
}

/** Drop a cached decode (e.g. the asset was replaced or removed). */
export function forgetDecodedVideo(assetId: string): void {
  cache.delete(assetId);
}

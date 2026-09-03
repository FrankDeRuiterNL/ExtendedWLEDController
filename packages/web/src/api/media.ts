import { useMutation } from '@tanstack/react-query';
import { MEDIA_MAX_EDGE, type MediaFrame, type MediaLayerSpec } from '@ewc/core';

/**
 * Decode an image file in the browser, downscale so the long edge is ≤
 * {@link MEDIA_MAX_EDGE}, and return its RGBA pixels + the *native* size.
 */
async function decodeAndDownscale(
  file: File,
): Promise<{ rgba: Uint8Array; width: number; height: number; naturalWidth: number; naturalHeight: number }> {
  const bitmap = await createImageBitmap(file);
  const nw = bitmap.width;
  const nh = bitmap.height;
  const scale = Math.min(1, MEDIA_MAX_EDGE / Math.max(nw, nh));
  const w = Math.max(1, Math.round(nw * scale));
  const h = Math.max(1, Math.round(nh * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('canvas 2d context unavailable');
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  const { data } = ctx.getImageData(0, 0, w, h);
  // Copy into a plain ArrayBuffer-backed array so it's a valid fetch body.
  const rgba = new Uint8Array(data.length);
  rgba.set(data);
  return { rgba, width: w, height: h, naturalWidth: nw, naturalHeight: nh };
}

export interface UploadedMedia extends MediaLayerSpec {
  /** Downscaled frame size actually stored (≤ MEDIA_MAX_EDGE on the long edge). */
  storedWidth: number;
  storedHeight: number;
}

/** Upload an image file for a media layer (decoded + downscaled client-side). */
export function useUploadMedia() {
  return useMutation<UploadedMedia, Error, File>({
    mutationFn: async (file) => {
      if (!file.type.startsWith('image/')) {
        throw new Error('Only images are supported for now (video comes in a later update).');
      }
      const { rgba, width, height, naturalWidth, naturalHeight } = await decodeAndDownscale(file);
      const res = await fetch(
        `/api/media?w=${width}&h=${height}&name=${encodeURIComponent(file.name)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream' },
          body: rgba.buffer as ArrayBuffer,
        },
      );
      const text = await res.text();
      const body = text ? JSON.parse(text) : undefined;
      if (!res.ok) throw new Error(body?.error?.message ?? `upload failed (HTTP ${res.status})`);
      const m = body.media as { assetId: string; width: number; height: number; filename: string };
      return {
        assetId: m.assetId,
        filename: m.filename,
        naturalWidth,
        naturalHeight,
        storedWidth: m.width,
        storedHeight: m.height,
      };
    },
  });
}

export const mediaUrl = (assetId: string): string => `/api/media/${assetId}`;

const frameCache = new Map<string, Promise<MediaFrame>>();

/** Fetch a media asset's RGBA blob and rebuild a {@link MediaFrame}. Cached by id. */
export function loadMediaFrame(assetId: string): Promise<MediaFrame> {
  let p = frameCache.get(assetId);
  if (!p) {
    p = (async () => {
      const res = await fetch(mediaUrl(assetId));
      if (!res.ok) throw new Error(`media ${assetId}: HTTP ${res.status}`);
      const width = Number(res.headers.get('X-Media-Width'));
      const height = Number(res.headers.get('X-Media-Height'));
      const buf = new Uint8ClampedArray(await res.arrayBuffer());
      return { width, height, data: buf };
    })();
    p.catch(() => frameCache.delete(assetId)); // don't cache failures
    frameCache.set(assetId, p);
  }
  return p;
}

import { useState } from 'react';
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
  /** Stored frame size actually used server-side (downscaled). */
  storedWidth: number;
  storedHeight: number;
  /** Video only. */
  fps?: number;
  frameCount?: number;
  durationMs?: number;
  /** Video only: the source was truncated to the first N seconds on transcode. */
  maxSeconds?: number;
}

const VIDEO_EXT = /\.(mp4|mov|m4v)$/i;
export const isVideoFile = (file: File): boolean =>
  file.type.startsWith('video/') || VIDEO_EXT.test(file.name);

interface VideoUploadResponse {
  media: {
    assetId: string;
    width: number;
    height: number;
    filename: string;
    fps: number;
    frameCount: number;
    durationMs: number;
    originalWidth: number;
    originalHeight: number;
    maxSeconds: number;
  };
}

function uploadVideo(file: File, onProgress: (fraction: number) => void): Promise<UploadedMedia> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/media/video?name=${encodeURIComponent(file.name)}`);
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let body: unknown;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        body = undefined;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        const m = (body as VideoUploadResponse).media;
        resolve({
          assetId: m.assetId,
          filename: m.filename,
          kind: 'video',
          naturalWidth: m.originalWidth,
          naturalHeight: m.originalHeight,
          storedWidth: m.width,
          storedHeight: m.height,
          fps: m.fps,
          frameCount: m.frameCount,
          durationMs: m.durationMs,
          maxSeconds: m.maxSeconds,
        });
      } else {
        const err = (body as { error?: { message?: string } })?.error?.message;
        reject(new Error(err ?? `video upload failed (HTTP ${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error('video upload failed — network error'));
    xhr.send(file);
  });
}

async function uploadImage(file: File): Promise<UploadedMedia> {
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
    kind: 'image',
    naturalWidth,
    naturalHeight,
    storedWidth: m.width,
    storedHeight: m.height,
  };
}

/**
 * Upload an image (decoded + downscaled client-side) or a video (`.mp4` / `.mov`,
 * streamed to the server and transcoded there). Exposes `progress` (0..1) for the
 * video path, where uploads can be large.
 */
export function useUploadMedia() {
  const [progress, setProgress] = useState(0);
  const mutation = useMutation<UploadedMedia, Error, File>({
    mutationFn: async (file) => {
      if (isVideoFile(file)) {
        setProgress(0);
        return uploadVideo(file, setProgress);
      }
      if (!file.type.startsWith('image/')) {
        throw new Error('Unsupported file. Upload an image or an .mp4 / .mov video.');
      }
      return uploadImage(file);
    },
    onSettled: () => setProgress(0),
  });
  return { ...mutation, progress };
}

export const mediaUrl = (assetId: string): string => `/api/media/${assetId}`;

const frameCache = new Map<string, Promise<MediaFrame>>();

/** Fetch an **image** media asset's RGBA blob and rebuild a {@link MediaFrame}. Cached by id. */
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

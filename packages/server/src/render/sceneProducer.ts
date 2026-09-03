import {
  defaultMediaPlayback,
  mapInstallation,
  resolveMediaFrameIndex,
  sampleScene,
  type Installation,
  type MappedLed,
  type MediaFrame,
  type MediaLayerSpec,
  type Scene,
} from '@ewc/core';
import type { FrameProducer } from '../realtime/ddpSender.js';
import type { MediaStore } from '../media/mediaStore.js';
import { getDecodedVideo } from '../media/videoCache.js';
import { log } from '../logger.js';

/** A view of one frame of a decoded video, or a still image, keyed by layer id. */
interface VideoLayerState {
  fps: number;
  frameCount: number;
  durationMs: number;
  width: number;
  height: number;
  /**
   * The layer's media spec with a **stable** `playback` — synthesised once here
   * if the scene arrived without one (a persisted scene has it stripped), so a
   * loop clip doesn't restart from frame 0 on every provider rebuild.
   */
  spec: MediaLayerSpec;
  /** `frameCount * width * height * 4` RGBA bytes; null until the decode lands. */
  data: Uint8ClampedArray | null;
}

/**
 * Resolves the current {@link MediaFrame} for every media layer in a scene at a
 * given wall-clock time. Images are loaded once here; videos are decoded by the
 * process-wide cache ({@link getDecodedVideo}) — **not** in this function — so
 * rebuilding the producer on every scene edit stays cheap.
 */
function buildMediaProvider(scene: Scene, media: MediaStore | undefined) {
  const images = new Map<string, MediaFrame>();
  const videos = new Map<string, VideoLayerState>();

  if (media) {
    for (const layer of scene.layers) {
      if (!layer.media) continue;
      const asset = media.get(layer.media.assetId);
      if (!asset) {
        log.warn(`scene: media asset ${layer.media.assetId} for layer ${layer.id} not found`);
        continue;
      }
      if (asset.kind === 'image') {
        images.set(layer.id, {
          width: asset.width,
          height: asset.height,
          data: new Uint8ClampedArray(asset.data.buffer, asset.data.byteOffset, asset.data.length),
        });
      } else {
        const spec: MediaLayerSpec = {
          ...layer.media,
          playback: layer.media.playback ?? defaultMediaPlayback(layer.media.playbackType, Date.now()),
        };
        const st: VideoLayerState = {
          fps: asset.fps,
          frameCount: asset.frameCount,
          durationMs: asset.durationMs,
          width: asset.width,
          height: asset.height,
          spec,
          data: null,
        };
        videos.set(layer.id, st);
        getDecodedVideo({
          assetId: asset.id,
          path: media.videoPath(asset.id),
          width: asset.width,
          height: asset.height,
        })
          .then((d) => {
            st.data = d.data;
            st.frameCount = d.frameCount;
          })
          .catch(() => {
            /* videoCache already logged; the layer just stays dark */
          });
      }
    }
  }

  let cachedAtMs = Number.NaN;
  let cached: Map<string, MediaFrame> = images;

  return {
    /**
     * Frames for all media layers **now** (wall clock — video playback is
     * parametrised against `Date.now()` so preview and wire agree). Memoised
     * within a tick; the per-device producer calls in one tick see one time.
     */
    frameAt(): Map<string, MediaFrame> {
      const now = Date.now();
      if (now === cachedAtMs) return cached;
      if (videos.size === 0) {
        cachedAtMs = now;
        cached = images;
        return images;
      }
      const out = new Map(images);
      for (const [layerId, v] of videos) {
        if (!v.data || v.frameCount <= 0) continue;
        const idx = resolveMediaFrameIndex(
          v.spec,
          { fps: v.fps, frameCount: v.frameCount, durationMs: v.durationMs },
          now,
        );
        if (idx == null) continue; // hidden this instant (a stopped/ended 'hide' clip)
        const stride = v.width * v.height * 4;
        out.set(layerId, {
          width: v.width,
          height: v.height,
          data: new Uint8ClampedArray(v.data.buffer, v.data.byteOffset + idx * stride, stride),
        });
      }
      cachedAtMs = now;
      cached = out;
      return out;
    },
  };
}

/**
 * Turn a {@link Scene} + {@link Installation} into a {@link FrameProducer} for the
 * DDP sender. The mapped LED list is partitioned by device **once**, so each tick
 * evaluates `sampleScene` exactly once per LED (never per target).
 *
 * The installation is snapshotted here; media frames are resolved per tick (a
 * video layer advances over time). Call again and swap the producer
 * (`DdpSender.setProducer`) when fixtures, the scene, or a media asset change.
 */
export function sceneFrameProducer(
  scene: Scene,
  installation: Installation,
  media?: MediaStore,
): FrameProducer {
  const byDevice = new Map<number, MappedLed[]>();
  for (const led of mapInstallation(installation)) {
    let list = byDevice.get(led.deviceId);
    if (!list) {
      list = [];
      byDevice.set(led.deviceId, list);
    }
    list.push(led);
  }

  const provider = buildMediaProvider(scene, media);

  return (target, tMs) => {
    const bpl = target.format === 'rgbw' ? 4 : 3;
    const buf = new Uint8Array(Math.max(0, target.ledCount) * bpl);
    const leds = byDevice.get(target.deviceId);
    if (!leds) return buf;

    const mediaFrames = provider.frameAt();
    const t = tMs / 1000;
    for (const led of leds) {
      const o = led.index * bpl;
      if (o < 0 || o + bpl > buf.length) continue;
      const c = sampleScene(scene, led.x, led.y, t, mediaFrames);
      buf[o] = c[0];
      buf[o + 1] = c[1];
      buf[o + 2] = c[2];
      // RGBW: the white channel stays 0 (per-device white balance is applied
      // later, in the sender).
    }
    return buf;
  };
}

import {
  mapInstallation,
  sampleScene,
  type Installation,
  type MappedLed,
  type MediaFrame,
  type Scene,
} from '@ewc/core';
import type { FrameProducer } from '../realtime/ddpSender.js';
import type { MediaStore } from '../media/mediaStore.js';
import { log } from '../logger.js';

/**
 * Load the current frame for every media layer in `scene` from the store. For
 * 8a (images) this is a still frame loaded once when the producer is built; 8b
 * (video) will make this time-varying.
 */
function loadMediaFrames(scene: Scene, media: MediaStore | undefined): Map<string, MediaFrame> {
  const frames = new Map<string, MediaFrame>();
  if (!media) return frames;
  for (const layer of scene.layers) {
    if (!layer.media) continue;
    const asset = media.get(layer.media.assetId);
    if (!asset) {
      log.warn(`scene: media asset ${layer.media.assetId} for layer ${layer.id} not found`);
      continue;
    }
    frames.set(layer.id, {
      width: asset.width,
      height: asset.height,
      data: new Uint8ClampedArray(asset.data.buffer, asset.data.byteOffset, asset.data.length),
    });
  }
  return frames;
}

/**
 * Turn a {@link Scene} + {@link Installation} into a {@link FrameProducer} for the
 * DDP sender. The mapped LED list is partitioned by device **once**, so each tick
 * evaluates `sampleScene` exactly once per LED (never per target).
 *
 * The installation and any media frames are snapshotted here — call again and
 * swap the producer (`DdpSender.setProducer`) when fixtures, the scene, or a
 * media asset change so the wall follows.
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

  const mediaFrames = loadMediaFrames(scene, media);

  return (target, tMs) => {
    const bpl = target.format === 'rgbw' ? 4 : 3;
    const buf = new Uint8Array(Math.max(0, target.ledCount) * bpl);
    const leds = byDevice.get(target.deviceId);
    if (!leds) return buf;

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

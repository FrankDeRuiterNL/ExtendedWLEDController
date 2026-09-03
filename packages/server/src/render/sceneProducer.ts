import { mapInstallation, sampleScene, type Installation, type MappedLed, type Scene } from '@ewc/core';
import type { FrameProducer } from '../realtime/ddpSender.js';

/**
 * Turn a {@link Scene} + {@link Installation} into a {@link FrameProducer} for the
 * DDP sender. The mapped LED list is partitioned by device **once**, so each tick
 * evaluates `sampleScene` exactly once per LED (never per target).
 *
 * The installation is snapshotted here — call again and swap the producer
 * (`DdpSender.setProducer`) when fixtures change so the wall follows the layout.
 */
export function sceneFrameProducer(scene: Scene, installation: Installation): FrameProducer {
  const byDevice = new Map<number, MappedLed[]>();
  for (const led of mapInstallation(installation)) {
    let list = byDevice.get(led.deviceId);
    if (!list) {
      list = [];
      byDevice.set(led.deviceId, list);
    }
    list.push(led);
  }

  return (target, tMs) => {
    const bpl = target.format === 'rgbw' ? 4 : 3;
    const buf = new Uint8Array(Math.max(0, target.ledCount) * bpl);
    const leds = byDevice.get(target.deviceId);
    if (!leds) return buf;

    const t = tMs / 1000;
    for (const led of leds) {
      const o = led.index * bpl;
      if (o < 0 || o + bpl > buf.length) continue;
      const c = sampleScene(scene, led.x, led.y, t);
      buf[o] = c[0];
      buf[o + 1] = c[1];
      buf[o + 2] = c[2];
      // RGBW: effects are RGB only; the white channel stays 0 (per-device white
      // balance for RGB strips is a milestone-7 concern).
    }
    return buf;
  };
}

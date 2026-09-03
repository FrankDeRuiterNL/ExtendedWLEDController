import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeMediaLayer, type Installation, type Scene } from '@ewc/core';
import { MediaStore } from '../media/mediaStore.js';
import type { DdpTarget } from '../realtime/ddpSender.js';
import { sceneFrameProducer } from './sceneProducer.js';

const target = (over: Partial<DdpTarget>): DdpTarget =>
  ({
    deviceId: 1,
    host: '127.0.0.1',
    ddpPort: 4048,
    ledCount: 4,
    format: 'rgb',
    pixelOffset: 0,
    transport: 'ddp',
    maxFps: null,
    gain: null,
    ...over,
  }) as DdpTarget;

describe('sceneFrameProducer — media layers', () => {
  let dir: string;
  let media: MediaStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ewc-sp-'));
    media = new MediaStore(join(dir, 'media'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('maps media pixels onto the fixture LEDs on the wire', () => {
    // 2×1 image: left red, right green
    const asset = media.create(
      Buffer.from([255, 0, 0, 255, 0, 255, 0, 255]),
      { width: 2, height: 1, filename: 'lr.png' },
    );

    // A 4-LED strip spanning the full canvas width at mid-height.
    const installation: Installation = {
      canvas: { width: 10, height: 10 },
      fixtures: [
        {
          id: 'f',
          deviceId: 1,
          name: 's',
          startIndex: 0,
          geometry: { kind: 'strip', count: 4 },
          transform: { position: { x: 5, y: 5 }, rotationDeg: 0, size: { x: 10, y: 1 } },
          enabled: true,
        },
      ],
    };

    const scene: Scene = {
      name: 't',
      background: [0, 0, 0],
      layers: [
        {
          ...makeMediaLayer('m'),
          media: { assetId: asset.id, filename: 'lr.png', naturalWidth: 2, naturalHeight: 1 },
        },
      ],
    };

    const produce = sceneFrameProducer(scene, installation, media);
    const buf = produce(target({ ledCount: 4 }), 0);

    // 4 LEDs across the width → first two sample the left (red) half, last two the right (green).
    expect([...buf.subarray(0, 3)]).toEqual([255, 0, 0]);
    expect([...buf.subarray(3, 6)]).toEqual([255, 0, 0]);
    expect([...buf.subarray(6, 9)]).toEqual([0, 255, 0]);
    expect([...buf.subarray(9, 12)]).toEqual([0, 255, 0]);
  });

  it('leaves LEDs black when the media asset is missing', () => {
    const installation: Installation = {
      canvas: { width: 10, height: 10 },
      fixtures: [
        {
          id: 'f',
          deviceId: 1,
          name: 's',
          startIndex: 0,
          geometry: { kind: 'strip', count: 2 },
          transform: { position: { x: 5, y: 5 }, rotationDeg: 0, size: { x: 10, y: 1 } },
          enabled: true,
        },
      ],
    };
    const scene: Scene = {
      name: 't',
      background: [0, 0, 0],
      layers: [
        { ...makeMediaLayer('m'), media: { assetId: 'gone', filename: 'x', naturalWidth: 1, naturalHeight: 1 } },
      ],
    };
    const buf = sceneFrameProducer(scene, installation, media)(target({ ledCount: 2 }), 0);
    expect([...buf]).toEqual([0, 0, 0, 0, 0, 0]);
  });
});

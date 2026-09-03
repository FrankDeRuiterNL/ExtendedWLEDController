import dgram from 'node:dgram';
import { afterEach, describe, expect, it } from 'vitest';
import { DDP_FLAGS_VER1, DNRGB_PROTOCOL, LEGACY_UDP_PORT } from '@ewc/core';
import { DdpSender, solidFrameProducer, type DdpTarget } from './ddpSender.js';

/** Bind a UDP receiver on 127.0.0.1 and collect datagrams. */
async function receiver(port: number): Promise<{ packets: Buffer[]; close: () => void }> {
  const sock = dgram.createSocket('udp4');
  const packets: Buffer[] = [];
  sock.on('message', (msg) => packets.push(Buffer.from(msg)));
  await new Promise<void>((resolve, reject) => {
    sock.once('error', reject);
    sock.bind(port, '127.0.0.1', resolve);
  });
  return { packets, close: () => sock.close() };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function target(over: Partial<DdpTarget>): DdpTarget {
  return {
    deviceId: 1,
    host: '127.0.0.1',
    ddpPort: 14048,
    ledCount: 12,
    format: 'rgb',
    pixelOffset: 0,
    transport: 'ddp',
    maxFps: null,
    gain: null,
    ...over,
  };
}

describe('DdpSender transport routing', () => {
  let sender: DdpSender | undefined;
  afterEach(async () => {
    await sender?.stop();
    sender?.close();
    sender = undefined;
  });

  it('sends DDP packets to the DDP port', async () => {
    const rx = await receiver(14048);
    sender = new DdpSender({ fps: 40 });
    sender.start([target({ ddpPort: 14048 })], solidFrameProducer([10, 20, 30]));
    await wait(150);
    rx.close();

    expect(rx.packets.length).toBeGreaterThan(0);
    // DDP: byte 0 has the version-1 flag; RGB payload of 12 LEDs.
    expect(rx.packets[0]![0]! & DDP_FLAGS_VER1).toBe(DDP_FLAGS_VER1);
    expect(rx.packets[0]!.length).toBe(10 + 12 * 3);
  });

  it('routes a dnrgb target to the legacy UDP port with a DNRGB header', async () => {
    const rx = await receiver(LEGACY_UDP_PORT);
    sender = new DdpSender({ fps: 40 });
    sender.start([target({ transport: 'dnrgb' })], solidFrameProducer([1, 2, 3]));
    await wait(150);
    rx.close();

    expect(rx.packets.length).toBeGreaterThan(0);
    expect(rx.packets[0]![0]).toBe(DNRGB_PROTOCOL); // byte 0 = 4
    expect(rx.packets[0]![2]).toBe(0); // start index hi
    expect(rx.packets[0]![3]).toBe(0); // start index lo
    expect(rx.packets[0]!.length).toBe(4 + 12 * 3);
  });

  it('applies a per-device RGB gain to the frame', async () => {
    const rx = await receiver(14050);
    sender = new DdpSender({ fps: 40 });
    // gain halves green, quarters blue, leaves red
    sender.start(
      [target({ ddpPort: 14050, ledCount: 2, gain: [1, 0.5, 0.25] })],
      solidFrameProducer([200, 200, 200]),
    );
    await wait(120);
    rx.close();

    const body = rx.packets[0]!.subarray(10); // strip the 10-byte DDP header
    expect([...body.subarray(0, 3)]).toEqual([200, 100, 50]);
    expect([...body.subarray(3, 6)]).toEqual([200, 100, 50]);
  });

  it('honours a per-device fps cap (roughly)', async () => {
    const rx = await receiver(14049);
    sender = new DdpSender({ fps: 40 });
    sender.start([target({ ddpPort: 14049, maxFps: 10 })], solidFrameProducer([0, 0, 0]));
    await wait(1000);
    rx.close();

    // 40 fps uncapped ≈ 40 packets in a second; capped at 10 it must be well under.
    expect(rx.packets.length).toBeGreaterThanOrEqual(6);
    expect(rx.packets.length).toBeLessThanOrEqual(16);

    const st = sender.getStats()[0]!;
    expect(st.framesDropped).toBe(0); // paced skips are not drops
  });
});

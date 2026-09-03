import { describe, expect, it } from 'vitest';
import {
  DDP_HEADER_LEN,
  DDP_TYPE_RGB24,
  DDP_TYPE_RGBW32,
  buildDdpFrame,
  buildDdpPacket,
  nextDdpSequence,
  packPixels,
  parseDdpPacket,
} from './packet.js';

const u32be = (b: Uint8Array, o: number) => (b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!;
const u16be = (b: Uint8Array, o: number) => (b[o]! << 8) | b[o + 1]!;

describe('buildDdpPacket — the byte-layout contract', () => {
  const data = new Uint8Array([255, 0, 0, 0, 255, 0]); // 2 RGB pixels
  const p = buildDdpPacket({ sequence: 5, channelOffsetBytes: 900, data, format: 'rgb', push: true });

  it('byte 0: flags = VER1 (0x40) | PUSH (0x01) on the final packet', () => {
    expect(p[0]).toBe(0x41);
  });
  it('byte 0: PUSH clear on a non-final packet, VER1 still set', () => {
    expect(buildDdpPacket({ sequence: 5, channelOffsetBytes: 0, data, format: 'rgb', push: false })[0]).toBe(0x40);
  });
  it('byte 0: DDP_FLAGS_TIME (0x10) is never set', () => {
    expect(p[0]! & 0x10).toBe(0);
  });
  it('byte 1: sequence number in the low nibble', () => {
    expect(p[1]).toBe(5);
    expect(buildDdpPacket({ sequence: 0x2f, channelOffsetBytes: 0, data, format: 'rgb', push: true })[1]).toBe(0x0f);
  });
  it('byte 2: data type 0x0B for RGB24, 0x1B for RGBW32', () => {
    expect(p[2]).toBe(DDP_TYPE_RGB24);
    expect(buildDdpPacket({ sequence: 1, channelOffsetBytes: 0, data: new Uint8Array(4), format: 'rgbw', push: true })[2]).toBe(
      DDP_TYPE_RGBW32,
    );
  });
  it('byte 3: destination id defaults to 1 (DISPLAY)', () => {
    expect(p[3]).toBe(1);
    expect(buildDdpPacket({ sequence: 1, channelOffsetBytes: 0, data, format: 'rgb', push: true, destinationId: 2 })[3]).toBe(2);
  });
  it('bytes 4–7: channel offset, big-endian uint32, in BYTES', () => {
    expect(u32be(p, 4)).toBe(900);
    const big = buildDdpPacket({ sequence: 1, channelOffsetBytes: 0x01020304, data, format: 'rgb', push: true });
    expect([big[4], big[5], big[6], big[7]]).toEqual([0x01, 0x02, 0x03, 0x04]);
  });
  it('bytes 8–9: data length, big-endian uint16, in BYTES', () => {
    expect(u16be(p, 8)).toBe(6);
  });
  it('bytes 10+: the pixel data verbatim', () => {
    expect([...p.slice(DDP_HEADER_LEN)]).toEqual([255, 0, 0, 0, 255, 0]);
  });
  it('total length = header + data', () => {
    expect(p.length).toBe(DDP_HEADER_LEN + 6);
  });
  it('rejects an out-of-range channel offset and oversized data', () => {
    expect(() => buildDdpPacket({ sequence: 1, channelOffsetBytes: -1, data, format: 'rgb', push: true })).toThrow();
    expect(() =>
      buildDdpPacket({ sequence: 1, channelOffsetBytes: 0, data: new Uint8Array(0x10000), format: 'rgb', push: true }),
    ).toThrow();
  });
});

describe('buildDdpFrame — packetisation', () => {
  it('a small frame is a single PUSH packet at offset 0', () => {
    const frame = buildDdpFrame({ data: new Uint8Array(30), format: 'rgb', sequence: 3 });
    expect(frame).toHaveLength(1);
    expect(frame[0]![0]).toBe(0x41);
    expect(u32be(frame[0]!, 4)).toBe(0);
  });

  it('splits a large strip into MTU packets: one sequence, ascending offsets, PUSH on last only', () => {
    // 1000 RGB LEDs = 3000 bytes; default 1440 → 480 LEDs (1440 B) per packet.
    const data = new Uint8Array(3000);
    const frame = buildDdpFrame({ data, format: 'rgb', sequence: 7 });
    expect(frame).toHaveLength(3); // 1440 + 1440 + 120

    frame.forEach((pkt, i) => {
      expect(pkt[1]).toBe(7); // shared sequence
      const isLast = i === frame.length - 1;
      expect(pkt[0]! & 0x01).toBe(isLast ? 1 : 0); // PUSH only on last
    });
    expect(u32be(frame[0]!, 4)).toBe(0);
    expect(u32be(frame[1]!, 4)).toBe(1440);
    expect(u32be(frame[2]!, 4)).toBe(2880);
    expect(u16be(frame[2]!, 8)).toBe(120);
  });

  it('never splits a pixel across packets (chunk floored to whole LEDs)', () => {
    // maxDataBytes 1000, RGBW (4 B/LED) → floor(1000/4)*4 = 1000, still whole.
    const data = new Uint8Array(4 * 300); // 300 RGBW LEDs = 1200 B
    const frame = buildDdpFrame({ data, format: 'rgbw', sequence: 1, maxDataBytes: 1000 });
    for (const pkt of frame) {
      expect((pkt.length - DDP_HEADER_LEN) % 4).toBe(0);
    }
  });

  it('honours startChannelBytes (device buffer offset / addr compensation)', () => {
    const frame = buildDdpFrame({ data: new Uint8Array(3000), format: 'rgb', sequence: 1, startChannelBytes: 300 });
    expect(u32be(frame[0]!, 4)).toBe(300);
    expect(u32be(frame[1]!, 4)).toBe(300 + 1440);
  });

  it('empty frame → no packets', () => {
    expect(buildDdpFrame({ data: new Uint8Array(0), format: 'rgb', sequence: 1 })).toEqual([]);
  });
});

describe('nextDdpSequence', () => {
  it('cycles 1→15→1 and never yields 0', () => {
    const seen: number[] = [];
    let s = 1;
    for (let i = 0; i < 20; i++) {
      seen.push(s);
      s = nextDdpSequence(s);
    }
    expect(seen.slice(0, 16)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 1]);
    expect(seen).not.toContain(0);
  });
});

describe('parseDdpPacket — round-trips the builder', () => {
  it('reads back every header field', () => {
    const data = packPixels([[10, 20, 30], [40, 50, 60]], 'rgb');
    const raw = buildDdpPacket({ sequence: 9, channelOffsetBytes: 4242, data, format: 'rgb', push: true });
    const p = parseDdpPacket(raw);
    expect(p).toMatchObject({
      version: 1,
      push: true,
      timecode: false,
      sequence: 9,
      format: 'rgb',
      destinationId: 1,
      channelOffsetBytes: 4242,
      dataLengthBytes: 6,
      valid: true,
    });
    expect([...p.data]).toEqual([10, 20, 30, 40, 50, 60]);
  });

  it('flags a datagram shorter than its declared length as invalid', () => {
    const raw = buildDdpPacket({ sequence: 1, channelOffsetBytes: 0, data: new Uint8Array(30), format: 'rgb', push: true });
    expect(parseDdpPacket(raw.subarray(0, 25)).valid).toBe(false);
  });

  it('a runt (< header) is invalid, not a throw', () => {
    expect(parseDdpPacket(new Uint8Array(4)).valid).toBe(false);
  });

  it('identifies RGBW packets', () => {
    const raw = buildDdpPacket({ sequence: 1, channelOffsetBytes: 0, data: new Uint8Array(8), format: 'rgbw', push: false });
    expect(parseDdpPacket(raw).format).toBe('rgbw');
  });
});

describe('packPixels', () => {
  it('packs RGB tuples and clamps out-of-range channels', () => {
    expect([...packPixels([[300, -5, 128]], 'rgb')]).toEqual([255, 0, 128]);
  });
  it('packs RGBW with a defaulted white channel', () => {
    expect([...packPixels([[10, 20, 30]], 'rgbw')]).toEqual([10, 20, 30, 0]);
  });
});

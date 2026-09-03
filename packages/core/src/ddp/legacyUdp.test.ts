import { describe, expect, it } from 'vitest';
import {
  DNRGB_HEADER_LEN,
  DNRGB_MAX_LEDS_PER_PACKET,
  DNRGB_PROTOCOL,
  DNRGB_TIMEOUT_SEC,
  buildDnrgbFrame,
} from './legacyUdp.js';

/** n LEDs of packed RGB, channel value = its global byte position (mod 256). */
function ramp(leds: number): Uint8Array {
  const d = new Uint8Array(leds * 3);
  for (let i = 0; i < d.length; i++) d[i] = i & 0xff;
  return d;
}

describe('buildDnrgbFrame', () => {
  it('builds a single packet with the documented 4-byte header', () => {
    const [pkt, ...rest] = buildDnrgbFrame({ data: new Uint8Array([10, 20, 30, 40, 50, 60]) });
    expect(rest).toHaveLength(0);
    expect(pkt![0]).toBe(DNRGB_PROTOCOL); // byte 0 = 4
    expect(pkt![1]).toBe(DNRGB_TIMEOUT_SEC); // byte 1 = timeout secs
    expect(pkt![2]).toBe(0); // start index hi
    expect(pkt![3]).toBe(0); // start index lo
    expect([...pkt!.subarray(DNRGB_HEADER_LEN)]).toEqual([10, 20, 30, 40, 50, 60]);
  });

  it('writes the start index big-endian, in LEDs not bytes', () => {
    const [pkt] = buildDnrgbFrame({ data: new Uint8Array([1, 2, 3]), startIndex: 0x0102 });
    expect(pkt![2]).toBe(0x01);
    expect(pkt![3]).toBe(0x02);
  });

  it('clamps the timeout byte and honours a custom value', () => {
    expect(buildDnrgbFrame({ data: new Uint8Array([0, 0, 0]), timeoutSec: 5 })[0]![1]).toBe(5);
    expect(buildDnrgbFrame({ data: new Uint8Array([0, 0, 0]), timeoutSec: 999 })[0]![1]).toBe(255);
  });

  it('chunks at 489 LEDs and advances the start index per packet', () => {
    const leds = DNRGB_MAX_LEDS_PER_PACKET + 11;
    const packets = buildDnrgbFrame({ data: ramp(leds), startIndex: 5 });
    expect(packets).toHaveLength(2);

    expect((packets[0]!.length - DNRGB_HEADER_LEN) / 3).toBe(DNRGB_MAX_LEDS_PER_PACKET);
    expect((packets[0]![2]! << 8) | packets[0]![3]!).toBe(5);

    expect((packets[1]!.length - DNRGB_HEADER_LEN) / 3).toBe(11);
    expect((packets[1]![2]! << 8) | packets[1]![3]!).toBe(5 + DNRGB_MAX_LEDS_PER_PACKET);
  });

  it('preserves pixel bytes across the packet boundary', () => {
    const leds = DNRGB_MAX_LEDS_PER_PACKET + 4;
    const data = ramp(leds);
    const [a, b] = buildDnrgbFrame({ data });
    const rejoined = new Uint8Array(leds * 3);
    rejoined.set(a!.subarray(DNRGB_HEADER_LEN), 0);
    rejoined.set(b!.subarray(DNRGB_HEADER_LEN), DNRGB_MAX_LEDS_PER_PACKET * 3);
    expect(rejoined).toEqual(data);
  });

  it('rejects a data length that is not a multiple of 3', () => {
    expect(() => buildDnrgbFrame({ data: new Uint8Array([1, 2, 3, 4]) })).toThrow(/multiple of 3/);
  });

  it('returns nothing for an empty frame', () => {
    expect(buildDnrgbFrame({ data: new Uint8Array(0) })).toEqual([]);
  });

  it('stops emitting once the LED index would exceed 16 bits', () => {
    // start near the ceiling: only the first packet's worth fits under 65535
    const packets = buildDnrgbFrame({ data: ramp(DNRGB_MAX_LEDS_PER_PACKET * 2), startIndex: 65200 });
    expect(packets).toHaveLength(1);
    expect((packets[0]![2]! << 8) | packets[0]![3]!).toBe(65200);
  });
});

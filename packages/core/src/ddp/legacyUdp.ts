/**
 * Legacy WLED realtime UDP — **fallback only**, never the default transport.
 *
 * WLED listens on UDP **21324** for a handful of raw realtime protocols. Byte 0
 * selects the protocol; byte 1 is the timeout in seconds before the device drops
 * realtime and returns to its normal mode (`0` also means "use the default").
 *
 * | Byte 0 | Protocol | Layout                                    | Max LEDs |
 * |--------|----------|-------------------------------------------|----------|
 * | 1      | WARLS    | index, R, G, B per LED                    | 255      |
 * | 2      | DRGB     | R, G, B sequential from 0                 | 490      |
 * | 3      | DRGBW    | R, G, B, W sequential from 0              | 367      |
 * | 4      | DNRGB    | 2-byte BE start index, then R, G, B       | 489/pkt  |
 *
 * We implement **DNRGB** only: it is the one that both starts at an arbitrary
 * index and chunks cleanly across packets, so it behaves like DDP minus the
 * addressing header. This is a per-device escape hatch for firmwares/networks
 * where DDP misbehaves — see the build spec, "Legacy realtime UDP — fallback
 * only".
 */

/** WLED's fixed listen port for the legacy realtime UDP protocols. */
export const LEGACY_UDP_PORT = 21324;

/** Byte-0 protocol selector for DNRGB. */
export const DNRGB_PROTOCOL = 4;

/** 4-byte DNRGB header, then RGB triples. WLED caps the payload at 489 LEDs. */
export const DNRGB_HEADER_LEN = 4;
export const DNRGB_MAX_LEDS_PER_PACKET = 489;

/**
 * A short realtime timeout (seconds) written into byte 1. Frames flow at the
 * stream fps, so this only matters when they *stop* — a small value means the
 * strip self-heals back to its preset within a couple of seconds even if the
 * explicit `{live:false}` release is lost, instead of freezing on the last
 * frame. Mirrors WLED's own ~2.5 s DDP realtime timeout.
 */
export const DNRGB_TIMEOUT_SEC = 2;

export interface DnrgbFrameOptions {
  /** The whole frame as packed **RGB** bytes (length a multiple of 3). */
  data: Uint8Array;
  /** LED index the first pixel of `data` addresses. Default 0. */
  startIndex?: number;
  /** Byte-1 timeout in seconds (0–255). Default {@link DNRGB_TIMEOUT_SEC}. */
  timeoutSec?: number;
  /** LEDs per datagram; capped at {@link DNRGB_MAX_LEDS_PER_PACKET}. */
  maxLedsPerPacket?: number;
}

/**
 * Split one RGB frame into DNRGB datagrams: each carries `[4, timeout, idxHi,
 * idxLo, r,g,b, …]` with an ascending big-endian LED start index. Unlike DDP the
 * index is in **LEDs, not bytes**, and there is no PUSH flag — WLED renders each
 * DNRGB packet as it arrives.
 */
export function buildDnrgbFrame(opts: DnrgbFrameOptions): Uint8Array[] {
  const { data } = opts;
  if (data.length % 3 !== 0) {
    throw new RangeError(`DNRGB frame data length ${data.length} is not a multiple of 3 (RGB)`);
  }
  const startIndex = opts.startIndex ?? 0;
  if (startIndex < 0 || startIndex > 0xffff) {
    throw new RangeError(`DNRGB start index out of range: ${startIndex}`);
  }
  const timeout = clampByte(opts.timeoutSec ?? DNRGB_TIMEOUT_SEC);
  const perPacket = Math.max(
    1,
    Math.min(opts.maxLedsPerPacket ?? DNRGB_MAX_LEDS_PER_PACKET, DNRGB_MAX_LEDS_PER_PACKET),
  );

  const totalLeds = data.length / 3;
  if (totalLeds === 0) return [];

  const packets: Uint8Array[] = [];
  for (let led = 0; led < totalLeds; led += perPacket) {
    const count = Math.min(perPacket, totalLeds - led);
    const idx = startIndex + led;
    if (idx > 0xffff) break; // can't address past 65535 with a 16-bit index
    const packet = new Uint8Array(DNRGB_HEADER_LEN + count * 3);
    packet[0] = DNRGB_PROTOCOL;
    packet[1] = timeout;
    packet[2] = (idx >> 8) & 0xff;
    packet[3] = idx & 0xff;
    packet.set(data.subarray(led * 3, (led + count) * 3), DNRGB_HEADER_LEN);
    packets.push(packet);
  }
  return packets;
}

function clampByte(n: number): number {
  return n < 0 ? 0 : n > 255 ? 255 : Math.round(n);
}

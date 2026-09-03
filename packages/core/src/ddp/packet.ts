/**
 * DDP (Distributed Display Protocol) packet builder.
 *
 * WLED listens for DDP on UDP **4048** unconditionally — no device config or
 * reboot needed. This module is the wire contract; the byte layout below is
 * copied verbatim from the build spec and is covered field-by-field by
 * `packet.test.ts`.
 *
 * 10-byte header, then pixel data:
 *
 * | Offset | Size | Content                                            |
 * |--------|------|----------------------------------------------------|
 * | 0      | 1    | flags                                              |
 * | 1      | 1    | sequence number, lower 4 bits                      |
 * | 2      | 1    | data type                                          |
 * | 3      | 1    | destination id                                     |
 * | 4–7    | 4    | channel offset, **big-endian uint32, in BYTES**    |
 * | 8–9    | 2    | data length, **big-endian uint16, in BYTES**       |
 * | 10+    | n    | pixel data                                         |
 *
 * Rules, all verified against `handleDDPPacket()`:
 * - `DDP_FLAGS_VER1` (0x40) is always set. `DDP_FLAGS_PUSH` (0x01) means "render
 *   now" and is set **only on the last packet of a frame**, so the frame renders
 *   atomically. `DDP_FLAGS_TIME` (0x10) is never set — WLED ignores timecodes.
 * - One sequence number **per frame**, shared by every packet of that frame,
 *   cycling 1→15→1. Sequence `0` disables WLED's out-of-order filter entirely.
 * - The device adds its configured E1.31 start address to the computed pixel
 *   index (see `@ewc/core` DMX planner) — the sender compensates.
 * - The handler rejects a packet shorter than `header + dataLen` silently.
 */

export const DDP_FLAGS_VER1 = 0x40;
export const DDP_FLAGS_PUSH = 0x01;
export const DDP_FLAGS_TIME = 0x10; // never use

export const DDP_TYPE_RGB24 = 0x0b;
export const DDP_TYPE_RGBW32 = 0x1b;

export const DDP_ID_DISPLAY = 1;

export const DDP_HEADER_LEN = 10;

/** A good default UDP payload — divisible by both 3 and 4 (480 RGB / 360 RGBW). */
export const DDP_MAX_DATA_BYTES = 1440;

export type PixelFormat = 'rgb' | 'rgbw';

export interface DdpPacketOptions {
  /** Sequence number for the frame (0–15; 0 disables ordering checks). */
  sequence: number;
  /** Byte offset of this packet's first channel into the device LED buffer. */
  channelOffsetBytes: number;
  /** Pixel bytes for this packet only. */
  data: Uint8Array;
  format: PixelFormat;
  /** Set PUSH — true only for the final packet of a frame. */
  push: boolean;
  destinationId?: number;
}

/** Build one DDP packet. Prefer {@link buildDdpFrame} for a whole frame. */
export function buildDdpPacket(opts: DdpPacketOptions): Uint8Array {
  const { sequence, channelOffsetBytes, data, format, push } = opts;
  if (channelOffsetBytes < 0 || channelOffsetBytes > 0xffffffff) {
    throw new RangeError(`channelOffsetBytes out of range: ${channelOffsetBytes}`);
  }
  if (data.length > 0xffff) {
    throw new RangeError(`DDP packet data length ${data.length} exceeds uint16`);
  }

  const packet = new Uint8Array(DDP_HEADER_LEN + data.length);
  const view = new DataView(packet.buffer);

  packet[0] = DDP_FLAGS_VER1 | (push ? DDP_FLAGS_PUSH : 0);
  packet[1] = sequence & 0x0f;
  packet[2] = format === 'rgbw' ? DDP_TYPE_RGBW32 : DDP_TYPE_RGB24;
  packet[3] = opts.destinationId ?? DDP_ID_DISPLAY;
  view.setUint32(4, channelOffsetBytes, false); // big-endian
  view.setUint16(8, data.length, false); // big-endian
  packet.set(data, DDP_HEADER_LEN);

  return packet;
}

export interface DdpFrameOptions {
  /** The complete frame: pixel bytes for every LED, in wire order. */
  data: Uint8Array;
  format: PixelFormat;
  /** Frame sequence number, 0–15 (0 disables WLED's ordering filter). */
  sequence: number;
  /**
   * Byte offset of the first LED into the device buffer. Usually 0; set when a
   * device's pixels don't start at index 0 or to compensate for a non-default
   * E1.31 start address.
   */
  startChannelBytes?: number;
  /** Max pixel bytes per datagram; floored to a whole number of LEDs. */
  maxDataBytes?: number;
  destinationId?: number;
}

/**
 * Split a full frame into MTU-sized DDP packets: one shared sequence number,
 * ascending channel offsets, PUSH on the last packet only.
 */
export function buildDdpFrame(opts: DdpFrameOptions): Uint8Array[] {
  const { data, format, sequence } = opts;
  const bytesPerLed = format === 'rgbw' ? 4 : 3;
  const start = opts.startChannelBytes ?? 0;

  const maxData = opts.maxDataBytes ?? DDP_MAX_DATA_BYTES;
  const chunk = Math.max(bytesPerLed, Math.floor(maxData / bytesPerLed) * bytesPerLed);

  if (data.length === 0) return [];

  const packets: Uint8Array[] = [];
  for (let pos = 0; pos < data.length; pos += chunk) {
    const slice = data.subarray(pos, Math.min(pos + chunk, data.length));
    const isLast = pos + chunk >= data.length;
    packets.push(
      buildDdpPacket({
        sequence,
        channelOffsetBytes: start + pos,
        data: slice,
        format,
        push: isLast,
        ...(opts.destinationId !== undefined ? { destinationId: opts.destinationId } : {}),
      }),
    );
  }
  return packets;
}

/** Advance a frame sequence number, cycling 1→15→1 (never returns 0). */
export function nextDdpSequence(seq: number): number {
  const n = (seq % 15) + 1;
  return n;
}

// --- pixel buffer helpers ------------------------------------------------

/** Pack an array of `[r,g,b]` (or `[r,g,b,w]`) tuples into a wire byte buffer. */
export function packPixels(
  pixels: ReadonlyArray<readonly number[]>,
  format: PixelFormat,
): Uint8Array {
  const bpl = format === 'rgbw' ? 4 : 3;
  const out = new Uint8Array(pixels.length * bpl);
  for (let i = 0; i < pixels.length; i++) {
    const p = pixels[i]!;
    out[i * bpl] = clamp8(p[0]);
    out[i * bpl + 1] = clamp8(p[1]);
    out[i * bpl + 2] = clamp8(p[2]);
    if (bpl === 4) out[i * bpl + 3] = clamp8(p[3] ?? 0);
  }
  return out;
}

function clamp8(n: number | undefined): number {
  if (n === undefined || Number.isNaN(n)) return 0;
  return n < 0 ? 0 : n > 255 ? 255 : Math.round(n);
}

// --- parsing (for the software sink / tests) ---------------------------

export interface ParsedDdpPacket {
  version: number;
  push: boolean;
  timecode: boolean;
  storage: boolean;
  reply: boolean;
  query: boolean;
  sequence: number;
  dataType: number;
  format: PixelFormat | 'unknown';
  destinationId: number;
  /** Channel offset in BYTES. */
  channelOffsetBytes: number;
  /** Declared data length in BYTES. */
  dataLengthBytes: number;
  /** The pixel bytes (exactly `dataLengthBytes`, or fewer if the packet was short). */
  data: Uint8Array;
  /** True when the datagram is at least `header + dataLength` — WLED drops shorter. */
  valid: boolean;
}

/** Parse a raw DDP datagram. Mirrors what `handleDDPPacket()` reads. */
export function parseDdpPacket(buf: Uint8Array): ParsedDdpPacket {
  if (buf.length < DDP_HEADER_LEN) {
    return {
      version: 0, push: false, timecode: false, storage: false, reply: false, query: false,
      sequence: 0, dataType: 0, format: 'unknown', destinationId: 0,
      channelOffsetBytes: 0, dataLengthBytes: 0, data: new Uint8Array(0), valid: false,
    };
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const flags = buf[0]!;
  const dataType = buf[2]!;
  const dataLengthBytes = view.getUint16(8, false);
  const bodyAvailable = buf.length - DDP_HEADER_LEN;

  return {
    version: (flags & 0xc0) >> 6,
    push: (flags & DDP_FLAGS_PUSH) !== 0,
    timecode: (flags & DDP_FLAGS_TIME) !== 0,
    storage: (flags & 0x08) !== 0,
    reply: (flags & 0x04) !== 0,
    query: (flags & 0x02) !== 0,
    sequence: buf[1]! & 0x0f,
    dataType,
    format: dataType === DDP_TYPE_RGBW32 ? 'rgbw' : dataType === DDP_TYPE_RGB24 ? 'rgb' : 'unknown',
    destinationId: buf[3]!,
    channelOffsetBytes: view.getUint32(4, false),
    dataLengthBytes,
    data: buf.subarray(DDP_HEADER_LEN, DDP_HEADER_LEN + Math.min(dataLengthBytes, bodyAvailable)),
    valid: bodyAvailable >= dataLengthBytes,
  };
}

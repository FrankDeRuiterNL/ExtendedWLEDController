import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import { DDP_PORT, parseDdpPacket } from '@ewc/core';

export interface DdpStats {
  packets: number;
  frames: number;
  bytes: number;
  outOfOrder: number;
  invalid: number;
  wrongDest: number;
  fps: number;
  lastFrameAt: number;
}

type Events = { frame: [Uint8Array]; stats: [DdpStats] };

/**
 * Binds UDP 4048, reassembles DDP frames into a pixel buffer, and tracks the
 * stats that catch header / endianness / offset / sequencing bugs.
 */
export class DdpReceiver extends EventEmitter<Events> {
  private sock: dgram.Socket | null = null;
  /** RGB(W) bytes of the most recently PUSHed frame. */
  buffer: Uint8Array;
  /** Work-in-progress frame being assembled. */
  private wip: Uint8Array;
  private curSeq = -1;
  private lastPushedSeq = -1;
  private frameTimestamps: number[] = [];

  readonly stats: DdpStats = {
    packets: 0, frames: 0, bytes: 0, outOfOrder: 0, invalid: 0, wrongDest: 0, fps: 0, lastFrameAt: 0,
  };

  constructor(
    private readonly byteLen: number,
    private readonly port = DDP_PORT,
  ) {
    super();
    this.buffer = new Uint8Array(byteLen);
    this.wip = new Uint8Array(byteLen);
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      sock.on('error', reject);
      sock.on('message', (msg) => this.onPacket(msg));
      sock.bind(this.port, () => {
        this.sock = sock;
        resolve();
      });
    });
  }

  stop(): void {
    this.sock?.close();
    this.sock = null;
  }

  private onPacket(msg: Buffer): void {
    this.stats.packets++;
    this.stats.bytes += msg.length;
    const p = parseDdpPacket(msg);

    if (!p.valid) {
      this.stats.invalid++;
      return;
    }
    if (p.destinationId !== 1) {
      this.stats.wrongDest++;
      return;
    }

    // New frame? WLED compares against the last *pushed* sequence. seq 0 = unchecked.
    if (p.sequence !== 0 && p.sequence !== this.curSeq) {
      if (this.curSeq !== -1 && !this.isNewer(p.sequence, this.lastPushedSeq)) {
        this.stats.outOfOrder++;
      }
      this.curSeq = p.sequence;
      this.wip = this.buffer.slice(); // start from the last rendered frame
    }

    const start = p.channelOffsetBytes;
    const end = Math.min(start + p.data.length, this.wip.length);
    if (start < this.wip.length) this.wip.set(p.data.subarray(0, end - start), start);

    if (p.push) {
      this.buffer = this.wip.slice();
      this.lastPushedSeq = p.sequence;
      this.stats.frames++;
      this.stats.lastFrameAt = Date.now();
      this.tickFps();
      this.emit('frame', this.buffer);
    }
    this.emit('stats', this.stats);
  }

  /** Is `seq` newer than `ref` in WLED's ~4-packets-per-frame window (mod 16)? */
  private isNewer(seq: number, ref: number): boolean {
    if (ref === -1) return true;
    const d = (seq - ref + 16) % 16;
    return d >= 1 && d <= 8;
  }

  private tickFps(): void {
    const now = Date.now();
    this.frameTimestamps.push(now);
    while (this.frameTimestamps.length && now - this.frameTimestamps[0]! > 1000) {
      this.frameTimestamps.shift();
    }
    this.stats.fps = this.frameTimestamps.length;
  }
}

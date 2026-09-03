import dgram from 'node:dgram';
import {
  DDP_PORT,
  DNRGB_TIMEOUT_SEC,
  LEGACY_UDP_PORT,
  buildDdpFrame,
  buildDnrgbFrame,
  nextDdpSequence,
  type PixelFormat,
} from '@ewc/core';
import { log } from '../logger.js';

/** How a device's frames leave the box. `dnrgb` = legacy realtime UDP fallback. */
export type RealtimeTransport = 'ddp' | 'dnrgb';

export interface DdpTarget {
  deviceId: number;
  host: string;
  /** UDP port for DDP — always 4048 for real WLED; overridable for the sink. */
  ddpPort: number;
  ledCount: number;
  format: PixelFormat;
  /**
   * LED offset compensation. All app-managed devices get E1.31 start address 1;
   * if the DDP path on a given firmware shifts by that, nudge this by ±1.
   */
  pixelOffset: number;
  /** DDP (default) or the legacy DNRGB UDP fallback for this one device. */
  transport: RealtimeTransport;
  /**
   * Cap this device's send rate (fps). `null` = stream at the full tick rate.
   * Used to spare slower controllers (ESP8266) that can't ingest 40 fps.
   */
  maxFps: number | null;
}

export interface DdpDeviceStats {
  deviceId: number;
  framesSent: number;
  framesDropped: number;
  packets: number;
  bytes: number;
  /** Device-reported render fps, if known (backpressure signal). */
  deviceFps: number | null;
  lastSendMs: number;
  /** Earliest wall-clock ms the next frame for this device may go out (fps cap). */
  pacedUntilMs: number;
}

/** Produces the wire byte buffer for one device for the current frame. */
export type FrameProducer = (target: DdpTarget, tMs: number) => Uint8Array;

export interface DdpSenderOptions {
  /** Target tick rate (Hz). WLED realistically ceilings around 40. */
  fps?: number;
  /** Drop a device's frame when its reported fps falls below this. */
  minDeviceFps?: number;
  /** How the sender learns each device's reported render fps. */
  deviceFps?: (deviceId: number) => number | null;
}

/**
 * Fixed-rate DDP streamer. One UDP socket, devices sent **sequentially** within
 * a tick (never parallel bursts), one shared sequence number per frame, PUSH on
 * the last packet only.
 *
 * Backpressure: when a device can't keep up we **drop frames, never queue** — a
 * queued UDP stream to a struggling ESP32 becomes lag that never recovers.
 */
export class DdpSender {
  private readonly sock = dgram.createSocket('udp4');
  private readonly fps: number;
  private readonly minDeviceFps: number;
  private readonly deviceFpsFn?: (deviceId: number) => number | null;

  private timer: NodeJS.Timeout | null = null;
  private startMs = 0;
  private seq = 1;
  private targets: DdpTarget[] = [];
  private producer: FrameProducer = () => new Uint8Array(0);
  private readonly stats = new Map<number, DdpDeviceStats>();
  private tickBusy = false;
  private tickCount = 0;

  constructor(opts: DdpSenderOptions = {}) {
    this.fps = Math.min(60, Math.max(1, opts.fps ?? 40));
    this.minDeviceFps = opts.minDeviceFps ?? 12;
    this.deviceFpsFn = opts.deviceFps;
    this.sock.on('error', (err) => log.warn('ddp socket error', { err: String(err) }));
  }

  get running(): boolean {
    return this.timer !== null;
  }

  /** Wall-clock ms when the current stream started — the origin of the `t` the
   *  producer sees. Survives `setProducer`, so a hot-swap keeps animation phase. */
  get epochMs(): number {
    return this.startMs;
  }

  getStats(): DdpDeviceStats[] {
    return [...this.stats.values()];
  }

  /** Swap the frame producer mid-stream (e.g. the scene or layout changed). */
  setProducer(producer: FrameProducer): void {
    this.producer = producer;
  }

  /** Replace the target list mid-stream (e.g. a device went offline). */
  setTargets(targets: DdpTarget[]): void {
    this.targets = targets;
    for (const t of targets) {
      if (!this.stats.has(t.deviceId)) {
        this.stats.set(t.deviceId, {
          deviceId: t.deviceId,
          framesSent: 0,
          framesDropped: 0,
          packets: 0,
          bytes: 0,
          deviceFps: null,
          lastSendMs: 0,
          pacedUntilMs: 0,
        });
      }
    }
    for (const id of [...this.stats.keys()]) {
      if (!targets.some((t) => t.deviceId === id)) this.stats.delete(id);
    }
  }

  start(targets: DdpTarget[], producer: FrameProducer): void {
    void this.stop();
    this.stats.clear();
    this.setTargets(targets);
    this.producer = producer;
    this.startMs = Date.now();
    this.seq = 1;
    this.tickCount = 0;
    const interval = Math.round(1000 / this.fps);
    this.timer = setInterval(() => void this.tick(), interval);
    log.info(`ddp: streaming to ${targets.length} device(s) at ${this.fps} fps`);
  }

  /** Stop streaming and release devices back to their preset immediately. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  close(): void {
    void this.stop();
    try {
      this.sock.close();
    } catch {
      /* already closed */
    }
  }

  private async tick(): Promise<void> {
    if (this.tickBusy) return; // never let ticks pile up
    this.tickBusy = true;
    this.tickCount++;
    const now = Date.now();
    const tMs = now - this.startMs;
    const frameSeq = this.seq;
    this.seq = nextDdpSequence(this.seq);

    try {
      for (const target of this.targets) {
        const st = this.stats.get(target.deviceId)!;
        st.deviceFps = this.deviceFpsFn?.(target.deviceId) ?? st.deviceFps;

        // Per-device fps cap: skip ticks until this device is next "due". This is
        // deliberate pacing for slow controllers — NOT a dropped frame, so it
        // must not touch `framesDropped` or it reads as a struggling device.
        if (target.maxFps && target.maxFps > 0 && target.maxFps < this.fps) {
          if (now < st.pacedUntilMs) continue;
          st.pacedUntilMs = now + 1000 / target.maxFps;
        }

        // Backpressure: if the device is *rendering* but well below our rate,
        // skip every other frame so we don't build lag it can't recover from.
        // fps 0 / null = unknown (device not live yet) → send, don't throttle.
        if (
          st.deviceFps !== null &&
          st.deviceFps > 0 &&
          st.deviceFps < this.minDeviceFps &&
          this.tickCount % 2 === 0
        ) {
          st.framesDropped++;
          continue;
        }

        let data: Uint8Array;
        try {
          data = this.producer(target, tMs);
        } catch (err) {
          log.debug(`ddp: producer failed for device ${target.deviceId}`, { err: String(err) });
          st.framesDropped++;
          continue;
        }
        if (data.length === 0) continue;

        // Transport is decided upstream (see `StreamService.targetFor`), which
        // also forces `format: 'rgb'` for DNRGB — so `data` is already the right
        // width here and no producer needs to know which transport is in use.
        let packets: Uint8Array[];
        let port: number;
        if (target.transport === 'dnrgb') {
          packets = buildDnrgbFrame({
            data,
            startIndex: Math.max(0, target.pixelOffset), // DNRGB index is in LEDs
            timeoutSec: DNRGB_TIMEOUT_SEC,
          });
          port = LEGACY_UDP_PORT;
        } else {
          const bytesPerLed = target.format === 'rgbw' ? 4 : 3;
          packets = buildDdpFrame({
            data,
            format: target.format,
            sequence: frameSeq,
            startChannelBytes: Math.max(0, target.pixelOffset) * bytesPerLed,
          });
          port = target.ddpPort || DDP_PORT;
        }

        await this.sendSequential(target.host, port, packets, st);
        st.framesSent++;
        st.lastSendMs = Date.now();
      }
    } finally {
      this.tickBusy = false;
    }
  }

  private sendSequential(
    host: string,
    port: number,
    packets: Uint8Array[],
    st: DdpDeviceStats,
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      let i = 0;
      const sendNext = () => {
        if (i >= packets.length) return resolve();
        const pkt = packets[i++]!;
        this.sock.send(pkt, port, host, (err) => {
          if (!err) {
            st.packets++;
            st.bytes += pkt.length;
          }
          sendNext();
        });
      };
      sendNext();
    });
  }
}

/** A solid-colour frame for a whole device (the milestone-3 transport proof). */
export function solidFrameProducer(color: readonly [number, number, number]): FrameProducer {
  return (target) => {
    const bpl = target.format === 'rgbw' ? 4 : 3;
    const buf = new Uint8Array(target.ledCount * bpl);
    for (let i = 0; i < target.ledCount; i++) {
      buf[i * bpl] = clamp8(color[0]);
      buf[i * bpl + 1] = clamp8(color[1]);
      buf[i * bpl + 2] = clamp8(color[2]);
    }
    return buf;
  };
}

/**
 * A positional alignment pattern by RAW device index — needs no fixture model.
 * LED 0 = white, 1 = red, 2 = green, last = blue, the rest a dim blue→amber
 * ramp so direction and any ±1 offset are obvious on the strip and in the sink.
 */
export function indexPatternProducer(): FrameProducer {
  return (target) => {
    const bpl = target.format === 'rgbw' ? 4 : 3;
    const n = target.ledCount;
    const buf = new Uint8Array(n * bpl);
    for (let i = 0; i < n; i++) {
      let c: [number, number, number];
      if (i === 0) c = [255, 255, 255];
      else if (i === 1) c = [255, 0, 0];
      else if (i === 2) c = [0, 255, 0];
      else if (i === n - 1) c = [0, 0, 255];
      else {
        const t = i / Math.max(1, n - 1);
        c = [Math.round(8 + t * 40), 4, Math.round(48 - t * 40)];
      }
      buf[i * bpl] = c[0];
      buf[i * bpl + 1] = c[1];
      buf[i * bpl + 2] = c[2];
    }
    return buf;
  };
}

function clamp8(n: number): number {
  return n < 0 ? 0 : n > 255 ? 255 : Math.round(n);
}

/**
 * A static pixel image from the painter. `pixels` is segment-relative — entry
 * `i` maps to raw LED `segStart + i`. `null` = LED off (DDP owns the whole
 * strip, so there is no "keep the effect" here). `brightness` (1..255) scales
 * every channel so the on-page slider is visible on the wire.
 */
export function paintFrameProducer(
  pixels: ReadonlyArray<readonly [number, number, number] | null>,
  segStart: number,
  brightness: number,
): FrameProducer {
  const scale = Math.max(0, Math.min(255, brightness)) / 255;
  return (target) => {
    const bpl = target.format === 'rgbw' ? 4 : 3;
    const buf = new Uint8Array(target.ledCount * bpl);
    for (let i = 0; i < pixels.length; i++) {
      const c = pixels[i];
      if (!c) continue;
      const o = (segStart + i) * bpl;
      if (o < 0 || o + 2 >= buf.length) continue;
      buf[o] = clamp8(c[0] * scale);
      buf[o + 1] = clamp8(c[1] * scale);
      buf[o + 2] = clamp8(c[2] * scale);
    }
    return buf;
  };
}

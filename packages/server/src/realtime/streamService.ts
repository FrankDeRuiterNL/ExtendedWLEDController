import {
  DDP_PORT,
  decodeCapabilities,
  unknownEffectIds,
  type PixelFormat,
  type Scene,
} from '@ewc/core';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { SettingsStore } from '../db/settings.js';
import { log } from '../logger.js';
import { DeviceRepo, type DeviceRow } from '../devices/repo.js';
import type { InstallationStore } from '../installation/store.js';
import { postState } from '../wled/httpClient.js';
import { sceneFrameProducer } from '../render/sceneProducer.js';
import {
  DdpSender,
  solidFrameProducer,
  indexPatternProducer,
  paintFrameProducer,
  type DdpTarget,
  type DdpDeviceStats,
} from './ddpSender.js';
import type { RealtimeHub } from './hub.js';

export type StreamMode = 'idle' | 'solid' | 'pattern' | 'scene' | 'paint';

/** Live pixel-painter stream: a static image DDP'd to one device. */
export interface PaintStream {
  deviceId: number;
  /** Raw LED index of the target segment's first LED. */
  segStart: number;
  /** Segment-relative; `null` = LED off. */
  pixels: Array<[number, number, number] | null>;
  brightness: number;
}

export interface StreamStatusDTO {
  mode: StreamMode;
  running: boolean;
  color: [number, number, number] | null;
  /** Present when `mode === 'scene'`. */
  scene: { name: string; layerCount: number; unknownEffects: string[] } | null;
  /** Present when `mode === 'paint'` — the live pixel-painter stream. */
  paint: { deviceId: number; litCount: number; ledCount: number } | null;
  /** Wall-clock ms the stream's animation clock started from — the preview seeds
   *  its own `t` from this so it stays phase-locked to the wire. */
  epochMs: number | null;
  fps: number;
  devices: Array<
    DdpDeviceStats & {
      name: string;
      connection: string;
      ledCount: number | null;
      universe: number | null;
      pixelOffset: number;
    }
  >;
}

const OFFSETS_KEY = 'ddpPixelOffsets';

/**
 * The device state machine for realtime: `idle(preset) → live(streaming) → idle`.
 * Entering realtime (DDP) blanks the strip and takes over rendering; on stop we
 * send `{live:false}` so the device returns to its preset immediately instead of
 * waiting out `realtimeTimeoutMs`.
 */
export class StreamService {
  private readonly repo: DeviceRepo;
  private readonly settings: SettingsStore;
  private readonly sender: DdpSender;
  private mode: StreamMode = 'idle';
  private color: [number, number, number] | null = null;
  private scene: Scene | null = null;
  private paint: PaintStream | null = null;
  private streamingIds = new Set<number>();

  constructor(
    db: Db,
    private readonly config: Config,
    private readonly hub: RealtimeHub,
    private readonly installations: InstallationStore,
  ) {
    this.repo = new DeviceRepo(db);
    this.settings = new SettingsStore(db);
    this.sender = new DdpSender({
      fps: 40,
      deviceFps: (id) => this.hub.getConnection(id)?.health?.fps ?? null,
    });

    // Keep targets in step with connectivity while streaming.
    this.hub.on('status', ({ deviceId, connection }) => {
      if (this.mode === 'idle') return;
      if (connection === 'offline') this.streamingIds.delete(deviceId);
      this.refreshTargets();
    });
  }

  private refreshScene(): void {
    const targets = this.collectTargets();
    this.streamingIds = new Set(targets.map((t) => t.deviceId));
    this.sender.setTargets(targets);
    if (this.scene) this.sender.setProducer(sceneFrameProducer(this.scene, this.installations.get()));
  }

  /**
   * Re-map fixtures onto the canvas without interrupting the stream. Call when
   * the layout is saved so the wall follows the edit.
   */
  onInstallationChanged(): void {
    if (this.mode === 'scene') this.refreshScene();
  }

  private pixelOffsets(): Record<string, number> {
    return this.settings.get<Record<string, number>>(OFFSETS_KEY, {});
  }

  setPixelOffset(deviceId: number, offset: number): void {
    const map = this.pixelOffsets();
    map[String(deviceId)] = Math.trunc(offset);
    this.settings.set(OFFSETS_KEY, map);
    if (this.mode !== 'idle') this.refreshTargets();
  }

  private targetFor(row: DeviceRow): DdpTarget | null {
    if (!row.led_count || row.led_count <= 0) return null;
    const conn = this.hub.getConnection(row.id);
    if (conn && conn.connection === 'offline') return null;
    const seglc = safeParse<number[]>(row.seglc_json) ?? [];
    const raw = seglc.length ? seglc.reduce((a, b) => a | (b ?? 0), 0) : (row.lc ?? 1);
    const format: PixelFormat = decodeCapabilities(raw).white ? 'rgbw' : 'rgb';
    return {
      deviceId: row.id,
      host: row.host,
      // Real WLED always listens for DDP on 4048; the `ddpPortOverrides` setting
      // exists only so a software sink can run on a nonstandard port.
      ddpPort: this.settings.get<Record<string, number>>('ddpPortOverrides', {})[String(row.id)] ?? DDP_PORT,
      ledCount: row.led_count,
      format,
      pixelOffset: this.pixelOffsets()[String(row.id)] ?? 0,
    };
  }

  private collectTargets(): DdpTarget[] {
    return this.repo
      .list()
      .filter((r) => r.enabled !== 0)
      .map((r) => this.targetFor(r))
      .filter((t): t is DdpTarget => t !== null);
  }

  private refreshTargets(): void {
    if (this.mode === 'scene') {
      this.refreshScene();
      return;
    }
    if (this.mode === 'paint') {
      this.refreshPaint();
      return;
    }
    const targets = this.collectTargets();
    this.streamingIds = new Set(targets.map((t) => t.deviceId));
    this.sender.setTargets(targets);
  }

  private refreshPaint(): void {
    if (!this.paint) return;
    const row = this.repo.get(this.paint.deviceId);
    const target = row && row.enabled !== 0 ? this.targetFor(row) : null;
    if (!target) {
      log.info(`stream: paint target device ${this.paint.deviceId} unavailable — stopping`);
      void this.stop();
      return;
    }
    this.sender.setTargets([target]);
  }

  /** Send `{live:false}` to a set of devices so they drop realtime immediately. */
  private async releaseDevices(ids: number[]): Promise<void> {
    await Promise.allSettled(
      ids.map(async (id) => {
        const row = this.repo.get(id);
        if (!row) return;
        const conn = this.hub.getConnection(id);
        try {
          if (conn) await conn.sendPatch({ live: false });
          else
            await postState(
              { host: row.host, port: row.port, timeoutMs: this.config.wledHttpTimeoutMs },
              { live: false },
            );
        } catch (err) {
          log.debug(`stream: could not release device ${id}`, { err: String(err) });
        }
      }),
    );
  }

  /**
   * Stream a static pixel image from the painter to ONE device. First paint
   * starts the stream; every later edit **hot-swaps** the producer (no restart,
   * no re-blank) so the strip tracks the canvas. Switching device (or coming
   * from a scene stream) releases the previous device(s) back to their preset.
   */
  startPaint(input: PaintStream): StreamStatusDTO {
    const row = this.repo.get(input.deviceId);
    const target = row && row.enabled !== 0 ? this.targetFor(row) : null;
    if (!target) {
      log.warn(`stream: cannot paint device ${input.deviceId} — offline or no LEDs`);
      return this.status();
    }

    this.color = null;
    this.scene = null;
    this.paint = input;
    const producer = paintFrameProducer(input.pixels, input.segStart, input.brightness);

    if (this.mode === 'paint' && this.sender.running && this.streamingIds.has(input.deviceId)) {
      this.sender.setProducer(producer);
      return this.status();
    }

    void this.releaseDevices([...this.streamingIds].filter((id) => id !== input.deviceId));

    this.mode = 'paint';
    this.streamingIds = new Set([input.deviceId]);
    this.sender.start([target], producer);
    log.info(`stream: painter → device ${input.deviceId} (${input.pixels.filter(Boolean).length} lit)`);
    return this.status();
  }

  startSolid(color: [number, number, number]): StreamStatusDTO {
    this.color = color;
    this.mode = 'solid';
    const targets = this.collectTargets();
    this.streamingIds = new Set(targets.map((t) => t.deviceId));
    this.sender.start(targets, solidFrameProducer(color));
    log.info(`stream: solid ${color.join(',')} → ${targets.length} device(s)`);
    return this.status();
  }

  /**
   * Stream a positional alignment pattern (LED 0 white, 1 red, 2 green, last
   * blue, rest a dim ramp) — the only way to actually see a ±1 pixel offset or a
   * reversed run on the strip. A solid colour can't reveal any of that.
   */
  startPattern(): StreamStatusDTO {
    this.color = null;
    this.mode = 'pattern';
    const targets = this.collectTargets();
    this.streamingIds = new Set(targets.map((t) => t.deviceId));
    this.sender.start(targets, indexPatternProducer());
    log.info(`stream: alignment pattern → ${targets.length} device(s)`);
    return this.status();
  }

  /**
   * Render a scene to every device, sampling the layout canvas per LED. If a
   * scene is already streaming this **hot-swaps** the compositor — no interval
   * restart, no stat reset, no re-blank — so the Studio editor can push every
   * keystroke and keep the wall identical to the preview.
   */
  startScene(scene: Scene): StreamStatusDTO {
    this.color = null;
    this.scene = scene;
    const unknown = unknownEffectIds(scene);
    if (unknown.length) log.warn(`stream: scene "${scene.name}" has unknown effects`, { unknown });

    if (this.mode === 'scene' && this.sender.running) {
      this.sender.setProducer(sceneFrameProducer(scene, this.installations.get()));
      return this.status();
    }

    this.mode = 'scene';
    const targets = this.collectTargets();
    this.streamingIds = new Set(targets.map((t) => t.deviceId));
    this.sender.start(targets, sceneFrameProducer(scene, this.installations.get()));
    log.info(`stream: scene "${scene.name}" (${scene.layers.length} layers) → ${targets.length} device(s)`);
    return this.status();
  }

  async stop(): Promise<void> {
    await this.sender.stop();
    const ids = [...this.streamingIds];
    this.mode = 'idle';
    this.color = null;
    this.scene = null;
    this.paint = null;
    this.streamingIds.clear();
    // Release each device from realtime back to its preset.
    await this.releaseDevices(ids);
    log.info('stream: stopped, devices released');
  }

  status(): StreamStatusDTO {
    const rows = new Map(this.repo.list().map((r) => [r.id, r]));
    const offsets = this.pixelOffsets();
    return {
      mode: this.mode,
      running: this.sender.running,
      color: this.color,
      scene: this.scene
        ? {
            name: this.scene.name,
            layerCount: this.scene.layers.length,
            unknownEffects: unknownEffectIds(this.scene),
          }
        : null,
      paint: this.paint
        ? {
            deviceId: this.paint.deviceId,
            litCount: this.paint.pixels.reduce((n, p) => (p ? n + 1 : n), 0),
            ledCount: this.paint.pixels.length,
          }
        : null,
      epochMs: this.sender.running ? this.sender.epochMs : null,
      fps: 40,
      devices: this.sender.getStats().map((s) => {
        const row = rows.get(s.deviceId);
        return {
          ...s,
          name: row?.name ?? `#${s.deviceId}`,
          connection: this.hub.getConnection(s.deviceId)?.connection ?? 'offline',
          ledCount: row?.led_count ?? null,
          universe: row?.dmx_universe ?? null,
          pixelOffset: offsets[String(s.deviceId)] ?? 0,
        };
      }),
    };
  }

  shutdown(): void {
    this.sender.close();
  }
}

function safeParse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

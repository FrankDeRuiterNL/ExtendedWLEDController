import {
  DDP_PORT,
  WHITE_BALANCE_MAX_K,
  WHITE_BALANCE_MIN_K,
  decodeCapabilities,
  isUnitGain,
  kelvinToRgbGain,
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
import type { MediaStore } from '../media/mediaStore.js';
import { postState } from '../wled/httpClient.js';
import { sceneFrameProducer } from '../render/sceneProducer.js';
import {
  DdpSender,
  solidFrameProducer,
  indexPatternProducer,
  paintFrameProducer,
  type DdpTarget,
  type DdpDeviceStats,
  type RealtimeTransport,
} from './ddpSender.js';
import type { RealtimeHub } from './hub.js';

export type StreamMode = 'idle' | 'solid' | 'pattern' | 'scene' | 'paint';

/** Per-device realtime output overrides (defaults: DDP, uncapped, no correction). */
export interface DeviceStreamConfig {
  transport?: RealtimeTransport;
  /** fps cap; absent/null = full rate. */
  maxFps?: number | null;
  /** Kelvin white-point correction for RGB-only strips; absent = off. */
  whiteBalance?: { enabled: boolean; kelvin: number };
}

/** A partial update to a device's stream config — `null` clears a field. */
export interface DeviceStreamConfigPatch {
  transport?: RealtimeTransport;
  maxFps?: number | null;
  whiteBalance?: { enabled: boolean; kelvin: number } | null;
}

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
      /** Realtime transport in use for this device. */
      transport: RealtimeTransport;
      /** fps cap for this device, or null when uncapped. */
      maxFps: number | null;
      /** Kelvin white-point correction, or null when off. */
      whiteBalance: { enabled: boolean; kelvin: number } | null;
    }
  >;
}

const OFFSETS_KEY = 'ddpPixelOffsets';
const STREAM_CONFIG_KEY = 'deviceStreamConfig';
/** Hard ceiling for a per-device fps cap — the sender ticks at 40. */
export const MAX_DEVICE_FPS = 40;

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
  /** When set, solid/pattern drive ONLY this device (per-device test stream). */
  private soloId: number | null = null;
  /**
   * Called just before a NON-rundown stream takes over (manual scene / solid /
   * pattern / paint). The RundownEngine hooks this to halt playback so its
   * pending cue timers can't fire onto a stream someone else now owns.
   */
  onExternalStreamStart?: () => void;
  /** Called after the stream is torn down (any `stop()`), so the RundownEngine
   *  can drop its playhead when the wire goes quiet. */
  onStopped?: () => void;

  constructor(
    db: Db,
    private readonly config: Config,
    private readonly hub: RealtimeHub,
    private readonly installations: InstallationStore,
    private readonly media?: MediaStore,
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
    if (this.scene) this.sender.setProducer(sceneFrameProducer(this.scene, this.installations.get(), this.media));
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

  private streamConfigs(): Record<string, DeviceStreamConfig> {
    return this.settings.get<Record<string, DeviceStreamConfig>>(STREAM_CONFIG_KEY, {});
  }

  private streamConfigFor(deviceId: number): DeviceStreamConfig {
    return this.streamConfigs()[String(deviceId)] ?? {};
  }

  /**
   * Set a device's realtime output overrides — transport (DDP vs the legacy
   * DNRGB UDP fallback) and/or an fps cap. Defaults (DDP, uncapped) are stored
   * as an *absent* entry so the settings blob stays small. Applies live.
   */
  setStreamConfig(deviceId: number, patch: DeviceStreamConfigPatch): void {
    const all = this.streamConfigs();
    const next: DeviceStreamConfig = { ...all[String(deviceId)] };

    if (patch.transport !== undefined) {
      if (patch.transport === 'dnrgb') next.transport = 'dnrgb';
      else delete next.transport;
    }
    if (patch.maxFps !== undefined) {
      const n = patch.maxFps;
      if (n === null || !Number.isFinite(n) || n <= 0 || n >= MAX_DEVICE_FPS) delete next.maxFps;
      else next.maxFps = Math.round(n);
    }
    if (patch.whiteBalance !== undefined) {
      const wb = patch.whiteBalance;
      if (!wb || !wb.enabled) delete next.whiteBalance;
      else
        next.whiteBalance = {
          enabled: true,
          kelvin: Math.round(clampKelvin(wb.kelvin)),
        };
    }

    if (Object.keys(next).length === 0) delete all[String(deviceId)];
    else all[String(deviceId)] = next;
    this.settings.set(STREAM_CONFIG_KEY, all);

    if (this.mode !== 'idle') this.refreshTargets();
  }

  private targetFor(row: DeviceRow): DdpTarget | null {
    if (!row.led_count || row.led_count <= 0) return null;
    const conn = this.hub.getConnection(row.id);
    if (conn && conn.connection === 'offline') return null;
    const seglc = safeParse<number[]>(row.seglc_json) ?? [];
    const raw = seglc.length ? seglc.reduce((a, b) => a | (b ?? 0), 0) : (row.lc ?? 1);

    const cfg = this.streamConfigFor(row.id);
    const transport: RealtimeTransport = cfg.transport === 'dnrgb' ? 'dnrgb' : 'ddp';
    // DNRGB is an RGB-only protocol — force 3 bytes/LED so every producer emits
    // the right width. The device's white channel is simply not driven on the
    // fallback path.
    const format: PixelFormat =
      transport === 'dnrgb' ? 'rgb' : decodeCapabilities(raw).white ? 'rgbw' : 'rgb';

    return {
      deviceId: row.id,
      host: row.host,
      // Real WLED always listens for DDP on 4048; the `ddpPortOverrides` setting
      // exists only so a software sink can run on a nonstandard port.
      ddpPort: this.settings.get<Record<string, number>>('ddpPortOverrides', {})[String(row.id)] ?? DDP_PORT,
      ledCount: row.led_count,
      format,
      pixelOffset: this.pixelOffsets()[String(row.id)] ?? 0,
      transport,
      maxFps: typeof cfg.maxFps === 'number' && cfg.maxFps > 0 ? cfg.maxFps : null,
      gain: whiteBalanceGain(cfg.whiteBalance),
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
    // solid / pattern
    let targets = this.collectTargets();
    if (this.soloId != null) {
      targets = targets.filter((t) => t.deviceId === this.soloId);
      if (targets.length === 0) {
        log.info(`stream: solo device ${this.soloId} unavailable — stopping`);
        void this.stop();
        return;
      }
    }
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
    this.onExternalStreamStart?.();
    const row = this.repo.get(input.deviceId);
    const target = row && row.enabled !== 0 ? this.targetFor(row) : null;
    if (!target) {
      log.warn(`stream: cannot paint device ${input.deviceId} — offline or no LEDs`);
      return this.status();
    }

    this.color = null;
    this.scene = null;
    this.paint = input;
    this.soloId = input.deviceId;
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

  /**
   * Stream a solid colour. With no `deviceId` it goes to every device (the
   * milestone-3 transport proof). With one, only that device is driven and any
   * others currently streaming are released — the same release-on-switch
   * behaviour as {@link startPaint}, so you can solid-test one strip without
   * disturbing the rest.
   */
  startSolid(color: [number, number, number], deviceId?: number): StreamStatusDTO {
    this.onExternalStreamStart?.();
    this.color = color;
    this.scene = null;
    this.paint = null;
    this.soloId = deviceId ?? null;
    const producer = solidFrameProducer(color);

    if (deviceId != null) {
      const row = this.repo.get(deviceId);
      const target = row && row.enabled !== 0 ? this.targetFor(row) : null;
      if (!target) {
        log.warn(`stream: cannot solid device ${deviceId} — offline or no LEDs`);
        return this.status();
      }
      if (this.mode === 'solid' && this.sender.running && this.streamingIds.has(deviceId) && this.streamingIds.size === 1) {
        this.sender.setProducer(producer);
        return this.status();
      }
      void this.releaseDevices([...this.streamingIds].filter((id) => id !== deviceId));
      this.mode = 'solid';
      this.streamingIds = new Set([deviceId]);
      this.sender.start([target], producer);
      log.info(`stream: solid ${color.join(',')} → device ${deviceId}`);
      return this.status();
    }

    this.mode = 'solid';
    const targets = this.collectTargets();
    this.streamingIds = new Set(targets.map((t) => t.deviceId));
    this.sender.start(targets, producer);
    log.info(`stream: solid ${color.join(',')} → ${targets.length} device(s)`);
    return this.status();
  }

  /**
   * Stream a positional alignment pattern (LED 0 white, 1 red, 2 green, last
   * blue, rest a dim ramp) — the only way to actually see a ±1 pixel offset or a
   * reversed run on the strip. A solid colour can't reveal any of that.
   */
  startPattern(): StreamStatusDTO {
    this.onExternalStreamStart?.();
    this.color = null;
    this.soloId = null;
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
    this.onExternalStreamStart?.();
    return this.streamScene(scene);
  }

  /**
   * Put a scene on the wire for the RundownEngine. Same as {@link startScene} but
   * it does NOT halt the rundown (the engine is the caller) and it leaves the
   * master level alone so the engine can fade it — `startScene`/`start` reset it
   * to 1, the engine sets 0 (and fades up) or 1 itself around this call.
   */
  streamRundownCue(scene: Scene): StreamStatusDTO {
    return this.streamScene(scene);
  }

  /** Ramp the master output level (0..1) over `ms` — the rundown's fade. */
  fadeMaster(level: number, ms: number): void {
    this.sender.fadeTo(level, ms);
  }

  /** Jump the master output level (0..1) with no ramp. */
  setMaster(level: number): void {
    this.sender.setMasterLevel(level);
  }

  /** Current master output level (0..1), including an in-flight fade. */
  get masterLevel(): number {
    return this.sender.masterLevel;
  }

  /** Whether the DDP sender is currently ticking. */
  get running(): boolean {
    return this.sender.running;
  }

  get streamMode(): StreamMode {
    return this.mode;
  }

  private streamScene(scene: Scene): StreamStatusDTO {
    this.color = null;
    this.soloId = null;
    this.scene = scene;
    const unknown = unknownEffectIds(scene);
    if (unknown.length) log.warn(`stream: scene "${scene.name}" has unknown effects`, { unknown });

    if (this.mode === 'scene' && this.sender.running) {
      this.sender.setProducer(sceneFrameProducer(scene, this.installations.get(), this.media));
      return this.status();
    }

    this.mode = 'scene';
    const targets = this.collectTargets();
    this.streamingIds = new Set(targets.map((t) => t.deviceId));
    this.sender.start(targets, sceneFrameProducer(scene, this.installations.get(), this.media));
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
    this.soloId = null;
    this.streamingIds.clear();
    this.onStopped?.();
    // Release each device from realtime back to its preset.
    await this.releaseDevices(ids);
    log.info('stream: stopped, devices released');
  }

  status(): StreamStatusDTO {
    const rows = new Map(this.repo.list().map((r) => [r.id, r]));
    const offsets = this.pixelOffsets();
    const configs = this.streamConfigs();
    const stats = new Map(this.sender.getStats().map((s) => [s.deviceId, s]));
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
      // One row per enabled device, always — so the Stage page can show and edit
      // per-device output settings (transport, fps cap, offset) even when idle.
      // Live send counters come from the sender when it's streaming that device.
      devices: [...rows.values()]
        .filter((row) => row.enabled !== 0)
        .map((row) => {
          const s = stats.get(row.id);
          const cfg = configs[String(row.id)] ?? {};
          return {
            deviceId: row.id,
            framesSent: s?.framesSent ?? 0,
            framesDropped: s?.framesDropped ?? 0,
            packets: s?.packets ?? 0,
            bytes: s?.bytes ?? 0,
            deviceFps: s?.deviceFps ?? null,
            lastSendMs: s?.lastSendMs ?? 0,
            pacedUntilMs: s?.pacedUntilMs ?? 0,
            name: row.name,
            connection: this.hub.getConnection(row.id)?.connection ?? 'offline',
            ledCount: row.led_count ?? null,
            universe: row.dmx_universe ?? null,
            pixelOffset: offsets[String(row.id)] ?? 0,
            transport: cfg.transport === 'dnrgb' ? ('dnrgb' as const) : ('ddp' as const),
            maxFps: typeof cfg.maxFps === 'number' && cfg.maxFps > 0 ? cfg.maxFps : null,
            whiteBalance:
              cfg.whiteBalance && cfg.whiteBalance.enabled
                ? { enabled: true, kelvin: cfg.whiteBalance.kelvin }
                : null,
          };
        }),
    };
  }

  shutdown(): void {
    this.sender.close();
  }
}

function clampKelvin(k: number): number {
  if (!Number.isFinite(k)) return WHITE_BALANCE_MAX_K;
  return Math.min(WHITE_BALANCE_MAX_K, Math.max(WHITE_BALANCE_MIN_K, k));
}

/** RGB gain for a device's white-balance config, or null when it's a no-op. */
function whiteBalanceGain(
  wb: DeviceStreamConfig['whiteBalance'],
): readonly [number, number, number] | null {
  if (!wb || !wb.enabled) return null;
  const g = kelvinToRgbGain(clampKelvin(wb.kelvin));
  return isUnitGain(g) ? null : g;
}

function safeParse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

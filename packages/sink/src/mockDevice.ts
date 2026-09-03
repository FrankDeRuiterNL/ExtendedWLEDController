/**
 * The state and JSON-API responses of a fake WLED device. Enough for the app's
 * registry, realtime hub and control path to treat it as real.
 */
import type { WledInfo, WledState } from '@ewc/core';

interface DmxCfg {
  uni: number;
  addr: number;
  mode: number;
}

export interface MockDeviceOptions {
  name: string;
  ledCount: number;
  matrix: { w: number; h: number } | null;
  mac: string;
  arch: string;
  websocket: boolean;
  dmx: DmxCfg;
}

// A small but representative slice of real WLED effect metadata.
const EFFECTS = [
  'Solid', 'Blink', 'Breathe', 'Wipe', 'Random Colors', 'Sweep', 'Dynamic', 'Colorloop',
  'Rainbow', 'Scan', 'Fade', 'Theater', 'Running', 'Twinkle', 'Sparkle', 'Chase', 'Aurora',
  'Fire 2012', 'Palette', 'Colorwaves', 'Bpm', 'Noise 1', 'Colortwinkles', 'Lake', 'Meteor',
  'Pride 2015', 'Plasma', 'Pacifica', 'Sunrise', 'Blends', 'RSVD', 'Tetrix', 'Gradient',
];
const FXDATA = [
  '', '!,Duty cycle;!,!;!;01', '!;!,!;!;01', '!,!;!,!;!', '!,!;;!', '!,!;!,!;!', '!,!,,,,Smooth;;!',
  '!,Saturation;;!;01', '!,Scale;;!', '!,# of dots,,,,,Overlay;!,!,!;!', '!;!,!;!;01', '!,Gap size;!,!;!',
  '!,Wave width;!,!;!', '!,!;!,!;!;;m12=0', '!,,,,,,Overlay;!,!;!;;m12=0', '!,Width;!,!;!',
  '!,!;1,2,3;!;;sx=24,pal=50', 'Cooling,Spark rate,,2D Blur,Boost;;!;1;pal=35,sx=64,ix=160,m12=1,c2=128',
  '!,Hue;!;!;;pal=26', '!;!;!;;pal=26', '!;!;!;;sx=64', '!;!;!;;pal=20', 'Fade speed,Spawn speed;;!;;m12=0',
  '!;Fx;!', '!,Trail,,,,Gradient,,Smooth;;!;1', '!,!,,,,,Overlay;!,!;!', '!,!;!,!;!', '!,!;!,!;!;;sx=96,ix=224,pal=0',
  'Time [min],Width;;!;;pal=35,sx=60', 'Shift speed,Blend speed;;!', '', '!,!;!,!;!;12;pal=11,ix=128', '!,Spread;!,!;!;;ix=16',
];
const PALETTES = [
  'Default', '* Random Cycle', '* Color 1', '* Colors 1&2', '* Color Gradient', '* Colors Only',
  'Party', 'Cloud', 'Lava', 'Ocean', 'Forest', 'Rainbow', 'Sunset', 'Fire', 'Icefire', 'Aurora',
  'Atlantica', 'Temperature', 'Candy', 'C9', 'Sakura',
];

export class MockDevice {
  readonly boot = Date.now();
  state: WledState;
  private readonly opts: MockDeviceOptions;
  cfgDmx: DmxCfg;

  constructor(opts: MockDeviceOptions) {
    this.opts = opts;
    this.cfgDmx = { ...opts.dmx };
    this.state = {
      on: true,
      bri: 128,
      transition: 7,
      mainseg: 0,
      seg: [
        {
          id: 0,
          start: 0,
          stop: opts.ledCount,
          len: opts.ledCount,
          grp: 1,
          spc: 0,
          of: 0,
          on: true,
          bri: 255,
          col: [[255, 160, 0], [0, 0, 0], [0, 0, 0]],
          fx: 0,
          sx: 128,
          ix: 128,
          pal: 0,
          c1: 128,
          c2: 128,
          c3: 16,
          sel: true,
        },
      ],
    };
  }

  get effectNames(): string[] {
    return EFFECTS;
  }
  get fxdata(): string[] {
    return FXDATA;
  }
  get palettes(): string[] {
    return PALETTES;
  }

  info(wsClients: number, live: boolean): WledInfo {
    return {
      ver: '16.0.1-sink',
      vid: 2605010,
      leds: {
        count: this.opts.ledCount,
        pwr: this.state.on === false ? 0 : Math.round((this.state.bri ?? 0) * this.opts.ledCount * 0.06),
        fps: live ? 40 : 0,
        maxpwr: 2500,
        maxseg: 32,
        seglc: [1],
        lc: 1,
        ...(this.opts.matrix ? { matrix: this.opts.matrix } : {}),
      },
      name: this.opts.name,
      udpport: 21324,
      live,
      liveseg: live ? 0 : -1,
      lm: live ? 'DDP' : '',
      lip: '',
      ws: this.opts.websocket ? wsClients : -1,
      fxcount: EFFECTS.length,
      palcount: PALETTES.length,
      maps: [{ id: 0 }],
      wifi: { bssid: '00:11:22:33:44:55', rssi: -55, signal: 82, channel: 6 },
      fs: { u: 20, t: 983, pmt: 0 },
      ndc: 0,
      arch: this.opts.arch,
      core: 'sink',
      freeheap: 120000 + Math.round(Math.random() * 8000),
      uptime: Math.floor((Date.now() - this.boot) / 1000),
      opt: 79,
      brand: 'EWC',
      product: 'Software Sink',
      mac: this.opts.mac,
      ip: '127.0.0.1',
    };
  }

  cfg(): unknown {
    return {
      rev: [1, 0],
      id: { mdns: `sink-${this.opts.mac.slice(-4)}`, name: this.opts.name },
      hw: { led: { total: this.opts.ledCount, ins: [{ start: 0, len: this.opts.ledCount, type: 22 }] } },
      light: { 'scale-bri': 100, gc: { bri: 1, col: 2.8, val: 2.8 }, tr: { dur: 7 } },
      def: { ps: 0, on: true, bri: 128 },
      if: {
        live: {
          en: true,
          port: 6454,
          dmx: { uni: this.cfgDmx.uni, addr: this.cfgDmx.addr, mode: this.cfgDmx.mode, seqskip: false, e131prio: 0 },
          timeout: 25,
          'no-gc': true,
          maxbri: false,
          offset: 0,
        },
        nodes: { list: true, bcast: true },
      },
    };
  }

  /** Merge a partial state patch (shallow for scalars, by-id for segments). */
  applyPatch(patch: Record<string, unknown>): void {
    const { seg, ...rest } = patch as WledState & Record<string, unknown>;
    for (const [k, v] of Object.entries(rest)) {
      if (k === 'psave' || k === 'pdel' || k === 'live') continue;
      (this.state as Record<string, unknown>)[k] = v;
    }
    if (Array.isArray(seg)) {
      const segs = this.state.seg ?? [];
      for (const p of seg) {
        const id = (p as { id?: number }).id ?? 0;
        const existing = segs.find((s) => s.id === id);
        if (existing) Object.assign(existing, p);
        else segs.push(p);
      }
      this.state.seg = segs;
    }
    // Never report bri:0.
    if (typeof this.state.bri === 'number' && this.state.bri <= 0) this.state.on = false;
  }

  /** Apply a partial cfg patch (only the bits we model). */
  applyCfg(patch: Record<string, unknown>): void {
    const dmx = (patch as { if?: { live?: { dmx?: Partial<DmxCfg> } } }).if?.live?.dmx;
    if (dmx) this.cfgDmx = { ...this.cfgDmx, ...dmx };
  }
}

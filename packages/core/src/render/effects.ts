/**
 * The starter effect set. Every effect is a pure function of `(x, y, t, params)`
 * with x,y in [0,1] (y down) and t in seconds — no closures over frame state, so
 * the browser preview and the DDP loop produce identical colour.
 *
 * IDs are persisted in saved scenes: never rename or remove one.
 */

import { axisCoord, clamp01, hsv, mix, ramp } from './color.js';
import { fbm2, valueNoise2 } from './noise.js';
import { colorParam, numParam, strParam, type EffectDef, type RGB } from './types.js';

const FIRE_RAMP: Array<[number, RGB]> = [
  [0.0, [0, 0, 0]],
  [0.3, [128, 24, 0]],
  [0.6, [230, 96, 0]],
  [0.82, [255, 190, 40]],
  [1.0, [255, 255, 200]],
];

function fract(n: number): number {
  return n - Math.floor(n);
}

/** Distance on a wrapped 0..1 axis. */
function wrapDist(a: number, b: number): number {
  const d = Math.abs(a - b) % 1;
  return d > 0.5 ? 1 - d : d;
}

const solid: EffectDef = {
  id: 'solid',
  name: 'Solid',
  blurb: 'One flat colour across the whole canvas.',
  params: [{ key: 'color', label: 'Colour', type: 'color', default: [253, 176, 3] }],
  render: (_x, _y, _t, p) => {
    const c = colorParam(p, 'color', [253, 176, 3]);
    return [c[0], c[1], c[2], 1];
  },
};

const gradient: EffectDef = {
  id: 'gradient',
  name: 'Gradient',
  blurb: 'Linear blend between two colours along an angle.',
  params: [
    { key: 'from', label: 'From', type: 'color', default: [255, 0, 96] },
    { key: 'to', label: 'To', type: 'color', default: [0, 128, 255] },
    { key: 'angle', label: 'Angle', type: 'number', default: 0, min: 0, max: 360, step: 1 },
    { key: 'mirror', label: 'Mirror', type: 'bool', default: false },
  ],
  render: (x, y, _t, p) => {
    const a = colorParam(p, 'from', [255, 0, 96]);
    const b = colorParam(p, 'to', [0, 128, 255]);
    let u = clamp01(axisCoord(x, y, numParam(p, 'angle', 0)));
    if (p['mirror'] === true) u = 1 - Math.abs(u * 2 - 1);
    const c = mix(a, b, u);
    return [c[0], c[1], c[2], 1];
  },
};

const rainbow: EffectDef = {
  id: 'rainbow',
  name: 'Rainbow',
  blurb: 'Full-spectrum hue sweep that scrolls over time.',
  params: [
    { key: 'speed', label: 'Speed', type: 'number', default: 0.15, min: -2, max: 2, step: 0.01 },
    { key: 'scale', label: 'Bands', type: 'number', default: 1, min: 0.2, max: 6, step: 0.1 },
    { key: 'angle', label: 'Angle', type: 'number', default: 0, min: 0, max: 360, step: 1 },
    { key: 'saturation', label: 'Saturation', type: 'number', default: 1, min: 0, max: 1, step: 0.01 },
  ],
  render: (x, y, t, p) => {
    const u = axisCoord(x, y, numParam(p, 'angle', 0));
    const h = u * numParam(p, 'scale', 1) + t * numParam(p, 'speed', 0.15);
    const c = hsv(h, numParam(p, 'saturation', 1), 1);
    return [c[0], c[1], c[2], 1];
  },
};

const plasma: EffectDef = {
  id: 'plasma',
  name: 'Plasma',
  blurb: 'Smooth drifting noise field between two colours.',
  params: [
    { key: 'from', label: 'Colour A', type: 'color', default: [16, 0, 64] },
    { key: 'to', label: 'Colour B', type: 'color', default: [255, 64, 160] },
    { key: 'scale', label: 'Scale', type: 'number', default: 3, min: 0.5, max: 12, step: 0.1 },
    { key: 'speed', label: 'Speed', type: 'number', default: 0.3, min: 0, max: 3, step: 0.01 },
  ],
  render: (x, y, t, p) => {
    const s = numParam(p, 'scale', 3);
    const spd = t * numParam(p, 'speed', 0.3);
    const n =
      0.5 *
      (valueNoise2(x * s + spd, y * s - spd * 0.6) +
        valueNoise2(x * s * 1.7 - spd * 0.4, y * s * 1.7 + spd));
    const c = mix(colorParam(p, 'from', [16, 0, 64]), colorParam(p, 'to', [255, 64, 160]), clamp01(n));
    return [c[0], c[1], c[2], 1];
  },
};

const fire: EffectDef = {
  id: 'fire',
  name: 'Fire',
  blurb: 'Flames licking up the canvas (hot edge at the bottom).',
  params: [
    { key: 'speed', label: 'Speed', type: 'number', default: 1.1, min: 0.1, max: 4, step: 0.05 },
    { key: 'scale', label: 'Scale', type: 'number', default: 3, min: 1, max: 10, step: 0.1 },
    { key: 'intensity', label: 'Intensity', type: 'number', default: 0.6, min: 0.1, max: 1, step: 0.01 },
  ],
  render: (x, y, t, p) => {
    const scale = numParam(p, 'scale', 3);
    const rise = t * numParam(p, 'speed', 1.1);
    // y down: bottom (y≈1) is the base of the fire.
    const base = y;
    const n = fbm2(x * scale, y * scale * 1.4 - rise, 3);
    let heat = base * (0.55 + numParam(p, 'intensity', 0.6)) * (0.4 + n);
    heat = clamp01(heat);
    const c = ramp(FIRE_RAMP, heat);
    return [c[0], c[1], c[2], 1];
  },
};

const wipe: EffectDef = {
  id: 'wipe',
  name: 'Wipe',
  blurb: 'Hard colour edge sweeping across and repeating.',
  params: [
    { key: 'from', label: 'Colour A', type: 'color', default: [0, 0, 0] },
    { key: 'to', label: 'Colour B', type: 'color', default: [253, 176, 3] },
    { key: 'speed', label: 'Speed', type: 'number', default: 0.4, min: -3, max: 3, step: 0.01 },
    { key: 'angle', label: 'Angle', type: 'number', default: 0, min: 0, max: 360, step: 1 },
    { key: 'softness', label: 'Edge softness', type: 'number', default: 0.05, min: 0, max: 0.5, step: 0.01 },
  ],
  render: (x, y, t, p) => {
    const u = axisCoord(x, y, numParam(p, 'angle', 0));
    const phase = fract(u - t * numParam(p, 'speed', 0.4));
    const soft = Math.max(1e-4, numParam(p, 'softness', 0.05));
    // rising edge at 0, falling edge at 0.5
    const k = phase < 0.5
      ? clamp01(phase / soft)
      : clamp01((1 - phase) / soft);
    const c = mix(colorParam(p, 'from', [0, 0, 0]), colorParam(p, 'to', [253, 176, 3]), k);
    return [c[0], c[1], c[2], 1];
  },
};

const chase: EffectDef = {
  id: 'chase',
  name: 'Chase',
  blurb: 'Evenly spaced pulses running along the strip.',
  params: [
    { key: 'color', label: 'Colour', type: 'color', default: [253, 176, 3] },
    { key: 'count', label: 'Pulses', type: 'number', default: 4, min: 1, max: 40, step: 1 },
    { key: 'speed', label: 'Speed', type: 'number', default: 0.5, min: -4, max: 4, step: 0.01 },
    { key: 'width', label: 'Width', type: 'number', default: 0.35, min: 0.02, max: 1, step: 0.01 },
    { key: 'angle', label: 'Angle', type: 'number', default: 0, min: 0, max: 360, step: 1 },
  ],
  render: (x, y, t, p) => {
    const u = axisCoord(x, y, numParam(p, 'angle', 0));
    const count = Math.max(1, Math.round(numParam(p, 'count', 4)));
    const phase = u * count - t * numParam(p, 'speed', 0.5) * count;
    const tri = 1 - 2 * Math.abs(fract(phase) - 0.5); // 0..1..0
    const w = numParam(p, 'width', 0.35);
    const v = clamp01((tri - (1 - w)) / w);
    const c = colorParam(p, 'color', [253, 176, 3]);
    return [c[0], c[1], c[2], v * v];
  },
};

const comet: EffectDef = {
  id: 'comet',
  name: 'Comet',
  blurb: 'A bright head dragging a fading tail.',
  params: [
    { key: 'color', label: 'Colour', type: 'color', default: [120, 200, 255] },
    { key: 'speed', label: 'Speed', type: 'number', default: 0.4, min: -3, max: 3, step: 0.01 },
    { key: 'tail', label: 'Tail length', type: 'number', default: 0.35, min: 0.03, max: 1, step: 0.01 },
    { key: 'angle', label: 'Angle', type: 'number', default: 0, min: 0, max: 360, step: 1 },
  ],
  render: (x, y, t, p) => {
    const u = axisCoord(x, y, numParam(p, 'angle', 0));
    const speed = numParam(p, 'speed', 0.4);
    const head = fract(t * speed);
    // distance travelled since the head passed this point (moving toward +u)
    const behind = fract(speed >= 0 ? head - u : u - head);
    const tail = Math.max(1e-3, numParam(p, 'tail', 0.35));
    const v = Math.exp(-behind / (tail * 0.5));
    const c = colorParam(p, 'color', [120, 200, 255]);
    return [c[0], c[1], c[2], clamp01(v)];
  },
};

const scanner: EffectDef = {
  id: 'scanner',
  name: 'Scanner',
  blurb: 'A block of light bouncing end to end (Larson scanner).',
  params: [
    { key: 'color', label: 'Colour', type: 'color', default: [255, 32, 32] },
    { key: 'speed', label: 'Speed', type: 'number', default: 0.5, min: 0.05, max: 4, step: 0.01 },
    { key: 'width', label: 'Width', type: 'number', default: 0.15, min: 0.02, max: 0.6, step: 0.01 },
    { key: 'angle', label: 'Angle', type: 'number', default: 0, min: 0, max: 360, step: 1 },
  ],
  render: (x, y, t, p) => {
    const u = axisCoord(x, y, numParam(p, 'angle', 0));
    const pos = 0.5 - 0.5 * Math.cos(2 * Math.PI * t * numParam(p, 'speed', 0.5));
    const w = numParam(p, 'width', 0.15);
    const v = clamp01(1 - Math.abs(u - pos) / w);
    const c = colorParam(p, 'color', [255, 32, 32]);
    return [c[0], c[1], c[2], v * v];
  },
};

const sparkle: EffectDef = {
  id: 'sparkle',
  name: 'Sparkle',
  blurb: 'Random twinkles fading in and out.',
  params: [
    { key: 'color', label: 'Colour', type: 'color', default: [255, 255, 255] },
    { key: 'density', label: 'Density', type: 'number', default: 40, min: 4, max: 200, step: 1 },
    { key: 'speed', label: 'Speed', type: 'number', default: 1.2, min: 0.1, max: 6, step: 0.05 },
    { key: 'mode', label: 'Spread', type: 'select', default: 'x', options: [
      { value: 'x', label: 'Along strip' },
      { value: 'xy', label: 'Across canvas' },
    ] },
  ],
  render: (x, y, t, p) => {
    const density = Math.max(1, Math.round(numParam(p, 'density', 40)));
    const cx = Math.floor(x * density);
    const cy = strParam(p, 'mode', 'x') === 'xy' ? Math.floor(y * Math.max(1, density / 3)) : 0;
    const seed = valueNoise2(cx * 12.9 + 3.1, cy * 78.2 + 1.7); // stable per-cell 0..1
    const phase = t * numParam(p, 'speed', 1.2) * (0.5 + seed) + seed * 10;
    const f = fract(phase);
    // short bright blip per cycle
    const v = f < 0.25 ? Math.sin((f / 0.25) * Math.PI) : 0;
    const c = colorParam(p, 'color', [255, 255, 255]);
    return [c[0], c[1], c[2], clamp01(v)];
  },
};

/** Every effect, in picker order. */
export const EFFECT_LIST: EffectDef[] = [
  solid,
  gradient,
  rainbow,
  plasma,
  fire,
  wipe,
  chase,
  comet,
  scanner,
  sparkle,
];

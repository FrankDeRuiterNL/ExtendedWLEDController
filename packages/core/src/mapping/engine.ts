/**
 * The mapping engine: turn an {@link Installation} into a flat list of LEDs, each
 * with its position on the normalised canvas, then sample a canvas function to
 * fill per-device byte buffers.
 *
 * Resolution- and device-independent: the same effect runs unchanged on a
 * 60-pixel strip or a 30k-pixel installation.
 */

import type { PixelFormat } from '../ddp/packet.js';
import type {
  Fixture,
  FixtureGeometry,
  FixtureShape,
  Installation,
  MatrixOrigin,
  Vec2,
} from './model.js';

export interface MappedLed {
  deviceId: number;
  /** Wire index within the device's whole strip. */
  index: number;
  /** Normalised canvas position, 0..1 (may fall slightly outside if a fixture overhangs). */
  x: number;
  y: number;
}

// --- wire index → local grid cell -----------------------------------

/** Map a matrix wire index to its (col,row), honouring serpentine + origin. */
export function matrixCell(
  wireIndex: number,
  g: Extract<FixtureGeometry, { kind: 'matrix' }>,
): { col: number; row: number } {
  const w = Math.max(1, Math.floor(g.width));
  const h = Math.max(1, Math.floor(g.height));
  const columnMajor = g.columnMajor ?? false;

  // Position along the primary axis and the secondary axis.
  const major = columnMajor ? h : w; // length of a run
  let a = Math.floor(wireIndex / major); // which run
  let b = wireIndex % major; // position within the run
  if (g.serpentine && a % 2 === 1) b = major - 1 - b;

  let col: number;
  let row: number;
  if (columnMajor) {
    col = a;
    row = b;
  } else {
    col = b;
    row = a;
  }

  // Apply origin: default is top-left with row increasing downward.
  return applyOrigin(col, row, w, h, g.origin);
}

function applyOrigin(
  col: number,
  row: number,
  w: number,
  h: number,
  origin: MatrixOrigin,
): { col: number; row: number } {
  switch (origin) {
    case 'top-left':
      return { col, row };
    case 'top-right':
      return { col: w - 1 - col, row };
    case 'bottom-left':
      return { col, row: h - 1 - row };
    case 'bottom-right':
      return { col: w - 1 - col, row: h - 1 - row };
  }
}

// --- shape outlines -------------------------------------------------

/** Vertices (unit box) of a preset/custom shape, plus whether the path is closed. */
export function shapeOutline(shape: FixtureShape): { verts: Vec2[]; closed: boolean } {
  if (shape.type === 'custom') {
    const verts = shape.points.map((p) => ({ x: p.x, y: p.y }));
    return { verts, closed: !!shape.closed && verts.length >= 3 };
  }
  switch (shape.type) {
    case 'line':
      return { verts: [{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }], closed: false };
    case 'rectangle':
    case 'square':
      return { verts: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], closed: true };
    case 'triangle':
      return { verts: [{ x: 0.5, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], closed: true };
    case 'diamond':
      return {
        verts: [{ x: 0.5, y: 0 }, { x: 1, y: 0.5 }, { x: 0.5, y: 1 }, { x: 0, y: 0.5 }],
        closed: true,
      };
    case 'circle': {
      // A fine polygon; distribution then spaces LEDs evenly along it.
      const seg = 96;
      const verts = Array.from({ length: seg }, (_, i) => {
        const a = -Math.PI / 2 + (i / seg) * Math.PI * 2;
        return { x: 0.5 + 0.5 * Math.cos(a), y: 0.5 + 0.5 * Math.sin(a) };
      });
      return { verts, closed: true };
    }
  }
}

const dist2 = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** `n` points spaced evenly along the polyline through `verts`. */
export function distributeAlongPath(verts: readonly Vec2[], n: number, closed: boolean): Vec2[] {
  if (n <= 0) return [];
  const first = verts[0] ?? { x: 0.5, y: 0.5 };
  if (verts.length < 2 || n === 1) return Array.from({ length: n }, () => ({ ...first }));

  const pts = closed ? [...verts, first] : [...verts];
  const segLen: number[] = [];
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const d = dist2(pts[i]!, pts[i + 1]!);
    segLen.push(d);
    total += d;
  }
  if (total === 0) return Array.from({ length: n }, () => ({ ...first }));

  const step = closed ? total / n : total / (n - 1);
  const out: Vec2[] = [];
  for (let k = 0; k < n; k++) {
    const target = !closed && k === n - 1 ? total : k * step;
    let acc = 0;
    let si = 0;
    while (si < segLen.length - 1 && acc + segLen[si]! < target) {
      acc += segLen[si]!;
      si++;
    }
    const t = segLen[si]! > 0 ? (target - acc) / segLen[si]! : 0;
    const a = pts[si]!;
    const b = pts[si + 1]!;
    out.push({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) });
  }
  return out;
}

/** Local unit-box coordinates (0..1) for every LED of a fixture, in wire order. */
export function fixtureLocalPositions(g: FixtureGeometry): Vec2[] {
  switch (g.kind) {
    case 'strip': {
      const n = Math.max(0, Math.floor(g.count));
      return Array.from({ length: n }, (_, i) => ({
        x: n > 1 ? i / (n - 1) : 0.5,
        y: 0.5,
      }));
    }
    case 'shape': {
      const n = Math.max(0, Math.floor(g.count));
      const { verts, closed } = shapeOutline(g.shape);
      return distributeAlongPath(verts, n, closed);
    }
    case 'matrix': {
      const w = Math.max(1, Math.floor(g.width));
      const h = Math.max(1, Math.floor(g.height));
      return Array.from({ length: w * h }, (_, i) => {
        const { col, row } = matrixCell(i, g);
        return {
          x: w > 1 ? col / (w - 1) : 0.5,
          y: h > 1 ? row / (h - 1) : 0.5,
        };
      });
    }
    case 'points':
      return g.points.map((p) => ({ x: p.x, y: p.y }));
  }
}

// --- transform to canvas ------------------------------------------

/** Place a fixture's local positions onto the normalised canvas. */
export function mapFixture(fixture: Fixture, canvas: Installation['canvas']): MappedLed[] {
  const local = fixtureLocalPositions(fixture.geometry);
  const { position, rotationDeg, size } = fixture.transform;
  const rad = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const cw = canvas.width || 1;
  const ch = canvas.height || 1;

  return local.map((p, i) => {
    // centre the local box, scale to canvas-unit size, rotate, translate
    const lx = (p.x - 0.5) * size.x;
    const ly = (p.y - 0.5) * size.y;
    const rx = lx * cos - ly * sin;
    const ry = lx * sin + ly * cos;
    return {
      deviceId: fixture.deviceId,
      index: fixture.startIndex + i,
      x: (position.x + rx) / cw,
      y: (position.y + ry) / ch,
    };
  });
}

/** Every LED of every enabled fixture, positioned on the canvas. */
export function mapInstallation(inst: Installation): MappedLed[] {
  const out: MappedLed[] = [];
  for (const f of inst.fixtures) {
    if (!f.enabled) continue;
    out.push(...mapFixture(f, inst.canvas));
  }
  return out;
}

// --- sampling into device buffers --------------------------------

export type SampleFn = (x: number, y: number) => readonly number[];

export interface DeviceBufferSpec {
  deviceId: number;
  /** Total LEDs on the device (buffer is sized to this, not to the fixtures). */
  ledCount: number;
  format: PixelFormat;
}

/**
 * Sample `sample(x,y)` for every mapped LED and pack the results into one
 * `Uint8Array` per device. LEDs not covered by any fixture stay black.
 */
export function renderDeviceBuffers(
  mapped: readonly MappedLed[],
  devices: readonly DeviceBufferSpec[],
  sample: SampleFn,
): Map<number, Uint8Array> {
  const buffers = new Map<number, Uint8Array>();
  const specs = new Map<number, DeviceBufferSpec>();
  for (const d of devices) {
    specs.set(d.deviceId, d);
    buffers.set(d.deviceId, new Uint8Array(Math.max(0, d.ledCount) * (d.format === 'rgbw' ? 4 : 3)));
  }

  for (const led of mapped) {
    const spec = specs.get(led.deviceId);
    const buf = buffers.get(led.deviceId);
    if (!spec || !buf) continue;
    const bpl = spec.format === 'rgbw' ? 4 : 3;
    const o = led.index * bpl;
    if (o < 0 || o + bpl > buf.length) continue;

    const c = sample(led.x, led.y);
    buf[o] = clamp8(c[0]);
    buf[o + 1] = clamp8(c[1]);
    buf[o + 2] = clamp8(c[2]);
    if (bpl === 4) buf[o + 3] = clamp8(c[3] ?? 0);
  }
  return buffers;
}

function clamp8(n: number | undefined): number {
  if (n === undefined || Number.isNaN(n)) return 0;
  return n < 0 ? 0 : n > 255 ? 255 : Math.round(n);
}

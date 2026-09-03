/**
 * The fixture / mapping model.
 *
 *   Installation
 *     └── Fixture (a run of LEDs on one device, at a wire offset)
 *           └── Geometry: strip | matrix | points
 *           └── Transform: position, rotation, size on the shared canvas
 *
 * Fixtures place onto one **virtual canvas**. Effects (milestone 4) render to the
 * canvas in normalised [0,1] coordinates; the mapper samples the canvas per LED
 * and writes into per-device RGB(W) buffers.
 *
 * CRITICAL: geometry maps **wire index → canvas position**, never the reverse.
 * Serpentine matrices, multi-output controllers and ledmaps all break the naive
 * index→position assumption — this model is the single source of truth. Realtime
 * addressing (raw LED index) and device-side segments stay completely separate.
 */

export interface Vec2 {
  x: number;
  y: number;
}

export type MatrixOrigin = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

export type FixtureGeometry =
  | { kind: 'strip'; count: number }
  | {
      kind: 'matrix';
      width: number;
      height: number;
      /** Wire snakes back on alternate rows. */
      serpentine: boolean;
      /** Which physical corner wire-index 0 sits at. */
      origin: MatrixOrigin;
      /** True = wire runs column-by-column instead of row-by-row. */
      columnMajor?: boolean;
    }
  | {
      kind: 'points';
      /** Local coordinates, each component 0..1 within the fixture's own box. */
      points: Vec2[];
    };

export interface FixtureTransform {
  /** Centre of the fixture on the canvas, in canvas units. */
  position: Vec2;
  rotationDeg: number;
  /** Size of the fixture's bounding box on the canvas, in canvas units. */
  size: Vec2;
}

export interface Fixture {
  id: string;
  deviceId: number;
  name: string;
  /** First LED wire-index in the device's whole-strip index space. */
  startIndex: number;
  geometry: FixtureGeometry;
  transform: FixtureTransform;
  enabled: boolean;
}

export interface Installation {
  fixtures: Fixture[];
  /** Canvas dimensions in arbitrary units; only the aspect ratio matters. */
  canvas: { width: number; height: number };
}

export const EMPTY_INSTALLATION: Installation = {
  fixtures: [],
  canvas: { width: 16, height: 9 },
};

/** Number of LEDs a geometry contains. */
export function fixtureLedCount(g: FixtureGeometry): number {
  switch (g.kind) {
    case 'strip':
      return Math.max(0, Math.floor(g.count));
    case 'matrix':
      return Math.max(0, Math.floor(g.width) * Math.floor(g.height));
    case 'points':
      return g.points.length;
  }
}

/** LED wire-index range `[startIndex, startIndex + count)` a fixture occupies. */
export function fixtureIndexRange(f: Fixture): [number, number] {
  return [f.startIndex, f.startIndex + fixtureLedCount(f.geometry)];
}

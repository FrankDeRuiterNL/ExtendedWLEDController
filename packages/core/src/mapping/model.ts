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

/** Preset outlines a shaped fixture's LEDs are laid along. */
export type ShapeKind = 'line' | 'rectangle' | 'square' | 'triangle' | 'diamond' | 'circle';

/**
 * The path a shaped fixture's LEDs follow, in the fixture's own 0..1 unit box.
 * `line` is an open path (LED 0 at one end, last LED at the other); the other
 * presets are closed. A `custom` path is **open by default** (LED 0 at the first
 * vertex, last LED at the last) and only closed when `closed` is set — the user
 * clicked back on the first point while drawing.
 */
export type FixtureShape =
  | { type: ShapeKind }
  /** `points` are ordered vertices in the unit box; LED 0 sits at `points[0]`. */
  | { type: 'custom'; points: Vec2[]; closed?: boolean };

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
    }
  | {
      /** `count` LEDs distributed evenly along `shape`'s outline. */
      kind: 'shape';
      count: number;
      shape: FixtureShape;
    };

/** Shape presets whose bounding box must stay 1:1 (the transform size is locked square). */
export const SQUARE_SHAPES: ReadonlySet<ShapeKind> = new Set(['square', 'diamond', 'circle']);

/** True when a shaped geometry should keep a 1:1 transform size. */
export function shapeIsSquare(g: FixtureGeometry): boolean {
  return g.kind === 'shape' && g.shape.type !== 'custom' && SQUARE_SHAPES.has(g.shape.type);
}

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

/**
 * A room floorplan / reference image placed on the layout canvas. Purely a
 * visual aid — it never reaches the wire. The bytes live on the server; the
 * installation keeps only this reference plus the image's on-canvas transform.
 */
export interface FloorplanRef {
  /** File name on the server, under the data dir. */
  asset: string;
  /** Bumped on every re-upload; use as a cache-busting query param on the URL. */
  rev: number;
  /** The image's own pixel dimensions — the editor keeps this aspect ratio. */
  naturalWidth: number;
  naturalHeight: number;
  /** Centre of the image on the canvas, in canvas units. */
  position: Vec2;
  /** Size of the image on the canvas, in canvas units. */
  size: Vec2;
}

/**
 * Physical hardware setup for one device's data output (one continuous strip).
 * Used by the Hardware planning page to estimate power and injection points.
 * Keyed by `deviceId` in {@link Installation.outputs}.
 */
export interface OutputHardware {
  /** Id into `LED_TYPES` (see `@ewc/core` hardware/power). Unset = not planned yet. */
  ledTypeId?: string;
  /** Measured physical LED density (LEDs per metre); overrides the type's typical figure. */
  ledsPerMeter?: number;
}

export interface Installation {
  fixtures: Fixture[];
  /** Canvas dimensions in arbitrary units; only the aspect ratio matters. */
  canvas: { width: number; height: number };
  /** Optional room floorplan shown behind the fixtures (preview-only). */
  floorplan?: FloorplanRef;
  /** Per-output hardware planning, keyed by `deviceId`. Preview/planning only. */
  outputs?: Record<string, OutputHardware>;
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
    case 'shape':
      return Math.max(0, Math.floor(g.count));
  }
}

/** LED wire-index range `[startIndex, startIndex + count)` a fixture occupies. */
export function fixtureIndexRange(f: Fixture): [number, number] {
  return [f.startIndex, f.startIndex + fixtureLedCount(f.geometry)];
}

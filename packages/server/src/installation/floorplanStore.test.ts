import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fitToCanvas } from '../realtime/routes.js';
import { FloorplanStore } from './floorplanStore.js';

describe('FloorplanStore', () => {
  let dir: string;
  let store: FloorplanStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ewc-fp-'));
    store = new FloorplanStore(join(dir, 'floorplan'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writes a deterministic filename and reads back the bytes', () => {
    const bytes = Buffer.from([1, 2, 3, 4]);
    const asset = store.write(bytes, 'image/png');
    expect(asset).toBe('floorplan.png');
    expect(readFileSync(store.path(asset))).toEqual(bytes);
    expect(store.mimeFor(asset)).toBe('image/png');
  });

  it('replaces a previous file even across a different extension', () => {
    store.write(Buffer.from([1]), 'image/png');
    const asset = store.write(Buffer.from([2, 2]), 'image/jpeg');
    expect(asset).toBe('floorplan.jpg');
    const files = readdirSync(join(dir, 'floorplan'));
    expect(files).toEqual(['floorplan.jpg']); // the .png is gone
  });

  it('rejects an unsupported type', () => {
    expect(() => store.write(Buffer.from([1]), 'image/tiff')).toThrow();
  });

  it('clear() removes every stored floorplan file', () => {
    store.write(Buffer.from([1]), 'image/webp');
    store.clear();
    expect(existsSync(store.path('floorplan.webp'))).toBe(false);
  });
});

describe('fitToCanvas', () => {
  it('fits a wide image to the canvas width', () => {
    const { position, size } = fitToCanvas(2000, 400, { width: 16, height: 9 });
    expect(size.x).toBeCloseTo(16);
    expect(size.y).toBeCloseTo(3.2);
    expect(position).toEqual({ x: 8, y: 4.5 });
  });

  it('fits a tall image to the canvas height', () => {
    const { size } = fitToCanvas(400, 2000, { width: 16, height: 9 });
    expect(size.y).toBeCloseTo(9);
    expect(size.x).toBeCloseTo(1.8);
  });
});

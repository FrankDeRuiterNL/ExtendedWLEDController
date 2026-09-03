import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MediaStore } from './mediaStore.js';

describe('MediaStore', () => {
  let dir: string;
  let store: MediaStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ewc-media-'));
    store = new MediaStore(join(dir, 'media'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const rgba = (w: number, h: number) => Buffer.alloc(w * h * 4, 7);

  it('stores and reads back a blob with its metadata', () => {
    const asset = store.createImage(rgba(2, 3), { width: 2, height: 3, filename: 'plan.png' });
    expect(asset.id).toMatch(/^[A-Za-z0-9_-]+$/);

    const read = store.get(asset.id);
    expect(read).not.toBeNull();
    expect(read!.kind).toBe('image');
    expect(read!.width).toBe(2);
    expect(read!.height).toBe(3);
    expect(read!.filename).toBe('plan.png');
    if (!read || read.kind !== 'image') throw new Error('expected an image asset');
    expect(read.data).toEqual(rgba(2, 3));
  });

  it('rejects a blob whose length does not match w×h×4', () => {
    expect(() => store.createImage(Buffer.alloc(10), { width: 2, height: 2, filename: 'x' })).toThrow();
  });

  it('lists ids and removes assets', () => {
    const a = store.createImage(rgba(1, 1), { width: 1, height: 1, filename: 'a' });
    const b = store.createImage(rgba(1, 1), { width: 1, height: 1, filename: 'b' });
    expect(store.list().sort()).toEqual([a.id, b.id].sort());

    store.remove(a.id);
    expect(store.has(a.id)).toBe(false);
    expect(store.get(a.id)).toBeNull();
    expect(store.list()).toEqual([b.id]);
  });

  it('get() on an unknown id returns null', () => {
    expect(store.get('nope')).toBeNull();
  });
});

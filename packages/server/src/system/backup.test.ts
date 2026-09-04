import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../db/index.js';
import { applyRestore, buildBackupZip, RestoreError, validateRestoreZip } from './backup.js';

describe('backup / restore', () => {
  let root: string;
  let dataDir: string;
  let dbPath: string;
  let db: ReturnType<typeof openDb>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ewc-backup-'));
    dataDir = join(root, 'data');
    mkdirSync(join(dataDir, 'tmp'), { recursive: true });
    mkdirSync(join(dataDir, 'media'), { recursive: true });
    mkdirSync(join(dataDir, 'floorplan'), { recursive: true });
    dbPath = join(dataDir, 'ewc.sqlite');
    db = openDb(dbPath);
    db.prepare('INSERT INTO scenes (name, data_json) VALUES (?, ?)').run('Seed scene', '{}');
    writeFileSync(join(dataDir, 'media', 'abc.json'), '{"kind":"image"}');
    writeFileSync(join(dataDir, 'media', 'abc.rgba'), Buffer.alloc(16, 9));
    writeFileSync(join(dataDir, 'floorplan', 'floorplan.png'), Buffer.from([1, 2, 3, 4]));
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      /* a test may have closed it already */
    }
    rmSync(root, { recursive: true, force: true });
  });

  const makeZip = () =>
    buildBackupZip({
      db,
      tmpDir: join(dataDir, 'tmp'),
      mediaDir: join(dataDir, 'media'),
      floorplanDir: join(dataDir, 'floorplan'),
    }).zip;

  it('bundles the manifest, a DB snapshot and the blob dirs', () => {
    const entries = unzipSync(makeZip());
    expect(Object.keys(entries).sort()).toEqual(
      [
        'ewc.sqlite',
        'floorplan/floorplan.png',
        'manifest.json',
        'media/abc.json',
        'media/abc.rgba',
      ].sort(),
    );
    const manifest = JSON.parse(strFromU8(entries['manifest.json']!)) as {
      dbVersion: number;
      counts: Record<string, unknown>;
    };
    expect(manifest.counts).toMatchObject({ scenes: 1, mediaAssets: 1, hasFloorplan: true });
    expect(manifest.dbVersion).toBeGreaterThan(0);
  });

  it('the snapshot in the zip is a working DB with the seeded row', () => {
    const entries = unzipSync(makeZip());
    const out = join(root, 'roundtrip.sqlite');
    writeFileSync(out, entries['ewc.sqlite']!);
    const probe = new Database(out, { readonly: true });
    const row = probe.prepare('SELECT name FROM scenes').get() as { name: string };
    expect(row.name).toBe('Seed scene');
    probe.close();
  });

  it('validateRestoreZip accepts a real backup and stages its files', () => {
    const staged = validateRestoreZip(makeZip(), join(dataDir, 'tmp', 'restore-1'));
    expect(staged.manifest.counts.scenes).toBe(1);
    expect(readFileSync(staged.stagedDbPath).length).toBeGreaterThan(0);
    expect(staged.stagedMediaDir).not.toBeNull();
    expect(staged.stagedFloorplanDir).not.toBeNull();
  });

  it('rejects a zip with no database', () => {
    const zip = zipSync({ 'manifest.json': strToU8('{"app":"x","dbVersion":1}') });
    expect(() => validateRestoreZip(zip, join(dataDir, 'tmp', 'r2'))).toThrow(RestoreError);
  });

  it('rejects a backup from a newer schema version', () => {
    const future = join(root, 'future.sqlite');
    const fdb = new Database(future);
    fdb.pragma('user_version = 999');
    fdb.close();
    const zip = zipSync({
      'manifest.json': strToU8(JSON.stringify({ app: '9.9.9', dbVersion: 999 })),
      'ewc.sqlite': readFileSync(future),
    });
    expect(() => validateRestoreZip(zip, join(dataDir, 'tmp', 'r3'))).toThrow(/newer version/);
  });

  it('rejects a corrupt database', () => {
    const zip = zipSync({
      'manifest.json': strToU8(JSON.stringify({ app: '1.0.0', dbVersion: 1 })),
      'ewc.sqlite': strToU8('this is not a sqlite file at all'),
    });
    expect(() => validateRestoreZip(zip, join(dataDir, 'tmp', 'r4'))).toThrow(RestoreError);
  });

  it('applyRestore swaps the DB (keeping a .pre-restore copy) and the blob dirs', () => {
    const other = join(root, 'other');
    mkdirSync(join(other, 'media'), { recursive: true });
    mkdirSync(join(other, 'floorplan'), { recursive: true });
    mkdirSync(join(other, 'tmp'), { recursive: true });
    const otherDb = openDb(join(other, 'ewc.sqlite'));
    otherDb.prepare('INSERT INTO scenes (name, data_json) VALUES (?, ?)').run('Other scene', '{}');
    const zip = buildBackupZip({
      db: otherDb,
      tmpDir: join(other, 'tmp'),
      mediaDir: join(other, 'media'),
      floorplanDir: join(other, 'floorplan'),
    }).zip;
    otherDb.close();

    const staged = validateRestoreZip(zip, join(dataDir, 'tmp', 'apply'));
    db.close();
    applyRestore({
      staged,
      dbPath,
      mediaDir: join(dataDir, 'media'),
      floorplanDir: join(dataDir, 'floorplan'),
    });

    const reopened = openDb(dbPath);
    const names = reopened
      .prepare('SELECT name FROM scenes ORDER BY name')
      .all() as { name: string }[];
    expect(names.map((n) => n.name)).toEqual(['Other scene']);
    reopened.close();
    expect(readFileSync(`${dbPath}.pre-restore`).length).toBeGreaterThan(0);
    expect(() => readFileSync(join(dataDir, 'media', 'abc.rgba'))).toThrow();

    db = openDb(dbPath); // hand afterEach something valid to close
  });
});

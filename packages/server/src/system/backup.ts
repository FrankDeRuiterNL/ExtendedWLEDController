import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { APP_VERSION } from '@ewc/core';
import { LATEST_DB_VERSION } from '../db/migrations.js';
import type { Db } from '../db/index.js';

/**
 * Backup / restore of the whole install as one `.zip`:
 *
 *   manifest.json     — app version, schema version, counts, timestamp
 *   ewc.sqlite        — a consistent `VACUUM INTO` snapshot of the live DB
 *   media/<id>.*      — every Studio media blob + its meta
 *   floorplan/<file>  — the floorplan reference image
 *
 * The DB carries everything the user thinks of as "config" (devices, scenes,
 * rundown, installation, `app_settings`); the two blob dirs are the only state
 * that lives outside it, and they are coupled to it (a scene layer points at a
 * media `assetId`). So backup and restore are all-or-nothing — never one half.
 */

export interface BackupManifest {
  /** `APP_VERSION` that produced the backup — shown to the user, not a gate. */
  app: string;
  /** `PRAGMA user_version` of the DB in the backup — the real compatibility gate. */
  dbVersion: number;
  createdAt: string;
  counts: {
    devices: number;
    scenes: number;
    pixelScenes: number;
    mediaAssets: number;
    hasFloorplan: boolean;
  };
}

export class RestoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RestoreError';
  }
}

// --- backup ----------------------------------------------------------------

export interface BackupDeps {
  db: Db;
  /** Scratch dir for the VACUUM snapshot (wiped on boot). */
  tmpDir: string;
  mediaDir: string;
  floorplanDir: string;
}

const tableCount = (db: Db, table: string): number => {
  try {
    return (db.prepare(`SELECT count(*) AS c FROM ${table}`).get() as { c: number }).c;
  } catch {
    return 0;
  }
};

function dirEntries(dir: string, prefix: string): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    try {
      out[`${prefix}/${name}`] = readFileSync(join(dir, name));
    } catch {
      /* skip anything unreadable */
    }
  }
  return out;
}

export function buildBackupZip(deps: BackupDeps): { zip: Uint8Array; manifest: BackupManifest } {
  const floorplanFiles =
    existsSync(deps.floorplanDir) &&
    readdirSync(deps.floorplanDir).some((n) => n.startsWith('floorplan.'));

  const manifest: BackupManifest = {
    app: APP_VERSION,
    dbVersion: deps.db.pragma('user_version', { simple: true }) as number,
    createdAt: new Date().toISOString(),
    counts: {
      devices: tableCount(deps.db, 'devices'),
      scenes: tableCount(deps.db, 'scenes'),
      pixelScenes: tableCount(deps.db, 'pixel_scenes'),
      mediaAssets: existsSync(deps.mediaDir)
        ? readdirSync(deps.mediaDir).filter((n) => n.endsWith('.json')).length
        : 0,
      hasFloorplan: floorplanFiles,
    },
  };

  if (!existsSync(deps.tmpDir)) mkdirSync(deps.tmpDir, { recursive: true });
  const snapshot = join(deps.tmpDir, `backup-${randomBytes(9).toString('hex')}.sqlite`);
  try {
    // VACUUM INTO writes one clean, self-consistent file even with the live WAL
    // active — no need to checkpoint or pause writers first.
    deps.db.prepare('VACUUM INTO ?').run(snapshot);
    const files: Record<string, Uint8Array> = {
      'manifest.json': strToU8(JSON.stringify(manifest, null, 2)),
      'ewc.sqlite': readFileSync(snapshot),
      ...dirEntries(deps.mediaDir, 'media'),
      ...dirEntries(deps.floorplanDir, 'floorplan'),
    };
    return { zip: zipSync(files, { level: 6 }), manifest };
  } finally {
    rmSync(snapshot, { force: true });
  }
}

// --- restore -------------------------------------------------------------

export interface StagedRestore {
  manifest: BackupManifest;
  /** `<dataDir>/tmp/restore-<rand>` — holds the validated files until applied. */
  stagingDir: string;
  /** Validated `ewc.sqlite` inside `stagingDir`. */
  stagedDbPath: string;
  /** `stagingDir/media` if the backup carried any, else null. */
  stagedMediaDir: string | null;
  /** `stagingDir/floorplan` if the backup carried one, else null. */
  stagedFloorplanDir: string | null;
}

/**
 * Unpack an uploaded backup into `stagingDir` and prove it can actually be run,
 * touching nothing outside `stagingDir`. Throws {@link RestoreError} with a
 * user-facing message on any problem; the caller returns that as a 422.
 */
export function validateRestoreZip(buffer: Uint8Array, stagingDir: string): StagedRestore {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(buffer);
  } catch {
    throw new RestoreError('That file is not a valid .zip backup.');
  }

  const manifestRaw = entries['manifest.json'];
  if (!manifestRaw) {
    throw new RestoreError('The backup has no manifest.json — it was not made by this app.');
  }
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(strFromU8(manifestRaw)) as BackupManifest;
  } catch {
    throw new RestoreError('The backup manifest is corrupt.');
  }
  if (typeof manifest.dbVersion !== 'number' || typeof manifest.app !== 'string') {
    throw new RestoreError('The backup manifest is missing required fields.');
  }

  const dbEntry = entries['ewc.sqlite'];
  if (!dbEntry) throw new RestoreError('The backup contains no database.');

  rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(stagingDir, { recursive: true });

  const stagedDbPath = join(stagingDir, 'ewc.sqlite');
  writeFileSync(stagedDbPath, dbEntry);

  // Open it read-only and prove it's a sane SQLite file this build can run.
  let probe: Database.Database | null = null;
  try {
    probe = new Database(stagedDbPath, { readonly: true });
    const integrity = probe.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') {
      throw new RestoreError('The backup database failed its integrity check.');
    }
    const v = probe.pragma('user_version', { simple: true }) as number;
    if (v > LATEST_DB_VERSION) {
      throw new RestoreError(
        `This backup is from a newer version of the app (schema v${v}); this build understands up to v${LATEST_DB_VERSION}. Update the app first.`,
      );
    }
  } catch (err) {
    if (err instanceof RestoreError) throw err;
    throw new RestoreError('The backup database could not be opened.');
  } finally {
    probe?.close();
  }

  // Extract the blob dirs. Entry names come from our own zipSync as bare
  // basenames, but guard a hand-crafted archive against path traversal.
  let stagedMediaDir: string | null = null;
  let stagedFloorplanDir: string | null = null;
  for (const [name, bytes] of Object.entries(entries)) {
    const m = /^(media|floorplan)\/(.+)$/.exec(name);
    if (!m) continue;
    const kind = m[1]!;
    const file = m[2]!;
    if (file.includes('/') || file.includes('\\') || file.startsWith('.')) continue;
    const dir = join(stagingDir, kind);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, file), bytes);
    if (kind === 'media') stagedMediaDir = dir;
    else stagedFloorplanDir = dir;
  }

  return { manifest, stagingDir, stagedDbPath, stagedMediaDir, stagedFloorplanDir };
}

export interface ApplyRestoreDeps {
  staged: StagedRestore;
  /** Live paths to replace. */
  dbPath: string;
  mediaDir: string;
  floorplanDir: string;
}

/**
 * Swap the validated files into place. **Only call after `db.close()` and the
 * live services are torn down** — a running DDP loop reads rows about to change.
 * Every move is a `rename` within the data dir (one filesystem), so the window
 * where the install is half-swapped is a few syscalls wide.
 */
export function applyRestore(deps: ApplyRestoreDeps): void {
  const { staged } = deps;

  // DB — keep one rollback copy, drop the stale WAL/SHM (a leftover WAL over a
  // fresh DB file makes SQLite refuse to open or replay garbage), move it in.
  rmSync(`${deps.dbPath}.pre-restore`, { force: true });
  if (existsSync(deps.dbPath)) renameSync(deps.dbPath, `${deps.dbPath}.pre-restore`);
  rmSync(`${deps.dbPath}-wal`, { force: true });
  rmSync(`${deps.dbPath}-shm`, { force: true });
  renameSync(staged.stagedDbPath, deps.dbPath);

  swapDir(staged.stagedMediaDir, deps.mediaDir);
  swapDir(staged.stagedFloorplanDir, deps.floorplanDir);

  rmSync(staged.stagingDir, { recursive: true, force: true });
}

function swapDir(stagedDir: string | null, liveDir: string): void {
  rmSync(liveDir, { recursive: true, force: true });
  if (stagedDir && existsSync(stagedDir)) renameSync(stagedDir, liveDir);
  else mkdirSync(liveDir, { recursive: true });
}

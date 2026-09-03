import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { log } from '../logger.js';
import { migrate } from './migrations.js';

export type Db = Database.Database;

export function openDb(dbPath: string): Db {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  const { from, to } = migrate(db);
  if (from !== to) log.info(`database migrated ${from} → ${to}`, { dbPath });
  else log.debug(`database at version ${to}`, { dbPath });

  return db;
}

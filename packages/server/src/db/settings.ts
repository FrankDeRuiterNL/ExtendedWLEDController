import type { Db } from './index.js';

/** Tiny typed key/value store on `app_settings`. */
export class SettingsStore {
  constructor(private readonly db: Db) {}

  get<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value_json FROM app_settings WHERE key = ?').get(key) as
      | { value_json: string }
      | undefined;
    if (!row) return fallback;
    try {
      return JSON.parse(row.value_json) as T;
    } catch {
      return fallback;
    }
  }

  set(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO app_settings (key, value_json) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = datetime('now')`,
      )
      .run(key, JSON.stringify(value));
  }
}

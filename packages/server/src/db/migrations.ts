import type BetterSqlite3 from 'better-sqlite3';

export interface Migration {
  version: number;
  name: string;
  up: (db: BetterSqlite3.Database) => void;
}

/**
 * Ordered, forward-only migrations. `PRAGMA user_version` tracks the applied
 * version. Never edit an existing migration — add a new one.
 *
 * Milestone note: the fixture / mapping tables (Installation → Device → Fixture
 * → Geometry/Transform) are deliberately NOT here yet — they arrive in
 * milestone 3 when the model is designed for real. Realtime addressing and
 * device-side segments are kept as separate concerns; nothing in this schema
 * couples them.
 */
export const migrations: Migration[] = [
  {
    version: 1,
    name: 'initial device registry',
    up: (db) => {
      db.exec(`
        CREATE TABLE devices (
          id                      INTEGER PRIMARY KEY AUTOINCREMENT,
          name                    TEXT    NOT NULL,
          host                    TEXT    NOT NULL,
          port                    INTEGER NOT NULL DEFAULT 80,
          mac                     TEXT,
          -- 'wifi' | 'ethernet' | 'unknown'. Set by the user when adding;
          -- drives the realtime frame-rate budget in milestone 3.
          link_type               TEXT    NOT NULL DEFAULT 'unknown',
          enabled                 INTEGER NOT NULL DEFAULT 1,

          -- capability snapshot, refreshed from /json/{info,eff,pal,fxdata,cfg}
          arch                    TEXT,
          fw_version              TEXT,
          led_count               INTEGER,
          matrix_w                INTEGER,
          matrix_h                INTEGER,
          seglc_json              TEXT,
          lc                      INTEGER,
          fxcount                 INTEGER,
          palcount                INTEGER,
          fs_total_kb             INTEGER,
          fs_used_kb              INTEGER,
          ws_supported            INTEGER,
          -- 0 when /json/fxdata had to be salvaged past device truncation
          fxdata_complete         INTEGER NOT NULL DEFAULT 1,
          -- full DeviceWarning[] as JSON, recomputed on every import
          warnings_json           TEXT NOT NULL DEFAULT '[]',

          -- realtime / DDP preparation (milestone 3) — captured now
          dmx_start_address       INTEGER NOT NULL DEFAULT 0,
          dmx_universe            INTEGER,
          dmx_mode                INTEGER,
          realtime_timeout_ms     INTEGER,
          realtime_gamma_disabled INTEGER,
          realtime_forces_max_bri INTEGER,
          realtime_offset         INTEGER NOT NULL DEFAULT 0,

          -- brightness / gamma non-negotiable — per-device policy
          brightness_policy_json  TEXT NOT NULL DEFAULT '{"mode":"passthrough","softwareGamma":null}',
          device_gamma_json       TEXT,

          -- raw payloads, kept for debugging and re-parse after a core update
          raw_info_json           TEXT,
          raw_state_json          TEXT,
          raw_cfg_json            TEXT,
          raw_eff_json            TEXT,
          raw_pal_json            TEXT,
          raw_fxdata_json         TEXT,

          last_import_at          TEXT,
          created_at              TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at              TEXT NOT NULL DEFAULT (datetime('now')),

          UNIQUE (host, port)
        );

        CREATE UNIQUE INDEX idx_devices_mac ON devices (mac) WHERE mac IS NOT NULL;

        CREATE TABLE device_health (
          device_id    INTEGER PRIMARY KEY REFERENCES devices (id) ON DELETE CASCADE,
          online       INTEGER NOT NULL DEFAULT 0,
          last_seen_at TEXT,
          last_error   TEXT,
          fps          INTEGER,
          freeheap     INTEGER,
          wifi_signal  INTEGER,
          uptime_s     INTEGER,
          live         INTEGER,
          ws_clients   INTEGER,
          checked_at   TEXT
        );

        -- Scenes live in SQLite (per the project decision). Populated in
        -- milestone 4; the table exists now so the store is stable.
        CREATE TABLE scenes (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          name       TEXT NOT NULL,
          data_json  TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
    },
  },
  {
    version: 2,
    name: 'milestone 3 — managed DMX patch + fixture mapping',
    up: (db) => {
      db.exec(`
        -- App-assigned E1.31 allocation (DmxAllocation JSON + managed flag).
        -- Written to the device's cfg.if.live.dmx on add / replan.
        ALTER TABLE devices ADD COLUMN dmx_plan_json TEXT;
        ALTER TABLE devices ADD COLUMN dmx_managed INTEGER NOT NULL DEFAULT 1;

        -- One installation (single-user app). Row id is always 1.
        CREATE TABLE installation (
          id          INTEGER PRIMARY KEY CHECK (id = 1),
          data_json   TEXT NOT NULL DEFAULT '{"fixtures":[],"canvas":{"width":16,"height":9}}',
          updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO installation (id) VALUES (1);

        CREATE TABLE app_settings (
          key         TEXT PRIMARY KEY,
          value_json  TEXT NOT NULL,
          updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
    },
  },
  {
    version: 3,
    name: 'milestone 4 — ethernet link speed',
    up: (db) => {
      // WLED's JSON API doesn't report the negotiated ethernet PHY speed, so it
      // is a per-device value (10 / 100 / 1000 Mbps). NULL = unknown; the UI
      // assumes 100 for an ethernet device that hasn't been set.
      db.exec(`ALTER TABLE devices ADD COLUMN eth_speed_mbps INTEGER;`);
    },
  },
  {
    version: 4,
    name: 'milestone 5 — pixel scenes',
    up: (db) => {
      // A saved pixel-painter canvas: the whole {@link PixelScene} (width,
      // brightness, per-LED hex/null array) lives in data_json. Device-agnostic
      // — loaded onto whichever device/segment is selected on the Paint page.
      db.exec(`
        CREATE TABLE pixel_scenes (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          name       TEXT NOT NULL,
          data_json  TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
    },
  },
  {
    version: 5,
    name: 'milestone 9 — rundown',
    up: (db) => {
      // One rundown for now (single-user app), row id always 1 — same shape as
      // `installation`. The whole {@link Rundown} (ordered cue list) lives in
      // data_json; playback is a live-only concern owned by the RundownEngine.
      db.exec(`
        CREATE TABLE rundown (
          id          INTEGER PRIMARY KEY CHECK (id = 1),
          data_json   TEXT NOT NULL DEFAULT '{"cues":[]}',
          updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO rundown (id) VALUES (1);
      `);
    },
  },
];

/**
 * The newest schema version this build knows how to run. A backup whose DB
 * `user_version` is higher than this cannot be restored — migrations are
 * forward-only, so an older binary can't step a newer schema back down.
 */
export const LATEST_DB_VERSION = migrations[migrations.length - 1]!.version;

export function migrate(db: BetterSqlite3.Database): { from: number; to: number } {
  const from = db.pragma('user_version', { simple: true }) as number;
  const pending = migrations.filter((m) => m.version > from).sort((a, b) => a.version - b.version);

  for (const m of pending) {
    const tx = db.transaction(() => {
      m.up(db);
      db.pragma(`user_version = ${m.version}`);
    });
    tx();
  }

  const to = db.pragma('user_version', { simple: true }) as number;
  return { from, to };
}

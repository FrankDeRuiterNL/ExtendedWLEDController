import { resolve } from 'node:path';

/** Runtime configuration, all overridable by environment variable. */
export interface Config {
  nodeEnv: 'development' | 'production' | 'test';
  /** Port the HTTP server listens on. */
  port: number;
  /** Bind address. */
  host: string;
  /** Directory for the SQLite database and any future mounted state. */
  dataDir: string;
  /** Absolute path to the SQLite file. */
  dbPath: string;
  /** Directory containing the built web client (served in production). */
  webDir: string | null;
  /** How often the health poller hits `/json/info` per device, ms. */
  healthPollIntervalMs: number;
  /** Per-request timeout when talking to a WLED device, ms. */
  wledHttpTimeoutMs: number;
  /** Retries for truncation-prone bulk endpoints (`/json/fxdata`, `/json/cfg`). */
  wledBulkRetries: number;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`env ${name} must be a number, got ${JSON.stringify(raw)}`);
  return n;
}

export function loadConfig(): Config {
  const nodeEnv = (process.env.NODE_ENV as Config['nodeEnv']) || 'development';
  const dataDir = resolve(process.env.EWC_DATA_DIR ?? './data');
  return {
    nodeEnv,
    port: int('EWC_PORT', 8080),
    host: process.env.EWC_HOST ?? '0.0.0.0',
    dataDir,
    dbPath: process.env.EWC_DB_PATH ? resolve(process.env.EWC_DB_PATH) : resolve(dataDir, 'ewc.sqlite'),
    webDir: process.env.EWC_WEB_DIR ? resolve(process.env.EWC_WEB_DIR) : null,
    healthPollIntervalMs: int('EWC_HEALTH_POLL_MS', 15_000),
    wledHttpTimeoutMs: int('EWC_WLED_TIMEOUT_MS', 5_000),
    wledBulkRetries: int('EWC_WLED_BULK_RETRIES', 15),
  };
}

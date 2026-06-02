/**
 * sqlite-store.ts — Persistent 1-hour event history using sql.js (pure WASM).
 *
 * The ring buffer holds the last 200 events in memory (fast, O(1)).
 * This store supplements it with a SQLite database that retains ALL events
 * from the last hour, enabling /replay queries that go further back.
 *
 * Uses sql.js (pure JS/WASM) — no native compilation required.
 */

import initSqlJs, { type Database } from 'sql.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createRequire } from 'module';
import { DATA_DIR, HISTORY_DB } from './paths.js';
import type { BrowserEvent } from './buffer.js';
import logger from './logger.js';

const ONE_HOUR_MS = (() => {
  const h = parseFloat(process.env.MERGEN_RETENTION_HOURS ?? '1');
  return (Number.isFinite(h) && h > 0 ? Math.min(h, 72) : 1) * 60 * 60 * 1_000;
})();
// Persist to disk every N writes to avoid fsync overhead on every event.
const FLUSH_EVERY = 50;

class SqliteHistoryStore {
  private db: Database | null = null;
  private writeCount = 0;
  private wasmPath: string;

  constructor() {
    this.wasmPath = SqliteHistoryStore.resolveWasmPath();
  }

  /**
   * Locate sql-wasm.wasm using multiple strategies so the server works
   * regardless of where the binary is installed or run from.
   *
   * Priority:
   *   1. MERGEN_WASM_PATH env var (explicit override for Docker / custom installs)
   *   2. Relative to this compiled module (standard npm install layout)
   *   3. Node module resolution via createRequire — works for monorepos and
   *      global installs where the relative path doesn't exist
   */
  private static resolveWasmPath(): string {
    if (process.env.MERGEN_WASM_PATH) return process.env.MERGEN_WASM_PATH;

    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    const fromModule = path.resolve(moduleDir, '../../node_modules/sql.js/dist/sql-wasm.wasm');
    if (fs.existsSync(fromModule)) return fromModule;

    try {
      // createRequire resolves against this file's location — safe for ESM.
      const req = createRequire(import.meta.url);
      const sqlJsEntry = req.resolve('sql.js');
      const resolved = path.join(path.dirname(sqlJsEntry), 'sql-wasm.wasm');
      if (fs.existsSync(resolved)) return resolved;
    } catch {
      /* sql.js not resolvable from this location */
    }

    // Fall back to the computed relative path; init() will log a clear error
    // if the file is still missing so the operator knows exactly what to set.
    return fromModule;
  }

  async init(): Promise<void> {
    try {
      const wasmBinary = fs.readFileSync(this.wasmPath);
      const SQL = await initSqlJs({ wasmBinary });

      fs.mkdirSync(DATA_DIR, { recursive: true });

      // Load existing DB file or create a fresh one
      let fileBuffer: Buffer | undefined;
      if (fs.existsSync(HISTORY_DB)) {
        try {
          fileBuffer = fs.readFileSync(HISTORY_DB);
        } catch {
          // Corrupted file — start fresh
          logger.warn('history.db unreadable, starting fresh');
        }
      }

      this.db = fileBuffer ? new SQL.Database(fileBuffer) : new SQL.Database();

      this.db.run(`
        CREATE TABLE IF NOT EXISTS events (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          type       TEXT    NOT NULL,
          level      TEXT,
          data       TEXT    NOT NULL,
          timestamp  INTEGER NOT NULL,
          inserted_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_timestamp ON events(timestamp);
        CREATE INDEX IF NOT EXISTS idx_inserted_at ON events(inserted_at);
      `);

      this.flush(); // Persist schema creation immediately
      logger.info({ path: HISTORY_DB }, 'SQLite history store initialised');
    } catch (err) {
      logger.warn(
        { err, wasmPath: this.wasmPath },
        'SQLite history store failed to initialise — replay unavailable. ' +
        'Set MERGEN_WASM_PATH to override the wasm location.',
      );
      this.db = null;
    }
  }

  push(event: BrowserEvent): void {
    if (!this.db) return;

    try {
      const level =
        event.type === 'console' ? event.level :
        event.type === 'network' ? String(event.status) : null;

      this.db.run(
        'INSERT INTO events (type, level, data, timestamp, inserted_at) VALUES (?,?,?,?,?)',
        [event.type, level, JSON.stringify(event), event.timestamp, Date.now()],
      );
      this.writeCount++;

      this.pruneOld();

      if (this.writeCount % FLUSH_EVERY === 0) {
        this.flush();
      }
    } catch (err) {
      logger.warn({ err }, 'SQLite push failed');
    }
  }

  query(opts: {
    since?: number;
    limit?: number;
    level?: string;
    type?: string;
  }): BrowserEvent[] {
    if (!this.db) return [];

    try {
      const { since = 0, limit = 500, level, type } = opts;
      const conditions: string[] = ['timestamp >= ?'];
      const params: (number | string)[] = [since];

      if (level) { conditions.push('level = ?'); params.push(level); }
      if (type)  { conditions.push('type = ?');  params.push(type); }

      const sql =
        `SELECT data FROM events WHERE ${conditions.join(' AND ')} ` +
        `ORDER BY timestamp ASC LIMIT ?`;
      params.push(limit);

      const stmt = this.db.prepare(sql);
      stmt.bind(params);
      const rows: BrowserEvent[] = [];
      while (stmt.step()) {
        try {
          rows.push(JSON.parse(stmt.getAsObject()['data'] as string));
        } catch { /* skip corrupt rows */ }
      }
      stmt.free();
      return rows;
    } catch (err) {
      logger.warn({ err }, 'SQLite query failed');
      return [];
    }
  }

  size(): number {
    if (!this.db) return 0;
    try {
      const result = this.db.exec('SELECT COUNT(*) FROM events');
      return (result[0]?.values[0]?.[0] as number) ?? 0;
    } catch { return 0; }
  }

  clear(): void {
    if (!this.db) return;
    try {
      this.db.run('DELETE FROM events');
      this.flush();
    } catch (err) {
      logger.warn({ err }, 'SQLite clear failed');
    }
  }

  private pruneOld(): void {
    if (!this.db) return;
    const cutoff = Date.now() - ONE_HOUR_MS;
    this.db.run('DELETE FROM events WHERE inserted_at < ?', [cutoff]);
  }

  private flush(): void {
    if (!this.db) return;
    try {
      const data = this.db.export();
      fs.writeFileSync(HISTORY_DB, Buffer.from(data));
    } catch (err) {
      logger.warn({ err }, 'SQLite flush failed');
    }
  }
}

export const historyStore = new SqliteHistoryStore();

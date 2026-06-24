/**
 * audit-log.ts — Structured compliance ledger database and file logging.
 *
 * Logs all non-trivial HTTP requests and autonomous executions to a SQLite
 * database (~/.mergen/audit.db) and rolls a backup text log (~/.mergen/audit.log).
 *
 * Provides structured query interfaces for enterprise compliance reports.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import type { Request, Response, NextFunction } from 'express';
import initSqlJs, { type Database } from 'sql.js';
import { AUDIT_LOG, AUDIT_DB, DATA_DIR } from './paths.js';
import logger from './logger.js';

const MAX_AUDIT_BYTES = 10 * 1024 * 1024; // 10 MB
const SKIP_PATHS = new Set(['/', '/health', '/metrics', '/dashboard', '/local-secret']);

export interface AuditEntry {
  ts: string;
  actor: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  ip: string;
}

export interface ExecutionAuditEntry {
  ts: string;
  event: string;
  actor: string;
  cmd: string;
  ok: boolean;
  exitCode: number;
  durationMs: number;
  blocked: boolean;
  blockReason: string;
  timedOut: boolean;
}

class ComplianceLedgerStore {
  private db: Database | null = null;

  private resolveWasmPath(): string {
    if (process.env.MERGEN_WASM_PATH) return process.env.MERGEN_WASM_PATH;
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    const fromModule = path.resolve(moduleDir, '../../node_modules/sql.js/dist/sql-wasm.wasm');
    if (fs.existsSync(fromModule)) return fromModule;
    try {
      const req = createRequire(import.meta.url);
      const resolved = path.join(path.dirname(req.resolve('sql.js')), 'sql-wasm.wasm');
      if (fs.existsSync(resolved)) return resolved;
    } catch {}
    return fromModule;
  }

  async init(): Promise<void> {
    try {
      const wasmBinary = fs.readFileSync(this.resolveWasmPath());
      const SQL = await initSqlJs({ wasmBinary });
      fs.mkdirSync(DATA_DIR, { recursive: true });

      let fileBuffer: Buffer | undefined;
      if (fs.existsSync(AUDIT_DB)) {
        try { fileBuffer = fs.readFileSync(AUDIT_DB); } catch {}
      }
      this.db = fileBuffer ? new SQL.Database(fileBuffer) : new SQL.Database();

      this.db.run(`
        CREATE TABLE IF NOT EXISTS http_audit (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          ts          TEXT NOT NULL,
          actor       TEXT NOT NULL,
          method      TEXT NOT NULL,
          path        TEXT NOT NULL,
          status      INTEGER NOT NULL,
          duration_ms INTEGER NOT NULL,
          ip          TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS execution_audit (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          ts           TEXT NOT NULL,
          event        TEXT NOT NULL,
          actor        TEXT NOT NULL,
          cmd          TEXT NOT NULL,
          ok           INTEGER NOT NULL,
          exit_code    INTEGER NOT NULL,
          duration_ms  INTEGER NOT NULL,
          blocked      INTEGER NOT NULL,
          block_reason TEXT NOT NULL,
          timed_out    INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_http_audit_ts ON http_audit (ts);
        CREATE INDEX IF NOT EXISTS idx_execution_audit_ts ON execution_audit (ts);
      `);

      this.flush();
      logger.info({ path: AUDIT_DB }, 'Compliance ledger SQLite store initialised');
    } catch (err) {
      logger.error({ err }, 'Compliance ledger store failed to initialize');
    }
  }

  private flush(): void {
    if (!this.db) return;
    try {
      const data = this.db.export();
      fs.writeFileSync(AUDIT_DB, Buffer.from(data));
    } catch (err) {
      logger.warn({ err }, 'Compliance ledger store flush failed');
    }
  }

  insertHttp(entry: AuditEntry): void {
    if (!this.db) return;
    try {
      this.db.run(
        `INSERT INTO http_audit (ts, actor, method, path, status, duration_ms, ip) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [entry.ts, entry.actor, entry.method, entry.path, entry.status, entry.durationMs, entry.ip],
      );
      this.flush();
    } catch (err) {
      logger.warn({ err }, 'Failed to insert HTTP audit record');
    }
  }

  insertExecution(entry: ExecutionAuditEntry): void {
    if (!this.db) return;
    try {
      this.db.run(
        `INSERT INTO execution_audit (ts, event, actor, cmd, ok, exit_code, duration_ms, blocked, block_reason, timed_out)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          entry.ts,
          entry.event,
          entry.actor,
          entry.cmd,
          entry.ok ? 1 : 0,
          entry.exitCode,
          entry.durationMs,
          entry.blocked ? 1 : 0,
          entry.blockReason,
          entry.timedOut ? 1 : 0,
        ],
      );
      this.flush();
    } catch (err) {
      logger.warn({ err }, 'Failed to insert execution audit record');
    }
  }

  getHttpEntries(limit = 200): AuditEntry[] {
    if (!this.db) return [];
    try {
      const res = this.db.exec(`SELECT ts, actor, method, path, status, duration_ms, ip FROM http_audit ORDER BY ts DESC LIMIT ?`, [limit]);
      if (res.length === 0) return [];
      return res[0].values.map((row) => ({
        ts: String(row[0]),
        actor: String(row[1]),
        method: String(row[2]),
        path: String(row[3]),
        status: Number(row[4]),
        durationMs: Number(row[5]),
        ip: String(row[6]),
      }));
    } catch (err) {
      logger.warn({ err }, 'Failed to query HTTP audit entries');
      return [];
    }
  }

  getExecutionEntries(limit = 200): ExecutionAuditEntry[] {
    if (!this.db) return [];
    try {
      const res = this.db.exec(
        `SELECT ts, event, actor, cmd, ok, exit_code, duration_ms, blocked, block_reason, timed_out
         FROM execution_audit ORDER BY ts DESC LIMIT ?`,
        [limit],
      );
      if (res.length === 0) return [];
      return res[0].values.map((row) => ({
        ts: String(row[0]),
        event: String(row[1]),
        actor: String(row[2]),
        cmd: String(row[3]),
        ok: Number(row[4]) === 1,
        exitCode: Number(row[5]),
        durationMs: Number(row[6]),
        blocked: Number(row[7]) === 1,
        blockReason: String(row[8]),
        timedOut: Number(row[9]) === 1,
      }));
    } catch (err) {
      logger.warn({ err }, 'Failed to query execution audit entries');
      return [];
    }
  }
}

export const complianceLedgerStore = new ComplianceLedgerStore();

function resolveActor(req: Request): string {
  const member = req.headers['x-mergen-member'] as string | undefined;
  if (member) return member;
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

let _writeQueue: Promise<void> = Promise.resolve();
let _lastAuditWriteError: string | null = null;
let _auditWriteOk = true;

/** Returns the current audit log health — use in /audit-health or monitoring checks. */
export function getAuditHealth(): { ok: boolean; lastError: string | null } {
  return { ok: _auditWriteOk, lastError: _lastAuditWriteError };
}

async function appendEntryAsync(entry: AuditEntry): Promise<void> {
  try {
    await fs.promises.mkdir(DATA_DIR, { recursive: true });
    try {
      const stat = await fs.promises.stat(AUDIT_LOG);
      if (stat.size >= MAX_AUDIT_BYTES) {
        const rotated = AUDIT_LOG + '.1';
        try { await fs.promises.unlink(rotated); } catch { /* ignore */ }
        await fs.promises.rename(AUDIT_LOG, rotated);
      }
    } catch { /* file doesn't exist yet */ }
    await fs.promises.appendFile(AUDIT_LOG, JSON.stringify(entry) + '\n', 'utf8');
    _auditWriteOk = true;
    _lastAuditWriteError = null;
  } catch (err) {
    _auditWriteOk = false;
    _lastAuditWriteError = err instanceof Error ? err.message : String(err);
    logger.error({ err }, 'audit-log: write failed — record dropped');
  }
}

function appendEntry(entry: AuditEntry): void {
  // Save to SQLite
  complianceLedgerStore.insertHttp(entry);
  // Keep file logging as raw fallback
  _writeQueue = _writeQueue.then(() => appendEntryAsync(entry)).catch((err) => {
    _auditWriteOk = false;
    _lastAuditWriteError = err instanceof Error ? err.message : String(err);
    logger.error({ err }, 'audit-log: write queue error — record dropped');
  });
}

export function auditMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (SKIP_PATHS.has(req.path) || req.path.startsWith('/dashboard')) { next(); return; }
  const start = Date.now();
  res.on('finish', () => {
    appendEntry({
      ts:         new Date().toISOString(),
      actor:      resolveActor(req),
      method:     req.method,
      path:       req.path,
      status:     res.statusCode,
      durationMs: Date.now() - start,
      ip:         req.ip ?? req.socket.remoteAddress ?? 'unknown',
    });
  });
  next();
}

export function getAuditLog(limit = 200): AuditEntry[] {
  const sqliteEntries = complianceLedgerStore.getHttpEntries(limit);
  if (sqliteEntries.length > 0) return sqliteEntries;

  // Fallback to file reading if SQLite fails or is not ready
  try {
    const raw   = fs.readFileSync(AUDIT_LOG, 'utf8');
    const lines = raw.trim().split('\n').filter(Boolean);
    return lines.slice(-Math.min(limit, 2000)).map(l => JSON.parse(l) as AuditEntry).reverse();
  } catch {
    return [];
  }
}

/** Record execution event into structured SQLite and append to file audit log */
export function recordExecutionAudit(entry: ExecutionAuditEntry): void {
  complianceLedgerStore.insertExecution(entry);

  const fileEntry = JSON.stringify({
    t: entry.ts,
    event: entry.event,
    actor: entry.actor,
    cmd: entry.cmd,
    ok: entry.ok,
    exitCode: entry.exitCode,
    durationMs: entry.durationMs,
    blocked: entry.blocked,
    blockReason: entry.blockReason,
    timedOut: entry.timedOut,
  });

  _writeQueue = _writeQueue.then(async () => {
    try {
      await fs.promises.mkdir(DATA_DIR, { recursive: true });
      await fs.promises.appendFile(AUDIT_LOG, fileEntry + '\n', 'utf8');
      _auditWriteOk = true;
      _lastAuditWriteError = null;
    } catch (err) {
      _auditWriteOk = false;
      _lastAuditWriteError = err instanceof Error ? err.message : String(err);
      logger.error({ err }, 'audit-log: execution record write failed — record dropped');
    }
  }).catch((err) => {
    _auditWriteOk = false;
    _lastAuditWriteError = err instanceof Error ? err.message : String(err);
    logger.error({ err }, 'audit-log: write queue error on execution record');
  });
}

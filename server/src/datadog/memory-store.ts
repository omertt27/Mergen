/**
 * memory-store.ts — Phase 2 Incident Memory Layer.
 *
 * Two-table schema (deliberately separated from day one):
 *
 *  incident_memory   — org-private: full trace context, file/line, PR URL, raw fact
 *  incident_benchmarks — benchmark-eligible: fingerprint + MTTR + resolution_type only
 *
 * The benchmark table can safely be aggregated across orgs (opt-in).
 * The memory table never leaves the local machine.
 */

import initSqlJs, { type Database } from 'sql.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { DATA_DIR } from '../sensor/paths.js';
import logger from '../sensor/logger.js';

const MEMORY_DB = path.join(DATA_DIR, 'incident-memory.db');

// 30-minute default causality window for GitHub PR correlation
export const DEFAULT_CAUSALITY_WINDOW_MS = (() => {
  const minutes = parseInt(process.env.MERGEN_CAUSALITY_WINDOW_MIN ?? '30', 10);
  return (Number.isFinite(minutes) ? Math.min(Math.max(minutes, 5), 120) : 30) * 60_000;
})();

export type ResolutionType =
  | 'flag_rollback'
  | 'hotfix_deploy'
  | 'config_change'
  | 'rollback_deploy'
  | 'unknown';

export interface IncidentMemoryRecord {
  id: number;
  fingerprint: string;
  service: string;
  endpoint: string;
  errorType: string;
  errorMessage: string;
  implicatedFile: string | null;
  implicatedLine: number | null;
  deployedSha: string | null;
  firedAt: number;
  resolvedAt: number | null;
  mttrMs: number | null;
  pdIncidentId: string | null;
  pdAlertTitle: string;
  pdAlertUrl: string | null;
  traceId: string;
  fixPrUrl: string | null;
  fixPrTitle: string | null;
  fixPrSha: string | null;
  fixSummary: string | null;
  resolutionType: ResolutionType;
  rawFact: string | null;
}

export interface BenchmarkStats {
  fingerprint: string;
  occurrences: number;
  p50MttrMs: number | null;
  p90MttrMs: number | null;
  topResolutionType: ResolutionType;
  topResolutionCount: number;
  lastSeenAt: number | null;
}

class IncidentMemoryStore {
  private db: Database | null = null;

  private resolveWasmPath(): string {
    if (process.env.MERGEN_WASM_PATH) return process.env.MERGEN_WASM_PATH;
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    const fromModule = path.resolve(moduleDir, '../../../node_modules/sql.js/dist/sql-wasm.wasm');
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

      let buf: Buffer | undefined;
      if (fs.existsSync(MEMORY_DB)) {
        try { buf = fs.readFileSync(MEMORY_DB); } catch {}
      }

      this.db = buf ? new SQL.Database(buf) : new SQL.Database();

      this.db.run(`
        CREATE TABLE IF NOT EXISTS incident_memory (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          fingerprint       TEXT    NOT NULL,
          service           TEXT    NOT NULL,
          endpoint          TEXT    NOT NULL,
          error_type        TEXT    NOT NULL DEFAULT '',
          error_message     TEXT    NOT NULL DEFAULT '',
          implicated_file   TEXT,
          implicated_line   INTEGER,
          deployed_sha      TEXT,
          fired_at          INTEGER NOT NULL,
          resolved_at       INTEGER,
          mttr_ms           INTEGER,
          pd_incident_id    TEXT,
          pd_alert_title    TEXT    NOT NULL DEFAULT '',
          pd_alert_url      TEXT,
          trace_id          TEXT    NOT NULL DEFAULT '',
          fix_pr_url        TEXT,
          fix_pr_title      TEXT,
          fix_pr_sha        TEXT,
          fix_summary       TEXT,
          resolution_type   TEXT    NOT NULL DEFAULT 'unknown',
          raw_fact          TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_mem_fingerprint ON incident_memory(fingerprint);
        CREATE INDEX IF NOT EXISTS idx_mem_fired_at    ON incident_memory(fired_at);
        CREATE INDEX IF NOT EXISTS idx_mem_service     ON incident_memory(service);

        CREATE TABLE IF NOT EXISTS incident_benchmarks (
          id               INTEGER PRIMARY KEY AUTOINCREMENT,
          fingerprint      TEXT    NOT NULL,
          mttr_ms          INTEGER,
          resolution_type  TEXT    NOT NULL DEFAULT 'unknown',
          recorded_at      INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_bench_fingerprint ON incident_benchmarks(fingerprint);
      `);

      this._flush();
      logger.info({ path: MEMORY_DB }, 'incident memory store initialised');
    } catch (err) {
      logger.warn({ err }, 'incident memory store failed to init');
    }
  }

  // ── Write ──────────────────────────────────────────────────────────────────

  openIncident(fields: {
    fingerprint: string;
    service: string;
    endpoint: string;
    errorType: string;
    errorMessage: string;
    implicatedFile?: string;
    implicatedLine?: number;
    deployedSha?: string;
    pdIncidentId?: string;
    pdAlertTitle: string;
    pdAlertUrl?: string;
    traceId: string;
    rawFact?: string;
    firedAt?: number;
  }): number {
    if (!this.db) return -1;
    this.db.run(
      `INSERT INTO incident_memory
         (fingerprint, service, endpoint, error_type, error_message,
          implicated_file, implicated_line, deployed_sha,
          fired_at, pd_incident_id, pd_alert_title, pd_alert_url,
          trace_id, raw_fact)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        fields.fingerprint,
        fields.service,
        fields.endpoint,
        fields.errorType,
        fields.errorMessage,
        fields.implicatedFile ?? null,
        fields.implicatedLine ?? null,
        fields.deployedSha ?? null,
        fields.firedAt ?? Date.now(),
        fields.pdIncidentId ?? null,
        fields.pdAlertTitle,
        fields.pdAlertUrl ?? null,
        fields.traceId,
        fields.rawFact ?? null,
      ],
    );
    const idRes = this.db.exec('SELECT last_insert_rowid()');
    const id = (idRes[0]?.values[0]?.[0] as number) ?? -1;
    this._flush();
    return id;
  }

  closeIncident(opts: {
    id?: number;
    pdIncidentId?: string;
    resolvedAt?: number;
    fixPrUrl?: string;
    fixPrTitle?: string;
    fixPrSha?: string;
    fixSummary?: string;
    resolutionType?: ResolutionType;
  }): void {
    if (!this.db) return;

    const resolvedAt = opts.resolvedAt ?? Date.now();
    const resolutionType = opts.resolutionType ?? 'unknown';

    const where = opts.id ? `id = ${opts.id}` : `pd_incident_id = '${opts.pdIncidentId}'`;
    const openRec = this.db.exec(
      `SELECT id, fired_at, fingerprint FROM incident_memory WHERE ${where} AND resolved_at IS NULL LIMIT 1`,
    );

    if (!openRec[0]?.values?.length) return;

    const [recId, firedAt, fingerprint] = openRec[0].values[0] as [number, number, string];
    const mttrMs = resolvedAt - firedAt;

    this.db.run(
      `UPDATE incident_memory
       SET resolved_at=?, mttr_ms=?, fix_pr_url=?, fix_pr_title=?, fix_pr_sha=?,
           fix_summary=?, resolution_type=?
       WHERE id=?`,
      [
        resolvedAt,
        mttrMs,
        opts.fixPrUrl ?? null,
        opts.fixPrTitle ?? null,
        opts.fixPrSha ?? null,
        opts.fixSummary ?? null,
        resolutionType,
        recId,
      ],
    );

    // Write anonymized benchmark row
    this.db.run(
      'INSERT INTO incident_benchmarks (fingerprint, mttr_ms, resolution_type, recorded_at) VALUES (?,?,?,?)',
      [fingerprint, mttrMs, resolutionType, resolvedAt],
    );

    this._flush();
  }

  // Called by GitHub webhook: find the most recent open incident and correlate
  correlateGitHubPR(opts: {
    prUrl: string;
    prTitle: string;
    prSha: string;
    mergedAt: number;
  }): void {
    if (!this.db) return;

    const windowStart = opts.mergedAt - DEFAULT_CAUSALITY_WINDOW_MS;
    const res = this.db.exec(
      `SELECT id FROM incident_memory
       WHERE resolved_at IS NULL AND fired_at >= ?
       ORDER BY fired_at DESC LIMIT 1`,
      [windowStart],
    );

    if (!res[0]?.values?.length) return;

    const [id] = res[0].values[0] as [number];
    const type = inferResolutionType(opts.prTitle);

    this.db.run(
      `UPDATE incident_memory
       SET fix_pr_url=?, fix_pr_title=?, fix_pr_sha=?, resolution_type=?
       WHERE id=?`,
      [opts.prUrl, opts.prTitle, opts.prSha, type, id],
    );
    this._flush();
    logger.info({ id, prUrl: opts.prUrl, type }, 'github PR correlated to open incident');
  }

  // ── Read ───────────────────────────────────────────────────────────────────

  findSimilar(fingerprint: string, limit = 5): IncidentMemoryRecord[] {
    if (!this.db) return [];
    const res = this.db.exec(
      `SELECT * FROM incident_memory WHERE fingerprint=? ORDER BY fired_at DESC LIMIT ?`,
      [fingerprint, limit],
    );
    return this._rows(res);
  }

  benchmarkStats(fingerprint: string): BenchmarkStats | null {
    if (!this.db) return null;

    const res = this.db.exec(
      `SELECT mttr_ms, resolution_type FROM incident_benchmarks WHERE fingerprint=? ORDER BY recorded_at DESC LIMIT 100`,
      [fingerprint],
    );
    if (!res[0]?.values?.length) return null;

    const rows = res[0].values as Array<[number | null, string]>;
    const mttrValues = rows.map((r) => r[0]).filter((v): v is number => v !== null).sort((a, b) => a - b);

    const typeCounts: Record<string, number> = {};
    for (const [, t] of rows) typeCounts[t] = (typeCounts[t] ?? 0) + 1;
    const topEntry = Object.entries(typeCounts).sort((a, b) => b[1] - a[1])[0];

    const lastRes = this.db.exec(
      `SELECT MAX(recorded_at) FROM incident_benchmarks WHERE fingerprint=?`,
      [fingerprint],
    );
    const lastSeenAt = (lastRes[0]?.values[0]?.[0] as number | null) ?? null;

    return {
      fingerprint,
      occurrences: rows.length,
      p50MttrMs: mttrValues.length ? mttrValues[Math.floor(mttrValues.length * 0.5)] : null,
      p90MttrMs: mttrValues.length ? mttrValues[Math.floor(mttrValues.length * 0.9)] : null,
      topResolutionType: (topEntry?.[0] ?? 'unknown') as ResolutionType,
      topResolutionCount: topEntry?.[1] ?? 0,
      lastSeenAt,
    };
  }

  listOpen(): IncidentMemoryRecord[] {
    if (!this.db) return [];
    const res = this.db.exec(
      'SELECT * FROM incident_memory WHERE resolved_at IS NULL ORDER BY fired_at DESC LIMIT 20',
    );
    return this._rows(res);
  }

  /** Find recent incidents (open or resolved) that implicate a specific file path. */
  findByFile(filePath: string, limit = 10): IncidentMemoryRecord[] {
    if (!this.db) return [];
    // Match on basename so Docker /app/src/foo.go matches local src/foo.go
    const basename = filePath.split('/').pop() ?? filePath;
    const res = this.db.exec(
      `SELECT * FROM incident_memory
       WHERE implicated_file LIKE ? OR implicated_file LIKE ?
       ORDER BY fired_at DESC LIMIT ?`,
      [`%${basename}`, `%${filePath}%`, limit],
    );
    return this._rows(res);
  }

  /** Returns per-service stats: incident count, avg MTTR, most recent. */
  serviceStats(service: string): { count: number; avgMttrMs: number | null; lastFiredAt: number | null } {
    if (!this.db) return { count: 0, avgMttrMs: null, lastFiredAt: null };
    const res = this.db.exec(
      `SELECT COUNT(*) as cnt, AVG(mttr_ms) as avg_mttr, MAX(fired_at) as last
       FROM incident_memory WHERE service = ?`,
      [service],
    );
    const row = res[0]?.values[0];
    if (!row) return { count: 0, avgMttrMs: null, lastFiredAt: null };
    return {
      count: Number(row[0] ?? 0),
      avgMttrMs: row[1] ? Number(row[1]) : null,
      lastFiredAt: row[2] ? Number(row[2]) : null,
    };
  }

  getById(id: number): IncidentMemoryRecord | null {
    if (!this.db) return null;
    const res = this.db.exec('SELECT * FROM incident_memory WHERE id=?', [id]);
    const rows = this._rows(res);
    return rows[0] ?? null;
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  private _rows(res: ReturnType<Database['exec']>): IncidentMemoryRecord[] {
    if (!res[0]?.values) return [];
    const cols = res[0].columns;
    return res[0].values.map((vals) => {
      const r: Record<string, unknown> = {};
      cols.forEach((c, i) => { r[c] = vals[i]; });
      return {
        id: r.id as number,
        fingerprint: String(r.fingerprint ?? ''),
        service: String(r.service ?? ''),
        endpoint: String(r.endpoint ?? ''),
        errorType: String(r.error_type ?? ''),
        errorMessage: String(r.error_message ?? ''),
        implicatedFile: r.implicated_file ? String(r.implicated_file) : null,
        implicatedLine: r.implicated_line ? Number(r.implicated_line) : null,
        deployedSha: r.deployed_sha ? String(r.deployed_sha) : null,
        firedAt: Number(r.fired_at ?? 0),
        resolvedAt: r.resolved_at ? Number(r.resolved_at) : null,
        mttrMs: r.mttr_ms ? Number(r.mttr_ms) : null,
        pdIncidentId: r.pd_incident_id ? String(r.pd_incident_id) : null,
        pdAlertTitle: String(r.pd_alert_title ?? ''),
        pdAlertUrl: r.pd_alert_url ? String(r.pd_alert_url) : null,
        traceId: String(r.trace_id ?? ''),
        fixPrUrl: r.fix_pr_url ? String(r.fix_pr_url) : null,
        fixPrTitle: r.fix_pr_title ? String(r.fix_pr_title) : null,
        fixPrSha: r.fix_pr_sha ? String(r.fix_pr_sha) : null,
        fixSummary: r.fix_summary ? String(r.fix_summary) : null,
        resolutionType: (r.resolution_type as ResolutionType) ?? 'unknown',
        rawFact: r.raw_fact ? String(r.raw_fact) : null,
      };
    });
  }

  private _flush(): void {
    if (!this.db) return;
    try { fs.writeFileSync(MEMORY_DB, Buffer.from(this.db.export())); }
    catch (err) { logger.warn({ err }, 'memory store flush failed'); }
  }
}

// Infer resolution type from PR title heuristics
export function inferResolutionType(prTitle: string): ResolutionType {
  const t = prTitle.toLowerCase();
  if (/revert|rollback|undo/.test(t)) return 'rollback_deploy';
  if (/flag|feature.flag|toggle|launch.darkly|launchdarkly/.test(t)) return 'flag_rollback';
  if (/config|env|setting|secret|credential/.test(t)) return 'config_change';
  if (/fix|patch|hotfix|bug|crash|error|incident/.test(t)) return 'hotfix_deploy';
  return 'unknown';
}

export function formatMttr(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

export const memoryStore = new IncidentMemoryStore();

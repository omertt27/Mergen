/**
 * incident-store.ts — Persistent incident state (acknowledge / assign / resolve / note).
 *
 * Uses the same sql.js WASM SQLite as sqlite-store.ts so there's no new
 * dependency. One table: incidents keyed by hypothesis pid.
 *
 * The pid from the calibration system is the stable incident identifier —
 * every hypothesis that fires gets one, it survives server restarts via
 * the verdicts.json file, and it's already surfaced in the Slack alert and
 * dashboard. Building incident state on top of it means zero new IDs.
 */

import initSqlJs, { type Database } from 'sql.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { DATA_DIR } from './paths.js';
import logger from './logger.js';

const INCIDENT_DB = path.join(DATA_DIR, 'incidents.db');

export type IncidentStatus = 'open' | 'acknowledged' | 'resolved';

export interface Incident {
  pid: string;
  hypothesis: string;
  tag: string;
  status: IncidentStatus;
  assignee: string | null;
  notes: string[];
  sha: string | null;
  environment: string | null;
  /** Service name for graph queries and multi-service memory (Y3) */
  service: string | null;
  /** Kubernetes cluster or deployment target (Y3) */
  cluster: string | null;
  confidence: number;
  createdAt: number;
  updatedAt: number;
  acknowledgedBy: string | null;
  resolvedAt: number | null;
  resolvedAutonomously: boolean;
}

class IncidentStore {
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
      if (fs.existsSync(INCIDENT_DB)) {
        try { fileBuffer = fs.readFileSync(INCIDENT_DB); } catch {}
      }

      this.db = fileBuffer ? new SQL.Database(fileBuffer) : new SQL.Database();

      this.db.run(`
        CREATE TABLE IF NOT EXISTS incidents (
          pid                    TEXT PRIMARY KEY,
          hypothesis             TEXT NOT NULL,
          tag                    TEXT NOT NULL DEFAULT '',
          status                 TEXT NOT NULL DEFAULT 'open',
          assignee               TEXT,
          notes                  TEXT NOT NULL DEFAULT '[]',
          sha                    TEXT,
          environment            TEXT,
          service                TEXT,
          cluster                TEXT,
          confidence             REAL NOT NULL DEFAULT 0,
          created_at             INTEGER NOT NULL,
          updated_at             INTEGER NOT NULL,
          acknowledged_by        TEXT,
          resolved_at            INTEGER,
          resolved_autonomously  INTEGER NOT NULL DEFAULT 0
        );
      `);
      // Migration: add service + cluster columns to existing databases
      try { this.db.run(`ALTER TABLE incidents ADD COLUMN service TEXT`); } catch { /**/ }
      try { this.db.run(`ALTER TABLE incidents ADD COLUMN cluster TEXT`); } catch { /**/ }
      this._flush();
      logger.info({ path: INCIDENT_DB }, 'incident store initialised');
    } catch (err) {
      logger.warn({ err }, 'incident store failed to init — running without persistence');
    }
  }

  private _flush(): void {
    if (!this.db) return;
    try {
      const data = this.db.export();
      fs.writeFileSync(INCIDENT_DB, Buffer.from(data));
    } catch (err) {
      logger.warn({ err }, 'incident store flush failed');
    }
  }

  private _row(row: Record<string, unknown>): Incident {
    return {
      pid: String(row.pid ?? ''),
      hypothesis: String(row.hypothesis ?? ''),
      tag: String(row.tag ?? ''),
      status: (row.status as IncidentStatus) ?? 'open',
      assignee: row.assignee ? String(row.assignee) : null,
      notes: (() => { try { return JSON.parse(String(row.notes ?? '[]')); } catch { return []; } })(),
      sha: row.sha ? String(row.sha) : null,
      environment: row.environment ? String(row.environment) : null,
      service: row.service ? String(row.service) : null,
      cluster: row.cluster ? String(row.cluster) : null,
      confidence: Number(row.confidence ?? 0),
      createdAt: Number(row.created_at ?? 0),
      updatedAt: Number(row.updated_at ?? 0),
      acknowledgedBy: row.acknowledged_by ? String(row.acknowledged_by) : null,
      resolvedAt: row.resolved_at ? Number(row.resolved_at) : null,
      resolvedAutonomously: Boolean(row.resolved_autonomously),
    };
  }

  upsert(pid: string, fields: Partial<Omit<Incident, 'pid' | 'createdAt' | 'updatedAt'>>): Incident {
    if (!this.db) {
      const now = Date.now();
      return {
        pid, status: 'open', hypothesis: '', tag: '', assignee: null, notes: [],
        sha: null, environment: null, service: null, cluster: null, confidence: 0,
        createdAt: now, updatedAt: now,
        acknowledgedBy: null, resolvedAt: null, resolvedAutonomously: false, ...fields,
      };
    }

    const existing = this.get(pid);
    const now = Date.now();

    if (!existing) {
      this.db.run(
        `INSERT INTO incidents (pid, hypothesis, tag, status, assignee, notes, sha, environment, service, cluster, confidence, created_at, updated_at, acknowledged_by, resolved_at, resolved_autonomously)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          pid,
          fields.hypothesis ?? '',
          fields.tag ?? '',
          fields.status ?? 'open',
          fields.assignee ?? null,
          JSON.stringify(fields.notes ?? []),
          fields.sha ?? null,
          fields.environment ?? null,
          fields.service ?? null,
          fields.cluster ?? null,
          fields.confidence ?? 0,
          now, now,
          fields.acknowledgedBy ?? null,
          fields.resolvedAt ?? null,
          fields.resolvedAutonomously ? 1 : 0,
        ],
      );
    } else {
      const merged = { ...existing, ...fields };
      this.db.run(
        `UPDATE incidents SET hypothesis=?,tag=?,status=?,assignee=?,notes=?,sha=?,environment=?,service=?,cluster=?,confidence=?,updated_at=?,acknowledged_by=?,resolved_at=?,resolved_autonomously=? WHERE pid=?`,
        [
          merged.hypothesis, merged.tag, merged.status, merged.assignee,
          JSON.stringify(merged.notes), merged.sha, merged.environment,
          merged.service, merged.cluster,
          merged.confidence, now, merged.acknowledgedBy, merged.resolvedAt,
          merged.resolvedAutonomously ? 1 : 0, pid,
        ],
      );
    }
    this._flush();
    return this.get(pid)!;
  }

  get(pid: string): Incident | null {
    if (!this.db) return null;
    try {
      const res = this.db.exec('SELECT * FROM incidents WHERE pid=?', [pid]);
      if (!res[0]?.values?.length) return null;
      const cols = res[0].columns;
      const vals = res[0].values[0];
      const row: Record<string, unknown> = {};
      cols.forEach((c, i) => { row[c] = vals[i]; });
      return this._row(row);
    } catch { return null; }
  }

  list(status?: IncidentStatus, limit = 50): Incident[] {
    if (!this.db) return [];
    try {
      const sql = status
        ? `SELECT * FROM incidents WHERE status=? ORDER BY updated_at DESC LIMIT ?`
        : `SELECT * FROM incidents ORDER BY updated_at DESC LIMIT ?`;
      const params = status ? [status, limit] : [limit];
      const res = this.db.exec(sql, params);
      if (!res[0]?.values) return [];
      return res[0].values.map((vals) => {
        const row: Record<string, unknown> = {};
        res[0].columns.forEach((c, i) => { row[c] = vals[i]; });
        return this._row(row);
      });
    } catch { return []; }
  }

  /**
   * Co-occurring services: other services that had incidents within windowMs of
   * any incident for the given service. Pure SQL — no JS O(n²) scan.
   * Returns up to `limit` services sorted by co-occurrence count descending.
   */
  coOccurringServices(
    service: string,
    windowMs = 10 * 60 * 1000,
    limit = 4,
  ): Array<{ service: string; count: number }> {
    if (!this.db) return [];
    try {
      const res = this.db.exec(
        `SELECT other.service, COUNT(*) AS cnt
         FROM incidents AS base
         JOIN incidents AS other
           ON other.service != base.service
          AND other.service IS NOT NULL
          AND other.created_at BETWEEN base.created_at - ? AND base.created_at + ?
         WHERE base.service = ?
         GROUP BY other.service
         ORDER BY cnt DESC
         LIMIT ?`,
        [windowMs, windowMs, service, limit],
      );
      if (!res[0]?.values) return [];
      return res[0].values.map((v) => ({
        service: String(v[0] ?? ''),
        count: Number(v[1] ?? 0),
      }));
    } catch { return []; }
  }

  addNote(pid: string, note: string, author?: string): Incident | null {
    const inc = this.get(pid);
    if (!inc) return null;
    const entry = author ? `[${author}] ${note}` : note;
    return this.upsert(pid, { notes: [...inc.notes, entry] });
  }
}

export const incidentStore = new IncidentStore();

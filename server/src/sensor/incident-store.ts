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

export interface ServiceEdge {
  source: string;
  target: string;
  weight: number;
  lastIncidentAt: number;
}

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
  /**
   * True when autopilot resolved this incident AND the calibration verdict was
   * 'correct' — meaning the error rate dropped AND the root-cause diagnosis was
   * confirmed. This is the LeCun metric: not just "fast-resolved" but causally correct.
   */
  causallyCorrect: boolean;
  /**
   * Timestamp when an engineer first called GET /trust-score/:pid or
   * POST /incidents/:pid/mark-context-viewed — meaning they read Mergen's
   * diagnosis brief before taking manual action. Used to split MTTR by
   * context-assisted vs. unassisted in the impact report.
   */
  contextBriefViewedAt: number | null;
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
          resolved_autonomously  INTEGER NOT NULL DEFAULT 0,
          causally_correct       INTEGER NOT NULL DEFAULT 0
        );
      `);
      this.db.run(`
        CREATE TABLE IF NOT EXISTS service_edges (
          source          TEXT NOT NULL,
          target          TEXT NOT NULL,
          weight          INTEGER NOT NULL DEFAULT 1,
          last_incident_at INTEGER NOT NULL,
          PRIMARY KEY (source, target)
        );
      `);
      // Migration: add service + cluster columns to existing databases
      try { this.db.run(`ALTER TABLE incidents ADD COLUMN service TEXT`); } catch { /**/ }
      try { this.db.run(`ALTER TABLE incidents ADD COLUMN cluster TEXT`); } catch { /**/ }
      try { this.db.run(`ALTER TABLE incidents ADD COLUMN causally_correct INTEGER NOT NULL DEFAULT 0`); } catch { /**/ }
      try { this.db.run(`ALTER TABLE incidents ADD COLUMN context_brief_viewed_at INTEGER`); } catch { /**/ }
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
      causallyCorrect: Boolean(row.causally_correct),
      contextBriefViewedAt: row.context_brief_viewed_at ? Number(row.context_brief_viewed_at) : null,
    };
  }

  upsert(pid: string, fields: Partial<Omit<Incident, 'pid' | 'createdAt' | 'updatedAt'>>): Incident {
    if (!this.db) {
      const now = Date.now();
      return {
        pid, status: 'open', hypothesis: '', tag: '', assignee: null, notes: [],
        sha: null, environment: null, service: null, cluster: null, confidence: 0,
        createdAt: now, updatedAt: now,
        acknowledgedBy: null, resolvedAt: null, resolvedAutonomously: false, causallyCorrect: false,
        contextBriefViewedAt: null, ...fields,
      };
    }

    const existing = this.get(pid);
    const now = Date.now();

    if (!existing) {
      this.db.run(
        `INSERT INTO incidents (pid, hypothesis, tag, status, assignee, notes, sha, environment, service, cluster, confidence, created_at, updated_at, acknowledged_by, resolved_at, resolved_autonomously, causally_correct)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
          fields.causallyCorrect ? 1 : 0,
        ],
      );
    } else {
      const merged = { ...existing, ...fields };
      this.db.run(
        `UPDATE incidents SET hypothesis=?,tag=?,status=?,assignee=?,notes=?,sha=?,environment=?,service=?,cluster=?,confidence=?,updated_at=?,acknowledged_by=?,resolved_at=?,resolved_autonomously=?,causally_correct=? WHERE pid=?`,
        [
          merged.hypothesis, merged.tag, merged.status, merged.assignee,
          JSON.stringify(merged.notes), merged.sha, merged.environment,
          merged.service, merged.cluster,
          merged.confidence, now, merged.acknowledgedBy, merged.resolvedAt,
          merged.resolvedAutonomously ? 1 : 0,
          merged.causallyCorrect ? 1 : 0, pid,
        ],
      );
    }
    this._flush();
    const result = this.get(pid)!;
    // Update interaction graph whenever a service incident is recorded
    if (result.service) {
      this.updateServiceEdges(result.service, result.updatedAt);
    }
    return result;
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

  markContextViewed(pid: string): void {
    if (!this.db) return;
    const existing = this.get(pid);
    if (!existing || existing.contextBriefViewedAt != null) return;
    try {
      this.db.run(
        `UPDATE incidents SET context_brief_viewed_at=? WHERE pid=?`,
        [Date.now(), pid],
      );
      this._flush();
    } catch (err) {
      logger.warn({ err, pid }, 'incident store: markContextViewed failed');
    }
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

  /**
   * Persist a co-occurrence edge between `service` and every other service
   * that had an incident within windowMs. Called on every upsert so the
   * graph accumulates weight over time without a separate indexing job.
   */
  updateServiceEdges(service: string, at: number, windowMs = 10 * 60 * 1_000): void {
    if (!this.db) return;
    try {
      const coServices = this.coOccurringServices(service, windowMs, 20);
      for (const { service: target } of coServices) {
        // Upsert both directions so graph queries are symmetric
        for (const [src, tgt] of [[service, target], [target, service]]) {
          this.db.run(
            `INSERT INTO service_edges (source, target, weight, last_incident_at) VALUES (?,?,1,?)
             ON CONFLICT(source, target) DO UPDATE SET weight = weight + 1, last_incident_at = excluded.last_incident_at`,
            [src, tgt, at],
          );
        }
      }
      this._flush();
    } catch (err) {
      logger.warn({ err, service }, 'incident store: updateServiceEdges failed');
    }
  }

  /**
   * Return the full interaction graph, optionally filtered to edges touching `service`.
   * Sorted by weight descending — strongest co-occurrence relationships first.
   */
  getInteractionGraph(service?: string): ServiceEdge[] {
    if (!this.db) return [];
    try {
      const sql = service
        ? `SELECT source, target, weight, last_incident_at FROM service_edges WHERE source=? OR target=? ORDER BY weight DESC LIMIT 100`
        : `SELECT source, target, weight, last_incident_at FROM service_edges ORDER BY weight DESC LIMIT 200`;
      const params = service ? [service, service] : [];
      const res = this.db.exec(sql, params);
      if (!res[0]?.values) return [];
      return res[0].values.map((v) => ({
        source: String(v[0] ?? ''),
        target: String(v[1] ?? ''),
        weight: Number(v[2] ?? 0),
        lastIncidentAt: Number(v[3] ?? 0),
      }));
    } catch { return []; }
  }
}

export const incidentStore = new IncidentStore();

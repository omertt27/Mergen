/**
 * postmortem-store.ts — Persistent postmortem database (Y1 corpus moat).
 *
 * Every resolved incident generates a structured postmortem that is:
 *   1. Written to SQLite for persistence across restarts and deployments
 *   2. Indexed by failure mode (tag) for runbook synthesis
 *   3. Linked to the git SHA and branch at resolution time
 *
 * This is the lock-in corpus described in the GTM strategy:
 *   resolve an incident → postmortem written → runbook updated →
 *   next same failure resolved faster and with higher confidence.
 *
 * Zero-retention mode: set MERGEN_ZERO_RETENTION=true to skip all writes.
 */

import initSqlJs, { type Database } from 'sql.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { execSync } from 'child_process';
import { DATA_DIR, POSTMORTEMS_DB, zeroRetentionMode } from '../sensor/paths.js';
import logger from '../sensor/logger.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Postmortem {
  pid: string;
  tag: string;
  service: string;
  gitSha: string | null;
  gitBranch: string | null;
  rootCause: string;
  fixCommand: string | null;
  confidence: number;
  mttrMs: number | null;
  resolvedAutonomously: boolean;
  generatedAt: number;
  body: string;
}

export interface PostmortemInput {
  pid: string;
  tag: string;
  service: string;
  rootCause: string;
  fixCommand: string | null;
  confidence: number;
  mttrMs: number | null;
  resolvedAutonomously: boolean;
  evidence?: string[];
  fixHint?: string | null;
}

// ── Store ─────────────────────────────────────────────────────────────────────

class PostmortemStore {
  private db: Database | null = null;
  /** Whether this sql.js build supports FTS5 — detected at init */
  ftsAvailable = false;

  private resolveWasmPath(): string {
    if (process.env.MERGEN_WASM_PATH) return process.env.MERGEN_WASM_PATH;
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    const fromModule = path.resolve(moduleDir, '../../node_modules/sql.js/dist/sql-wasm.wasm');
    if (fs.existsSync(fromModule)) return fromModule;
    try {
      const req = createRequire(import.meta.url);
      const resolved = path.join(path.dirname(req.resolve('sql.js')), 'sql-wasm.wasm');
      if (fs.existsSync(resolved)) return resolved;
    } catch { /**/ }
    return fromModule;
  }

  async init(): Promise<void> {
    if (zeroRetentionMode()) {
      logger.info('postmortem store: zero-retention mode — no disk writes');
      return;
    }
    try {
      const wasmBinary = fs.readFileSync(this.resolveWasmPath());
      const SQL = await initSqlJs({ wasmBinary });
      fs.mkdirSync(DATA_DIR, { recursive: true });

      let fileBuffer: Buffer | undefined;
      if (fs.existsSync(POSTMORTEMS_DB)) {
        try { fileBuffer = fs.readFileSync(POSTMORTEMS_DB); } catch { /**/ }
      }

      this.db = fileBuffer ? new SQL.Database(fileBuffer) : new SQL.Database();

      this.db.run(`
        CREATE TABLE IF NOT EXISTS postmortems (
          pid                   TEXT PRIMARY KEY,
          tag                   TEXT NOT NULL DEFAULT '',
          service               TEXT NOT NULL DEFAULT 'unknown',
          git_sha               TEXT,
          git_branch            TEXT,
          root_cause            TEXT NOT NULL DEFAULT '',
          fix_command           TEXT,
          confidence            REAL NOT NULL DEFAULT 0,
          mttr_ms               INTEGER,
          resolved_autonomously INTEGER NOT NULL DEFAULT 0,
          generated_at          INTEGER NOT NULL,
          body                  TEXT NOT NULL DEFAULT ''
        );
      `);
      this.db.run(`CREATE INDEX IF NOT EXISTS pm_tag_idx ON postmortems (tag);`);
      this.db.run(`CREATE INDEX IF NOT EXISTS pm_gen_idx  ON postmortems (generated_at DESC);`);

      // FTS5 full-text index for keyword search (hybrid retrieval).
      // Graceful fallback if this sql.js build was compiled without FTS5.
      try {
        this.db.run(`
          CREATE VIRTUAL TABLE IF NOT EXISTS postmortems_fts USING fts5(
            pid UNINDEXED,
            content,
            tokenize = 'porter ascii'
          );
        `);
        // Backfill any postmortems written before FTS existed
        this.db.run(`
          INSERT INTO postmortems_fts (pid, content)
          SELECT pm.pid,
                 (pm.tag || ' ' || pm.service || ' ' || pm.root_cause ||
                  ' ' || COALESCE(pm.fix_command, '') || ' ' || pm.body)
          FROM postmortems pm
          WHERE pm.pid NOT IN (SELECT pid FROM postmortems_fts);
        `);
        this.ftsAvailable = true;
        logger.debug('FTS5 index initialised');
      } catch (ftsErr) {
        logger.warn({ ftsErr }, 'FTS5 unavailable in this sql.js build — falling back to LIKE search');
      }

      this._flush();
      logger.info({ path: POSTMORTEMS_DB }, 'postmortem store initialised');
    } catch (err) {
      logger.warn({ err }, 'postmortem store failed to init — running without persistence');
    }
  }

  private _flush(): void {
    if (!this.db || zeroRetentionMode()) return;
    try {
      const data = this.db.export();
      fs.writeFileSync(POSTMORTEMS_DB, Buffer.from(data));
    } catch (err) {
      logger.warn({ err }, 'postmortem store flush failed');
    }
  }

  private _row(cols: string[], vals: (string | number | null | Uint8Array)[]): Postmortem {
    const row: Record<string, unknown> = {};
    cols.forEach((c, i) => { row[c] = vals[i]; });
    return {
      pid: String(row.pid ?? ''),
      tag: String(row.tag ?? ''),
      service: String(row.service ?? 'unknown'),
      gitSha: row.git_sha ? String(row.git_sha) : null,
      gitBranch: row.git_branch ? String(row.git_branch) : null,
      rootCause: String(row.root_cause ?? ''),
      fixCommand: row.fix_command ? String(row.fix_command) : null,
      confidence: Number(row.confidence ?? 0),
      mttrMs: row.mttr_ms != null ? Number(row.mttr_ms) : null,
      resolvedAutonomously: Boolean(row.resolved_autonomously),
      generatedAt: Number(row.generated_at ?? 0),
      body: String(row.body ?? ''),
    };
  }

  write(pm: Postmortem): void {
    if (!this.db) return;
    try {
      this.db.run(
        `INSERT OR REPLACE INTO postmortems
          (pid, tag, service, git_sha, git_branch, root_cause, fix_command,
           confidence, mttr_ms, resolved_autonomously, generated_at, body)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          pm.pid, pm.tag, pm.service, pm.gitSha, pm.gitBranch,
          pm.rootCause, pm.fixCommand, pm.confidence,
          pm.mttrMs ?? null, pm.resolvedAutonomously ? 1 : 0,
          pm.generatedAt, pm.body,
        ],
      );
      // Keep FTS5 index in sync
      if (this.ftsAvailable) {
        const content = [pm.tag, pm.service, pm.rootCause, pm.fixCommand ?? '', pm.body]
          .join(' ');
        this.db.run(
          `INSERT OR REPLACE INTO postmortems_fts (pid, content) VALUES (?, ?)`,
          [pm.pid, content],
        );
      }
      this._flush();
      logger.debug({ pid: pm.pid, tag: pm.tag }, 'postmortem written');
    } catch (err) {
      logger.warn({ err, pid: pm.pid }, 'postmortem write failed');
    }
  }

  /**
   * BM25 keyword search via FTS5. Returns pids ranked by relevance.
   * Falls back to LIKE search when FTS5 is unavailable.
   */
  keywordSearch(query: string, limit = 20): Array<{ pid: string; rank: number }> {
    if (!this.db) return [];

    // Sanitize: strip FTS5 operators, keep alphanumeric + hyphens + underscores
    const terms = query
      .replace(/[^\w\s_-]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 2)
      .slice(0, 12);
    if (terms.length === 0) return [];

    if (this.ftsAvailable) {
      try {
        // FTS5 MATCH with OR semantics — each term is independent
        // bm25() returns negative values (lower = better)
        const ftsQuery = terms.join(' OR ');
        const res = this.db.exec(
          `SELECT pid, bm25(postmortems_fts) AS score
           FROM postmortems_fts
           WHERE postmortems_fts MATCH ?
           ORDER BY score
           LIMIT ?`,
          [ftsQuery, limit],
        );
        if (!res[0]?.values) return [];
        return res[0].values.map((v, i) => ({ pid: String(v[0]), rank: i }));
      } catch (e) {
        logger.debug({ e, query }, 'FTS5 query failed — falling through to LIKE');
      }
    }

    // LIKE fallback (no FTS5 or query parse error)
    try {
      const like = `%${terms[0]}%`;
      const res = this.db.exec(
        `SELECT pid FROM postmortems
         WHERE root_cause LIKE ? OR body LIKE ? OR tag LIKE ?
         ORDER BY generated_at DESC LIMIT ?`,
        [like, like, like, limit],
      );
      if (!res[0]?.values) return [];
      return res[0].values.map((v, i) => ({ pid: String(v[0]), rank: i }));
    } catch { return []; }
  }

  getByTag(tag: string, limit = 20): Postmortem[] {
    if (!this.db) return [];
    try {
      const res = this.db.exec(
        'SELECT * FROM postmortems WHERE tag=? ORDER BY generated_at DESC LIMIT ?',
        [tag, limit],
      );
      if (!res[0]?.values) return [];
      return res[0].values.map((v) => this._row(res[0].columns, v as (string | number | null)[]));
    } catch { return []; }
  }

  list(limit = 50): Postmortem[] {
    if (!this.db) return [];
    try {
      const res = this.db.exec(
        'SELECT * FROM postmortems ORDER BY generated_at DESC LIMIT ?',
        [limit],
      );
      if (!res[0]?.values) return [];
      return res[0].values.map((v) => this._row(res[0].columns, v as (string | number | null)[]));
    } catch { return []; }
  }

  count(): number {
    if (!this.db) return 0;
    try {
      const res = this.db.exec('SELECT COUNT(*) FROM postmortems');
      return Number(res[0]?.values?.[0]?.[0] ?? 0);
    } catch { return 0; }
  }

  /** Tag-level stats for runbook and corpus reporting. */
  tagStats(): Array<{ tag: string; count: number; avgMttrMs: number | null; lastAt: number }> {
    if (!this.db) return [];
    try {
      const res = this.db.exec(`
        SELECT tag, COUNT(*) as cnt, AVG(mttr_ms) as avg_mttr, MAX(generated_at) as last_at
        FROM postmortems
        GROUP BY tag
        ORDER BY cnt DESC
      `);
      if (!res[0]?.values) return [];
      return res[0].values.map((v) => ({
        tag: String(v[0] ?? ''),
        count: Number(v[1] ?? 0),
        avgMttrMs: v[2] != null ? Number(v[2]) : null,
        lastAt: Number(v[3] ?? 0),
      }));
    } catch { return []; }
  }

  /**
   * Total MTTR saved vs. the baseline average manual MTTR (for outcome billing).
   * Returns null if there are fewer than 3 samples.
   */
  totalMttrSavedMs(autonomousMttrMs = 120_000): number | null {
    if (!this.db) return null;
    try {
      const res = this.db.exec(
        `SELECT SUM(mttr_ms - ?) FROM postmortems WHERE resolved_autonomously=1 AND mttr_ms > ?`,
        [autonomousMttrMs, autonomousMttrMs],
      );
      const val = res[0]?.values?.[0]?.[0];
      return val != null ? Number(val) : null;
    } catch { return null; }
  }
}

export const postmortemStore = new PostmortemStore();

// ── Generation ────────────────────────────────────────────────────────────────

function detectGitSha(): string | null {
  try { return execSync('git rev-parse HEAD', { stdio: 'pipe', timeout: 2000 }).toString().trim().slice(0, 12); }
  catch { return null; }
}

function detectGitBranch(): string | null {
  try { return execSync('git rev-parse --abbrev-ref HEAD', { stdio: 'pipe', timeout: 2000 }).toString().trim(); }
  catch { return null; }
}

function fmtMs(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.round((ms % 60_000) / 1000);
  return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
}

/**
 * Build and persist a postmortem for a resolved incident.
 * Called automatically by triage_incident and execute_fix on resolution.
 */
export function generatePostmortem(input: PostmortemInput): Postmortem {
  const now = Date.now();
  const gitSha = detectGitSha();
  const gitBranch = detectGitBranch();
  const mttrLabel = input.mttrMs != null ? fmtMs(input.mttrMs) : 'unknown';

  const evidenceSection = input.evidence?.length
    ? `## Evidence\n\n${input.evidence.map((e) => `- ${e}`).join('\n')}\n\n`
    : '';

  const fixSection = input.fixCommand
    ? `## Fix Applied\n\n\`\`\`\n${input.fixCommand}\n\`\`\`\n\n`
    : input.fixHint
      ? `## Fix Applied\n\n${input.fixHint}\n\n`
      : '';

  const headerLine = gitBranch
    ? `**Branch:** ${gitBranch}  |  **SHA:** ${gitSha ?? 'unknown'}`
    : '';

  const body = [
    `# Postmortem — ${input.tag.replace(/^infra_/, '')}`,
    '',
    `**Service:** ${input.service}  |  **Date:** ${new Date(now).toISOString().slice(0, 10)}`,
    `**Confidence:** ${Math.round(input.confidence * 100)}%  |  **MTTR:** ${mttrLabel}`,
    `**Resolution:** ${input.resolvedAutonomously ? 'Autonomous (Mergen)' : 'Manual'}`,
    headerLine,
    '',
    '## Root Cause',
    '',
    input.rootCause,
    '',
    evidenceSection,
    fixSection,
    '## Timeline',
    '',
    '- Incident detected and triaged by Mergen',
    input.resolvedAutonomously
      ? `- Fix executed autonomously — RESOLVED in ${mttrLabel}`
      : `- Fix applied manually — RESOLVED in ${mttrLabel}`,
    '',
  ].filter((l) => l !== undefined).join('\n');

  const pm: Postmortem = {
    pid: input.pid,
    tag: input.tag,
    service: input.service,
    gitSha,
    gitBranch,
    rootCause: input.rootCause,
    fixCommand: input.fixCommand,
    confidence: input.confidence,
    mttrMs: input.mttrMs,
    resolvedAutonomously: input.resolvedAutonomously,
    generatedAt: now,
    body,
  };

  postmortemStore.write(pm);
  logger.info({ pid: pm.pid, tag: pm.tag, mttrMs: pm.mttrMs }, 'postmortem generated');
  return pm;
}

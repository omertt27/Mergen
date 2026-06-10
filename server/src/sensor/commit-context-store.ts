/**
 * commit-context-store.ts — Persistent archive of PR causal intent.
 *
 * Captures the "why" behind every AI-influenced commit: the PR title and
 * description (business reasoning), linked issues (tickets), human approvers,
 * and AI tool attribution. This is the data moat that cannot be reconstructed
 * from git history alone — GitHub retains PR data for ~90 days before it
 * becomes effectively inaccessible without dedicated crawling.
 *
 * Populated by POST /webhooks/github (pull_request merged + push events).
 * Read by get_change_timeline, draftPostmortemDoc, and explain_why.
 */

import initSqlJs, { type Database } from 'sql.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { DATA_DIR } from './paths.js';
import logger from './logger.js';

const CONTEXT_DB = path.join(DATA_DIR, 'commit-contexts.db');

export interface LinkedIssue {
  ref: string;       // "#123" or "JIRA-456" or "owner/repo#789"
  url?: string;
}

export interface CommitContext {
  sha: string;
  repo: string;
  branch: string | null;
  prNumber: number | null;
  prTitle: string | null;
  prBody: string | null;
  author: string | null;
  approvers: string[];
  linkedIssues: LinkedIssue[];
  aiGenerated: boolean;
  aiTool: string | null;
  filesChanged: string[];
  capturedAt: number;
  mergedAt: number | null;
}

/** Parse GitHub/Jira issue references from a PR body. */
export function extractLinkedIssues(body: string): LinkedIssue[] {
  const issues: LinkedIssue[] = [];
  const seen = new Set<string>();

  // GitHub-style: "Fixes #123", "Closes org/repo#456", "Ref #789"
  const ghRe = /(?:fix(?:es|ed)?|clos(?:es|ed)?|resolv(?:es|ed)?|ref(?:erences?)?|relates?\s+to)\s+([a-z0-9_.-]+\/[a-z0-9_.-]+)?#(\d+)/gi;
  let m: RegExpExecArray | null;
  while ((m = ghRe.exec(body)) !== null) {
    const ref = m[1] ? `${m[1]}#${m[2]}` : `#${m[2]}`;
    if (!seen.has(ref)) { seen.add(ref); issues.push({ ref }); }
  }

  // Plain #N references not already captured
  const plainRe = /#(\d+)\b/g;
  while ((m = plainRe.exec(body)) !== null) {
    const ref = `#${m[1]}`;
    if (!seen.has(ref)) { seen.add(ref); issues.push({ ref }); }
  }

  // Jira-style: "PROJ-123", "ABC-456"
  const jiraRe = /\b([A-Z][A-Z0-9]+-\d+)\b/g;
  while ((m = jiraRe.exec(body)) !== null) {
    const ref = m[1];
    if (!seen.has(ref)) { seen.add(ref); issues.push({ ref }); }
  }

  return issues.slice(0, 20);
}

class CommitContextStore {
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
      if (fs.existsSync(CONTEXT_DB)) {
        try { fileBuffer = fs.readFileSync(CONTEXT_DB); } catch {}
      }
      this.db = fileBuffer ? new SQL.Database(fileBuffer) : new SQL.Database();

      this.db.run(`
        CREATE TABLE IF NOT EXISTS commit_contexts (
          sha            TEXT PRIMARY KEY,
          repo           TEXT NOT NULL DEFAULT '',
          branch         TEXT,
          pr_number      INTEGER,
          pr_title       TEXT,
          pr_body        TEXT,
          author         TEXT,
          approvers      TEXT NOT NULL DEFAULT '[]',
          linked_issues  TEXT NOT NULL DEFAULT '[]',
          ai_generated   INTEGER NOT NULL DEFAULT 0,
          ai_tool        TEXT,
          files_changed  TEXT NOT NULL DEFAULT '[]',
          captured_at    INTEGER NOT NULL,
          merged_at      INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_cc_repo ON commit_contexts(repo);
        CREATE INDEX IF NOT EXISTS idx_cc_captured ON commit_contexts(captured_at DESC);
      `);
      this._flush();
      logger.info({ path: CONTEXT_DB }, 'commit context store initialised');
    } catch (err) {
      logger.warn({ err }, 'commit context store failed to init — running without persistence');
    }
  }

  private _flush(): void {
    if (!this.db) return;
    try {
      const data = this.db.export();
      fs.writeFileSync(CONTEXT_DB, Buffer.from(data));
    } catch (err) {
      logger.warn({ err }, 'commit context store flush failed');
    }
  }

  private _row(cols: string[], vals: (string | number | null)[]): CommitContext {
    const row: Record<string, unknown> = {};
    cols.forEach((c, i) => { row[c] = vals[i]; });
    const parse = (key: string, fallback: unknown[]) => {
      try { return JSON.parse(String(row[key] ?? '[]')); } catch { return fallback; }
    };
    return {
      sha: String(row.sha ?? ''),
      repo: String(row.repo ?? ''),
      branch: row.branch ? String(row.branch) : null,
      prNumber: row.pr_number != null ? Number(row.pr_number) : null,
      prTitle: row.pr_title ? String(row.pr_title) : null,
      prBody: row.pr_body ? String(row.pr_body) : null,
      author: row.author ? String(row.author) : null,
      approvers: parse('approvers', []),
      linkedIssues: parse('linked_issues', []),
      aiGenerated: Boolean(row.ai_generated),
      aiTool: row.ai_tool ? String(row.ai_tool) : null,
      filesChanged: parse('files_changed', []),
      capturedAt: Number(row.captured_at ?? 0),
      mergedAt: row.merged_at != null ? Number(row.merged_at) : null,
    };
  }

  upsert(ctx: CommitContext): void {
    if (!this.db) return;
    try {
      this.db.run(
        `INSERT INTO commit_contexts
           (sha, repo, branch, pr_number, pr_title, pr_body, author, approvers, linked_issues,
            ai_generated, ai_tool, files_changed, captured_at, merged_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(sha) DO UPDATE SET
           repo=excluded.repo, branch=excluded.branch, pr_number=excluded.pr_number,
           pr_title=excluded.pr_title, pr_body=excluded.pr_body, author=excluded.author,
           approvers=excluded.approvers, linked_issues=excluded.linked_issues,
           ai_generated=excluded.ai_generated, ai_tool=excluded.ai_tool,
           files_changed=excluded.files_changed, merged_at=excluded.merged_at`,
        [
          ctx.sha, ctx.repo, ctx.branch, ctx.prNumber,
          ctx.prTitle, ctx.prBody ? ctx.prBody.slice(0, 2000) : null,
          ctx.author,
          JSON.stringify(ctx.approvers),
          JSON.stringify(ctx.linkedIssues),
          ctx.aiGenerated ? 1 : 0,
          ctx.aiTool,
          JSON.stringify(ctx.filesChanged.slice(0, 100)),
          ctx.capturedAt,
          ctx.mergedAt ?? null,
        ],
      );
      this._flush();
    } catch (err) {
      logger.warn({ err, sha: ctx.sha }, 'commit context upsert failed');
    }
  }

  getBySha(sha: string): CommitContext | null {
    if (!this.db) return null;
    try {
      // Exact match first, then prefix match (short sha → full sha)
      const res = this.db.exec(
        `SELECT * FROM commit_contexts WHERE sha=? OR sha LIKE ? LIMIT 1`,
        [sha, `${sha.slice(0, 7)}%`],
      );
      if (!res[0]?.values?.length) return null;
      return this._row(res[0].columns, res[0].values[0] as (string | number | null)[]);
    } catch { return null; }
  }

  /** Returns contexts for a repo or service name, newest first. */
  listByRepo(repo: string, limit = 20): CommitContext[] {
    if (!this.db) return [];
    try {
      const res = this.db.exec(
        `SELECT * FROM commit_contexts WHERE repo LIKE ? ORDER BY captured_at DESC LIMIT ?`,
        [`%${repo}%`, limit],
      );
      if (!res[0]?.values) return [];
      return res[0].values.map((v) => this._row(res[0].columns, v as (string | number | null)[]));
    } catch { return []; }
  }

  /** Returns contexts where the given relative file path appears in files_changed, newest first. */
  listByFile(relPath: string, repo?: string, limit = 10): CommitContext[] {
    if (!this.db) return [];
    try {
      // files_changed is stored as a JSON array; LIKE gives us a simple substring match.
      const pattern = `%${relPath}%`;
      const sql = repo
        ? `SELECT * FROM commit_contexts WHERE files_changed LIKE ? AND repo LIKE ? ORDER BY captured_at DESC LIMIT ?`
        : `SELECT * FROM commit_contexts WHERE files_changed LIKE ? ORDER BY captured_at DESC LIMIT ?`;
      const params = repo ? [pattern, `%${repo}%`, limit] : [pattern, limit];
      const res = this.db.exec(sql, params);
      if (!res[0]?.values) return [];
      return res[0].values.map((v) => this._row(res[0].columns, v as (string | number | null)[]));
    } catch { return []; }
  }

  /** Returns contexts in a time window, optionally filtered by repo. */
  listByWindow(since: number, until: number, repo?: string, limit = 50): CommitContext[] {
    if (!this.db) return [];
    try {
      const sql = repo
        ? `SELECT * FROM commit_contexts WHERE captured_at BETWEEN ? AND ? AND repo LIKE ? ORDER BY captured_at DESC LIMIT ?`
        : `SELECT * FROM commit_contexts WHERE captured_at BETWEEN ? AND ? ORDER BY captured_at DESC LIMIT ?`;
      const params = repo ? [since, until, `%${repo}%`, limit] : [since, until, limit];
      const res = this.db.exec(sql, params);
      if (!res[0]?.values) return [];
      return res[0].values.map((v) => this._row(res[0].columns, v as (string | number | null)[]));
    } catch { return []; }
  }

  count(): number {
    if (!this.db) return 0;
    try {
      const res = this.db.exec('SELECT COUNT(*) FROM commit_contexts');
      return Number(res[0]?.values?.[0]?.[0] ?? 0);
    } catch { return 0; }
  }
}

export const commitContextStore = new CommitContextStore();

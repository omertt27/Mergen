/**
 * agent-context-store.ts — Persistent cross-session execution context for autonomous AI agents.
 *
 * Autonomous coding agents (Claude Code, Cursor Composer, GitHub Copilot Coding Agent)
 * lose context between sessions. This store lets them persist key–value context entries so
 * they don't repeat the same discovery work or violate the same enforcement constraints.
 *
 * Renamed from agent-memory-store.ts to align with AEG positioning — Mergen is an
 * enforcement gateway, not a memory system. The stored data is execution context
 * (prior incident patterns, override corpus entries, constraint records) not general memory.
 *
 * Table schema:
 *   id         — auto-generated UUID
 *   agent_id   — optional client identifier (from MCP clientInfo.name or user-supplied)
 *   key        — free-form text key (e.g. "db-migration-pattern")
 *   value      — free-form text value (JSON or plain text)
 *   stored_at  — epoch ms
 *   ttl_ms     — optional TTL; entries are filtered on read if expired (0 = no TTL)
 */

import initSqlJs, { type Database } from 'sql.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { DATA_DIR } from './paths.js';
import logger from './logger.js';
import { randomUUID } from 'crypto';

// Support both old DB file name (backward compat) and new name.
const LEGACY_CONTEXT_DB = path.join(DATA_DIR, 'agent-memory.db');
const CONTEXT_DB = path.join(DATA_DIR, 'agent-context.db');

export interface AgentContextEntry {
  id: string;
  agentId: string;
  key: string;
  value: string;
  storedAt: number;
  ttlMs: number;
  /** Optional service context for episodic indexing. */
  service: string;
  /** Optional error fingerprint for episodic recall. */
  errorFingerprint: string;
}

/** @deprecated Use AgentContextEntry */
export type AgentMemoryEntry = AgentContextEntry;

class AgentContextStore {
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

      // Migrate legacy DB file if it exists and the new one doesn't.
      if (fs.existsSync(LEGACY_CONTEXT_DB) && !fs.existsSync(CONTEXT_DB)) {
        try { fs.renameSync(LEGACY_CONTEXT_DB, CONTEXT_DB); } catch { /* non-fatal */ }
      }

      let fileBuffer: Buffer | undefined;
      if (fs.existsSync(CONTEXT_DB)) {
        try { fileBuffer = fs.readFileSync(CONTEXT_DB); } catch {}
      }
      this.db = fileBuffer ? new SQL.Database(fileBuffer) : new SQL.Database();

      this.db.run(`
        CREATE TABLE IF NOT EXISTS agent_context (
          id                TEXT PRIMARY KEY,
          agent_id          TEXT NOT NULL DEFAULT '',
          key               TEXT NOT NULL,
          value             TEXT NOT NULL,
          stored_at         INTEGER NOT NULL,
          ttl_ms            INTEGER NOT NULL DEFAULT 0,
          service           TEXT NOT NULL DEFAULT '',
          error_fingerprint TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_agent_context_agent_key ON agent_context (agent_id, key);
        CREATE INDEX IF NOT EXISTS idx_agent_context_episodic ON agent_context (service, error_fingerprint, stored_at);
      `);

      this.flush();
      // Migrations: rename table from agent_memory → agent_context on legacy DBs
      try { this.db.run(`ALTER TABLE agent_memory RENAME TO agent_context`); } catch { /**/ }
      // Migrations for databases that predate optional columns
      try { this.db.run(`ALTER TABLE agent_context ADD COLUMN service TEXT NOT NULL DEFAULT ''`); } catch { /**/ }
      try { this.db.run(`ALTER TABLE agent_context ADD COLUMN error_fingerprint TEXT NOT NULL DEFAULT ''`); } catch { /**/ }
      try { this.db.run(`CREATE INDEX IF NOT EXISTS idx_agent_context_episodic ON agent_context (service, error_fingerprint, stored_at)`); } catch { /**/ }

      logger.debug({ path: CONTEXT_DB }, 'agent-context-store: initialized');

      // Purge expired TTL entries and enforce a 100 MB file-size cap on a
      // background timer. Without cleanup the DB grows unbounded indefinitely.
      this.scheduleCleanup();
    } catch (err) {
      logger.error({ err }, 'agent-context-store: init failed');
    }
  }

  private scheduleCleanup(): void {
    const run = (): void => {
      if (!this.db) return;
      try {
        const now = Date.now();
        this.db.run('DELETE FROM agent_context WHERE ttl_ms > 0 AND stored_at + ttl_ms < ?', [now]);
        this.flush();
        // Enforce 100 MB cap: if DB file exceeds limit, delete oldest rows in batches.
        try {
          const stat = fs.statSync(CONTEXT_DB);
          if (stat.size > 100 * 1024 * 1024) {
            this.db.run('DELETE FROM agent_context WHERE id IN (SELECT id FROM agent_context ORDER BY stored_at ASC LIMIT 1000)');
            this.flush();
            logger.warn('agent-context-store: DB exceeded 100 MB cap — pruned oldest 1000 entries');
          }
        } catch { /* stat may fail if file not yet written */ }
      } catch (err) {
        logger.warn({ err }, 'agent-context-store: cleanup failed');
      }
    };
    run();
    setInterval(run, 60 * 60_000).unref();
  }

  private flush(): void {
    if (!this.db) return;
    try {
      const data = this.db.export();
      fs.writeFileSync(CONTEXT_DB, Buffer.from(data));
    } catch (err) {
      logger.warn({ err }, 'agent-context-store: flush failed');
    }
  }

  store(
    agentId: string,
    key: string,
    value: string,
    ttlMs = 0,
    service = '',
    errorFingerprint = '',
  ): AgentContextEntry {
    if (!this.db) throw new Error('agent-context-store: not initialized');

    const now = Date.now();
    const existing = this.recall(agentId, key, 1);
    const id = existing[0]?.id ?? randomUUID();

    this.db.run(
      `INSERT OR REPLACE INTO agent_context
         (id, agent_id, key, value, stored_at, ttl_ms, service, error_fingerprint)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, agentId, key, value, now, ttlMs, service, errorFingerprint],
    );
    this.flush();

    return { id, agentId, key, value, storedAt: now, ttlMs, service, errorFingerprint };
  }

  recall(
    agentId?: string,
    key?: string,
    limit = 20,
    service?: string,
    errorFingerprint?: string,
  ): AgentContextEntry[] {
    if (!this.db) return [];

    const now = Date.now();
    const clauses: string[] = ['(ttl_ms = 0 OR stored_at + ttl_ms > ?)'];
    const params: (string | number)[] = [now];

    if (agentId)          { clauses.push('agent_id = ?');          params.push(agentId); }
    if (key)              { clauses.push('key = ?');               params.push(key); }
    if (service)          { clauses.push('service = ?');           params.push(service); }
    if (errorFingerprint) { clauses.push('error_fingerprint = ?'); params.push(errorFingerprint); }

    const sql = `SELECT * FROM agent_context WHERE ${clauses.join(' AND ')} ORDER BY stored_at DESC LIMIT ?`;
    params.push(limit);

    try {
      const stmt = this.db.prepare(sql);
      stmt.bind(params);
      const rows: AgentContextEntry[] = [];
      while (stmt.step()) {
        const r = stmt.getAsObject() as Record<string, unknown>;
        rows.push({
          id:               r['id'] as string,
          agentId:          r['agent_id'] as string,
          key:              r['key'] as string,
          value:            r['value'] as string,
          storedAt:         r['stored_at'] as number,
          ttlMs:            r['ttl_ms'] as number,
          service:          (r['service'] as string) ?? '',
          errorFingerprint: (r['error_fingerprint'] as string) ?? '',
        });
      }
      stmt.free();
      return rows;
    } catch (err) {
      logger.warn({ err }, 'agent-context-store: recall failed');
      return [];
    }
  }

  recallEpisodic(service: string, errorFingerprint?: string, limit = 10): AgentContextEntry[] {
    return this.recall(undefined, undefined, limit, service, errorFingerprint);
  }

  isHealthy(): boolean { return this.db !== null; }

  listKeys(agentId?: string): Array<{ agentId: string; key: string; lastStoredAt: number }> {
    if (!this.db) return [];
    const now = Date.now();
    const clauses = ['(ttl_ms = 0 OR stored_at + ttl_ms > ?)'];
    const params: (string | number)[] = [now];
    if (agentId) { clauses.push('agent_id = ?'); params.push(agentId); }
    const sql = `SELECT agent_id, key, MAX(stored_at) AS last_at
                 FROM agent_context
                 WHERE ${clauses.join(' AND ')}
                 GROUP BY agent_id, key
                 ORDER BY last_at DESC`;
    try {
      const stmt = this.db.prepare(sql);
      stmt.bind(params);
      const rows: Array<{ agentId: string; key: string; lastStoredAt: number }> = [];
      while (stmt.step()) {
        const r = stmt.getAsObject() as Record<string, unknown>;
        rows.push({
          agentId:      r['agent_id'] as string,
          key:          r['key'] as string,
          lastStoredAt: r['last_at'] as number,
        });
      }
      stmt.free();
      return rows;
    } catch (err) {
      logger.warn({ err }, 'agent-context-store: listKeys failed');
      return [];
    }
  }

  forget(agentId: string, key: string): void {
    if (!this.db) return;
    this.db.run('DELETE FROM agent_context WHERE agent_id = ? AND key = ?', [agentId, key]);
    this.flush();
  }
}

export const agentContextStore = new AgentContextStore();

/** @deprecated Use agentContextStore */
export const agentMemoryStore = agentContextStore;

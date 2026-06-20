/**
 * agent-memory-store.ts — Persistent cross-session memory for autonomous AI agents.
 *
 * Autonomous coding agents (Claude Code, Cursor Composer, GitHub Copilot Coding Agent)
 * lose context between sessions. This store lets them persist key–value memories so
 * they don't repeat the same discovery work or violate the same "why" constraints.
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

const MEMORY_DB = path.join(DATA_DIR, 'agent-memory.db');

export interface AgentMemoryEntry {
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

class AgentMemoryStore {
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
      if (fs.existsSync(MEMORY_DB)) {
        try { fileBuffer = fs.readFileSync(MEMORY_DB); } catch {}
      }
      this.db = fileBuffer ? new SQL.Database(fileBuffer) : new SQL.Database();

      this.db.run(`
        CREATE TABLE IF NOT EXISTS agent_memory (
          id                TEXT PRIMARY KEY,
          agent_id          TEXT NOT NULL DEFAULT '',
          key               TEXT NOT NULL,
          value             TEXT NOT NULL,
          stored_at         INTEGER NOT NULL,
          ttl_ms            INTEGER NOT NULL DEFAULT 0,
          service           TEXT NOT NULL DEFAULT '',
          error_fingerprint TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_agent_memory_agent_key ON agent_memory (agent_id, key);
        CREATE INDEX IF NOT EXISTS idx_agent_memory_episodic ON agent_memory (service, error_fingerprint, stored_at);
      `);

      this.flush();
      // Migrations for existing databases that predate these columns
      try { this.db.run(`ALTER TABLE agent_memory ADD COLUMN service TEXT NOT NULL DEFAULT ''`); } catch { /**/ }
      try { this.db.run(`ALTER TABLE agent_memory ADD COLUMN error_fingerprint TEXT NOT NULL DEFAULT ''`); } catch { /**/ }
      // Index may not exist on older DBs
      try { this.db.run(`CREATE INDEX IF NOT EXISTS idx_agent_memory_episodic ON agent_memory (service, error_fingerprint, stored_at)`); } catch { /**/ }
      logger.debug({ path: MEMORY_DB }, 'agent-memory-store: initialized');
    } catch (err) {
      logger.error({ err }, 'agent-memory-store: init failed');
    }
  }

  private flush(): void {
    if (!this.db) return;
    try {
      const data = this.db.export();
      fs.writeFileSync(MEMORY_DB, Buffer.from(data));
    } catch (err) {
      logger.warn({ err }, 'agent-memory-store: flush failed');
    }
  }

  /**
   * Store or overwrite a memory entry.
   * If an entry with the same (agentId, key) already exists it is replaced.
   * Optional `service` and `errorFingerprint` enable episodic recall.
   */
  store(
    agentId: string,
    key: string,
    value: string,
    ttlMs = 0,
    service = '',
    errorFingerprint = '',
  ): AgentMemoryEntry {
    if (!this.db) throw new Error('agent-memory-store: not initialized');

    const now = Date.now();
    const existing = this.recall(agentId, key, 1);
    const id = existing[0]?.id ?? randomUUID();

    this.db.run(
      `INSERT OR REPLACE INTO agent_memory
         (id, agent_id, key, value, stored_at, ttl_ms, service, error_fingerprint)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, agentId, key, value, now, ttlMs, service, errorFingerprint],
    );
    this.flush();

    return { id, agentId, key, value, storedAt: now, ttlMs, service, errorFingerprint };
  }

  /**
   * Retrieve memory entries filtered by agentId, key, service, and/or errorFingerprint.
   * Expired entries are excluded. Results are ordered newest-first.
   */
  recall(
    agentId?: string,
    key?: string,
    limit = 20,
    service?: string,
    errorFingerprint?: string,
  ): AgentMemoryEntry[] {
    if (!this.db) return [];

    const now = Date.now();
    const clauses: string[] = ['(ttl_ms = 0 OR stored_at + ttl_ms > ?)'];
    const params: (string | number)[] = [now];

    if (agentId)          { clauses.push('agent_id = ?');          params.push(agentId); }
    if (key)              { clauses.push('key = ?');               params.push(key); }
    if (service)          { clauses.push('service = ?');           params.push(service); }
    if (errorFingerprint) { clauses.push('error_fingerprint = ?'); params.push(errorFingerprint); }

    const sql = `SELECT * FROM agent_memory WHERE ${clauses.join(' AND ')} ORDER BY stored_at DESC LIMIT ?`;
    params.push(limit);

    try {
      const stmt = this.db.prepare(sql);
      stmt.bind(params);
      const rows: AgentMemoryEntry[] = [];
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
      logger.warn({ err }, 'agent-memory-store: recall failed');
      return [];
    }
  }

  /**
   * Episodic recall: return memories for a specific (service, errorFingerprint) context,
   * ordered by recency. This is the associative lookup LeCun-style models use.
   */
  recallEpisodic(service: string, errorFingerprint?: string, limit = 10): AgentMemoryEntry[] {
    return this.recall(undefined, undefined, limit, service, errorFingerprint);
  }

  /** Returns true when the SQLite database initialised successfully. */
  isHealthy(): boolean { return this.db !== null; }

  /**
   * List all non-expired keys stored by an agent, grouped for discovery.
   * Lets an agent enumerate what it has stored without knowing keys in advance.
   */
  listKeys(agentId?: string): Array<{ agentId: string; key: string; lastStoredAt: number }> {
    if (!this.db) return [];
    const now = Date.now();
    const clauses = ['(ttl_ms = 0 OR stored_at + ttl_ms > ?)'];
    const params: (string | number)[] = [now];
    if (agentId) { clauses.push('agent_id = ?'); params.push(agentId); }
    const sql = `SELECT agent_id, key, MAX(stored_at) AS last_at
                 FROM agent_memory
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
          agentId:     r['agent_id'] as string,
          key:         r['key'] as string,
          lastStoredAt: r['last_at'] as number,
        });
      }
      stmt.free();
      return rows;
    } catch (err) {
      logger.warn({ err }, 'agent-memory-store: listKeys failed');
      return [];
    }
  }

  /** Remove a specific memory by (agentId, key). */
  forget(agentId: string, key: string): void {
    if (!this.db) return;
    this.db.run('DELETE FROM agent_memory WHERE agent_id = ? AND key = ?', [agentId, key]);
    this.flush();
  }
}

export const agentMemoryStore = new AgentMemoryStore();

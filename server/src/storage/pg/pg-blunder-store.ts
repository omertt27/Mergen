/**
 * pg-blunder-store.ts — IBlunderStore backed by the Postgres `agent_blunders`
 * table (created by migration 005_blunder_store.sql).
 *
 * Hash chain semantics mirror the file-based agent-blunder-store.ts singleton:
 *   - Every entry carries a SHA-256 hash of its content prepended with the
 *     previous entry's hash (GENESIS_HASH for the first entry).
 *   - Writes use a SERIALIZABLE transaction to prevent concurrent chain forks.
 *   - Ring-buffer cap is enforced by deleting the oldest entries on overflow.
 *
 * HMAC sidecar files are not applicable in Postgres mode — database integrity
 * mechanisms (WAL, checksums) replace the file-level HMAC.
 */

import { createHash, randomUUID } from 'crypto';
import { getSql } from './pg-client.js';
import type { BlunderEvent, BlunderType } from '../../sensor/agent-blunder-store.js';
import { MAX_BLUNDERS } from '../../sensor/agent-blunder-store.js';
import type { IBlunderStore } from '../interfaces.js';

const DEFAULT_TENANT = 'local';
const GENESIS_HASH   = '0'.repeat(64);

// ── Hash chain (mirrors agent-blunder-store.ts logic exactly) ─────────────────

function _hashableContent(
  event: Omit<BlunderEvent, 'hash' | 'previousHash'>,
  previousHash: string,
): string {
  const content: Record<string, unknown> = {
    id:              event.id,
    recordedAt:      event.recordedAt,
    blunderType:     event.blunderType,
    command:         event.command,
    blockReason:     event.blockReason,
    service:         event.service,
    tag:             event.tag,
    actor:           event.actor,
    pid:             event.pid,
    confidenceScore: event.confidenceScore,
  };
  if (event.triggeredRules !== undefined) content.triggeredRules = event.triggeredRules;
  return previousHash + JSON.stringify(content);
}

function _computeHash(
  event: Omit<BlunderEvent, 'hash' | 'previousHash'>,
  previousHash: string,
): string {
  return createHash('sha256').update(_hashableContent(event, previousHash)).digest('hex');
}

// ── Row mapping ───────────────────────────────────────────────────────────────

function rowToBlunder(row: Record<string, unknown>): BlunderEvent {
  const triggeredRaw = row.triggered_rules;
  let triggeredRules: string[] | null | undefined;
  if (triggeredRaw === null || triggeredRaw === undefined) {
    triggeredRules = null;
  } else if (Array.isArray(triggeredRaw)) {
    triggeredRules = triggeredRaw as string[];
  } else {
    try { triggeredRules = JSON.parse(String(triggeredRaw)); } catch { triggeredRules = null; }
  }

  return {
    id:              String(row.id ?? ''),
    recordedAt:      Number(row.recorded_at ?? 0),
    blunderType:     (row.blunder_type as BlunderType) ?? 'allowlist_block',
    command:         row.command ? String(row.command) : null,
    blockReason:     String(row.block_reason ?? ''),
    service:         row.service  ? String(row.service)  : null,
    tag:             row.tag      ? String(row.tag)       : null,
    actor:           row.actor    ? String(row.actor)     : null,
    pid:             row.pid      ? String(row.pid)       : null,
    confidenceScore: row.confidence_score != null ? Number(row.confidence_score) : null,
    triggeredRules,
    previousHash:    String(row.previous_hash ?? ''),
    hash:            String(row.hash ?? ''),
  };
}

// ── Store ─────────────────────────────────────────────────────────────────────

export class PgBlunderStore implements IBlunderStore {
  async record(
    event: Omit<BlunderEvent, 'hash' | 'previousHash' | 'id' | 'recordedAt'> & {
      id?: string;
      recordedAt?: number;
    },
    tenantId?: string,
  ): Promise<void> {
    const sql = getSql();
    const tid = tenantId ?? DEFAULT_TENANT;

    await sql.begin('SERIALIZABLE', async (tx) => {
      // Deduplication: skip if already recorded.
      const id = event.id ?? randomUUID();
      const existing = await tx`SELECT 1 FROM agent_blunders WHERE id = ${id} AND tenant_id = ${tid} LIMIT 1`;
      if (existing.length > 0) return;

      // Get the hash of the most recent entry to continue the chain.
      const lastRows = await tx`
        SELECT hash FROM agent_blunders
        WHERE tenant_id = ${tid}
        ORDER BY recorded_at ASC, id ASC
        OFFSET (SELECT GREATEST(COUNT(*) - 1, 0) FROM agent_blunders WHERE tenant_id = ${tid})
        LIMIT 1
      `;
      const previousHash = lastRows.length > 0 ? String(lastRows[0].hash) : GENESIS_HASH;

      const recordedAt     = event.recordedAt ?? Date.now();
      const triggeredRules = event.triggeredRules !== undefined ? event.triggeredRules : null;
      const base           = { ...event, id, recordedAt, triggeredRules };
      const hash           = _computeHash(base, previousHash);

      await tx`
        INSERT INTO agent_blunders (
          id, tenant_id, recorded_at, blunder_type, command, block_reason,
          service, tag, actor, pid, confidence_score, triggered_rules,
          previous_hash, hash
        ) VALUES (
          ${id}, ${tid}, ${recordedAt},
          ${event.blunderType}, ${event.command ?? null}, ${event.blockReason},
          ${event.service ?? null}, ${event.tag ?? null}, ${event.actor ?? null},
          ${event.pid ?? null}, ${event.confidenceScore ?? null},
          ${triggeredRules != null ? JSON.stringify(triggeredRules) : null},
          ${previousHash}, ${hash}
        )
        ON CONFLICT (id, tenant_id) DO NOTHING
      `;

      // Enforce ring-buffer cap: delete oldest entries beyond MAX_BLUNDERS.
      await tx`
        DELETE FROM agent_blunders
        WHERE tenant_id = ${tid}
          AND recorded_at = (
            SELECT recorded_at FROM agent_blunders
            WHERE tenant_id = ${tid}
            ORDER BY recorded_at ASC, id ASC
            LIMIT 1
          )
          AND (SELECT COUNT(*) FROM agent_blunders WHERE tenant_id = ${tid}) > ${MAX_BLUNDERS}
      `;
    });
  }

  async list(tenantId?: string): Promise<BlunderEvent[]> {
    const sql = getSql();
    const tid = tenantId ?? DEFAULT_TENANT;
    const rows = await sql`
      SELECT * FROM agent_blunders
      WHERE tenant_id = ${tid}
      ORDER BY recorded_at ASC, id ASC
    `;
    return rows.map((r) => rowToBlunder(r as Record<string, unknown>));
  }

  async getStats(tenantId?: string): Promise<{
    total: number;
    byType: Record<string, number>;
    last7Days: number;
    last30Days: number;
  }> {
    const sql = getSql();
    const tid    = tenantId ?? DEFAULT_TENANT;
    const now    = Date.now();
    const ms7    = 7  * 24 * 60 * 60 * 1_000;
    const ms30   = 30 * 24 * 60 * 60 * 1_000;

    const [totalRows, typeRows, recent7Rows, recent30Rows] = await Promise.all([
      sql`SELECT COUNT(*) AS cnt FROM agent_blunders WHERE tenant_id = ${tid}`,
      sql`SELECT blunder_type, COUNT(*) AS cnt FROM agent_blunders WHERE tenant_id = ${tid} GROUP BY blunder_type`,
      sql`SELECT COUNT(*) AS cnt FROM agent_blunders WHERE tenant_id = ${tid} AND recorded_at >= ${now - ms7}`,
      sql`SELECT COUNT(*) AS cnt FROM agent_blunders WHERE tenant_id = ${tid} AND recorded_at >= ${now - ms30}`,
    ]);

    const byType: Record<string, number> = {};
    for (const row of typeRows) {
      byType[String(row.blunder_type)] = Number(row.cnt);
    }

    return {
      total:      Number(totalRows[0].cnt),
      byType,
      last7Days:  Number(recent7Rows[0].cnt),
      last30Days: Number(recent30Rows[0].cnt),
    };
  }

  async verifyChain(tenantId?: string): Promise<{
    valid: boolean;
    truncated?: boolean;
    verifiedFrom?: string;
    verified?: number;
    firstInvalidIdx?: number;
    reason?: string;
    note?: string;
  }> {
    const blunders = await this.list(tenantId);

    if (blunders.length === 0) {
      return { valid: true, verified: 0, note: 'Log is empty — nothing to verify' };
    }

    const firstV2Idx = blunders.findIndex((b) => !!b.hash);
    if (firstV2Idx === -1) {
      return {
        valid: true, verified: 0, truncated: false,
        note: 'No cryptographically-verified entries — all entries predate hash-chain migration. Chain integrity cannot be confirmed.',
      };
    }

    const anchor    = blunders[firstV2Idx];
    const truncated = anchor.previousHash !== GENESIS_HASH;
    let expectedPrev = anchor.previousHash;
    let seenFirstV2  = false;

    for (let i = firstV2Idx; i < blunders.length; i++) {
      const b = blunders[i];
      if (!b.hash) {
        return { valid: false, firstInvalidIdx: i, reason: `entry at index ${i} (id=${b.id}) is missing hash field after v2 section began — possible injection` };
      }
      if (!seenFirstV2) {
        seenFirstV2 = true;
      } else {
        if (b.previousHash !== expectedPrev) {
          return { valid: false, firstInvalidIdx: i, reason: `previousHash mismatch at index ${i}: expected ${expectedPrev.slice(0, 8)}… got ${b.previousHash.slice(0, 8)}…` };
        }
      }
      const { hash: _h, previousHash: _p, ...rest } = b;
      const recomputed = _computeHash(rest, b.previousHash);
      if (recomputed !== b.hash) {
        return { valid: false, firstInvalidIdx: i, reason: `hash mismatch at index ${i} (id=${b.id}): content was modified after recording` };
      }
      expectedPrev = b.hash;
    }

    return {
      valid:        true,
      truncated,
      verifiedFrom: anchor.id,
      verified:     blunders.length - firstV2Idx,
    };
  }

  /** Always false in Postgres mode — DB integrity mechanisms replace the HMAC sidecar. */
  isIntegrityViolated(): boolean {
    return false;
  }
}

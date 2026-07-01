/**
 * pg-approval-store.ts — IApprovalStore backed by the Postgres
 * `pending_approvals` table.
 *
 * Rows are considered "pending" when resolved_at IS NULL and expires_at > NOW().
 * resolve() and pruneExpired() use conditional UPDATEs so concurrent calls are
 * safe without application-level locking.
 *
 * flush() is a no-op because Postgres writes are immediately durable — there is
 * no in-memory buffer to flush.
 */

import { getSql } from './pg-client.js';
import type { PendingExecution } from '../../intelligence/execution-gate.js';
import type { CommandRiskTier } from '../../intelligence/action-risk.js';
import type { BlastRadius } from '../../intelligence/blast-radius.js';
import type { IApprovalStore } from '../interfaces.js';

const DEFAULT_TENANT = 'local';

// ── Row mapper ────────────────────────────────────────────────────────────────

function rowToPending(row: Record<string, unknown>): PendingExecution {
  return {
    pid: String(row.pid ?? ''),
    command: String(row.command ?? ''),
    tier: (row.tier as CommandRiskTier) ?? 'restart',
    service: String(row.service ?? ''),
    remediationConfidence: Number(row.remediation_confidence ?? 0),
    requestedAt: row.requested_at instanceof Date
      ? (row.requested_at as Date).getTime()
      : new Date(String(row.requested_at ?? 0)).getTime(),
    expiresAt: row.expires_at instanceof Date
      ? (row.expires_at as Date).getTime()
      : new Date(String(row.expires_at ?? 0)).getTime(),
    cwd: row.cwd ? String(row.cwd) : undefined,
    blastRadius: row.blast_radius ? (row.blast_radius as BlastRadius) : undefined,
  };
}

// ── Store ─────────────────────────────────────────────────────────────────────

export class PgApprovalStore implements IApprovalStore {
  async add(token: string, execution: PendingExecution): Promise<void> {
    const sql = getSql();
    await sql`
      INSERT INTO pending_approvals (
        token, tenant_id, pid, command, tier, service,
        remediation_confidence, requested_at, expires_at, cwd, blast_radius
      ) VALUES (
        ${token},
        ${DEFAULT_TENANT},
        ${execution.pid},
        ${execution.command},
        ${execution.tier},
        ${execution.service},
        ${execution.remediationConfidence},
        ${new Date(execution.requestedAt)},
        ${new Date(execution.expiresAt)},
        ${execution.cwd ?? null},
        ${execution.blastRadius ? sql.json(execution.blastRadius as object) : null}
      )
      ON CONFLICT (token) DO NOTHING
    `;
  }

  async get(token: string): Promise<PendingExecution | null> {
    const sql = getSql();
    const rows = await sql`
      SELECT * FROM pending_approvals
      WHERE token = ${token}
        AND resolved_at IS NULL
        AND expires_at > NOW()
    `;
    if (rows.length === 0) return null;
    return rowToPending(rows[0] as Record<string, unknown>);
  }

  async resolve(token: string): Promise<boolean> {
    const sql = getSql();
    const rows = await sql`
      UPDATE pending_approvals
      SET resolved_at = NOW(), resolution = 'resolved'
      WHERE token = ${token}
        AND resolved_at IS NULL
      RETURNING 1
    `;
    return rows.length > 0;
  }

  async listPending(): Promise<Array<[string, PendingExecution]>> {
    const sql = getSql();
    const rows = await sql`
      SELECT * FROM pending_approvals
      WHERE resolved_at IS NULL
        AND expires_at > NOW()
      ORDER BY requested_at ASC
    `;
    return rows.map((r) => [
      String(r.token ?? ''),
      rowToPending(r as Record<string, unknown>),
    ] as [string, PendingExecution]);
  }

  async pruneExpired(): Promise<void> {
    const sql = getSql();
    await sql`
      UPDATE pending_approvals
      SET resolved_at = NOW(), resolution = 'expired'
      WHERE expires_at < NOW()
        AND resolved_at IS NULL
    `;
  }

  /** No-op — Postgres writes are immediately durable. */
  async flush(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * pg-approval-store.ts — IApprovalStore backed by the Postgres
 * `pending_approvals` table.
 *
 * flush() is a no-op because Postgres writes are immediately durable.
 */

import { getSql } from './pg-client.js';
import type { PendingExecution } from '../../intelligence/execution-gate.js';
import type { CommandRiskTier } from '../../intelligence/action-risk.js';
import type { BlastRadius } from '../../intelligence/blast-radius.js';
import type { IApprovalStore } from '../interfaces.js';

const DEFAULT_TENANT = 'local';

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

export class PgApprovalStore implements IApprovalStore {
  async add(token: string, execution: PendingExecution, tenantId = DEFAULT_TENANT): Promise<void> {
    const sql = getSql();
    const lastRows = await sql`
      SELECT hash FROM pending_approvals
      WHERE tenant_id = ${tenantId}
      ORDER BY requested_at DESC, token DESC
      LIMIT 1
    `;
    const prevHash = lastRows.length > 0 && lastRows[0].hash ? String(lastRows[0].hash) : 'genesis_approvals';

    const crypto = await import('crypto');
    const payload = [
      token,
      execution.pid,
      execution.command,
      execution.tier,
      execution.service,
      String(execution.remediationConfidence),
      String(execution.requestedAt)
    ].join('|');
    const hash = crypto.createHash('sha256').update(payload + prevHash).digest('hex');

    await sql`
      INSERT INTO pending_approvals (
        token, tenant_id, pid, command, tier, service,
        remediation_confidence, requested_at, expires_at, cwd, blast_radius,
        hash, prev_hash
      ) VALUES (
        ${token},
        ${tenantId},
        ${execution.pid},
        ${execution.command},
        ${execution.tier},
        ${execution.service},
        ${execution.remediationConfidence},
        ${new Date(execution.requestedAt)},
        ${new Date(execution.expiresAt)},
        ${execution.cwd ?? null},
        ${execution.blastRadius ? sql.json(execution.blastRadius as unknown as Parameters<typeof sql.json>[0]) : null},
        ${hash},
        ${prevHash}
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
      WHERE token = ${token} AND resolved_at IS NULL
      RETURNING 1
    `;
    return rows.length > 0;
  }

  async listPending(tenantId = DEFAULT_TENANT): Promise<Array<[string, PendingExecution]>> {
    const sql = getSql();
    const rows = await sql`
      SELECT * FROM pending_approvals
      WHERE tenant_id = ${tenantId} AND resolved_at IS NULL AND expires_at > NOW()
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
      WHERE expires_at < NOW() AND resolved_at IS NULL
    `;
  }

  async flush(): Promise<void> {
    return Promise.resolve();
  }
}

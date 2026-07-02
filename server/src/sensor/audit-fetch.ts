/**
 * audit-fetch.ts — shared time-windowed fetch for the two audit-log sources
 * (Agent Blunder Log, HTTP audit log), used by both routes/audit-export.ts
 * (raw NDJSON export) and intelligence/compliance-report.ts (structured
 * SOC2-section report). Previously duplicated inline in audit-export.ts only;
 * factored out so the report doesn't re-implement the same filtering.
 */
import { getStores } from '../storage/store-registry.js';
import { getAuditLog, type AuditEntry } from './audit-log.js';
import type { BlunderEvent } from './agent-blunder-store.js';

export async function fetchBlunderEntries(from: number, to: number): Promise<BlunderEvent[]> {
  const blunders = await getStores().blunders.list();
  return blunders.filter((b) => b.recordedAt >= from && b.recordedAt <= to);
}

export async function fetchHttpAuditEntries(from: number, to: number, limit = 50_000): Promise<AuditEntry[]> {
  return getAuditLog(limit).filter((e) => {
    const ts = new Date(e.ts).getTime();
    return ts >= from && ts <= to;
  });
}

/** Chain verification result, honestly scoped to this deployment's configuration. */
export async function fetchChainVerification(): Promise<{
  valid: boolean;
  verified?: number;
  truncated?: boolean;
  tamperEvidenceLevel?: string;
  hmacProtected?: boolean;
}> {
  const blunderStore = getStores().blunders;
  const hasEntries = (await blunderStore.list()).length > 0;
  if (!hasEntries) return { valid: true, verified: 0 };
  return blunderStore.verifyChain();
}

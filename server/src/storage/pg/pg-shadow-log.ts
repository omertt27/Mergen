/**
 * pg-shadow-log.ts — IShadowLog backed by the Postgres shadow_log table.
 *
 * Computation (report, digest, CSV) runs in-process using the same pure
 * functions from shadow-log.ts — same algorithms, different data source.
 */

import { randomUUID } from 'crypto';
import { getSql } from './pg-client.js';
import type { ShadowEntry, ShadowSkipReason, HumanVerdict, ShadowReport } from '../../intelligence/shadow-log.js';
import {
  computeShadowReport,
  computeShadowSlackDigest,
  computeShadowCsv,
} from '../../intelligence/shadow-log.js';
import type { OverrideReason } from '../../intelligence/override-corpus.js';
import type { IShadowLog } from '../interfaces.js';
import { getStores } from '../store-registry.js';
import logger from '../../sensor/logger.js';

const DEFAULT_TENANT = 'local';

function rowToEntry(row: Record<string, unknown>): ShadowEntry {
  return {
    id:                    String(row.id ?? ''),
    pid:                   String(row.pid ?? ''),
    incidentTag:           String(row.incident_tag ?? ''),
    service:               String(row.service ?? ''),
    command:               row.command ? String(row.command) : null,
    diagnosisConfidence:   Number(row.diagnosis_confidence ?? 0),
    remediationConfidence: Number(row.remediation_confidence ?? 0),
    wouldHaveExecuted:     Boolean(row.would_have_executed),
    skipReason:            (row.skip_reason as ShadowSkipReason) ?? 'no-command',
    firedAt:               row.fired_at ? Number(row.fired_at) : undefined,
    recordedAt:            Number(row.recorded_at ?? 0),
    humanVerdict:          row.human_verdict ? (row.human_verdict as HumanVerdict) : undefined,
    humanNote:             row.human_note ? String(row.human_note) : undefined,
    verdictAt:             row.verdict_at ? Number(row.verdict_at) : undefined,
    overrideId:            row.override_id ? String(row.override_id) : undefined,
    runbookId:             row.runbook_id ? String(row.runbook_id) : undefined,
  };
}

export class PgShadowLog implements IShadowLog {
  async recordShadow(
    input: Omit<ShadowEntry, 'id' | 'recordedAt'> & { id?: string },
    tenantId?: string,
  ): Promise<ShadowEntry> {
    const sql = getSql();
    const tid  = tenantId ?? DEFAULT_TENANT;
    const id   = input.id ?? randomUUID();
    const now  = Date.now();

    await sql`
      INSERT INTO shadow_log (
        id, tenant_id, pid, incident_tag, service, command,
        diagnosis_confidence, remediation_confidence, would_have_executed,
        skip_reason, fired_at, recorded_at, runbook_id
      ) VALUES (
        ${id}, ${tid}, ${input.pid}, ${input.incidentTag}, ${input.service},
        ${input.command ?? null}, ${input.diagnosisConfidence}, ${input.remediationConfidence},
        ${input.wouldHaveExecuted}, ${input.skipReason}, ${input.firedAt ?? null}, ${now},
        ${input.runbookId ?? null}
      )
      ON CONFLICT (tenant_id, id) DO NOTHING
    `;

    logger.info({ id, pid: input.pid, tag: input.incidentTag, tid }, 'pg-shadow-log: entry recorded');
    return { ...input, id, recordedAt: now };
  }

  async recordShadowVerdict(
    id: string,
    verdict: HumanVerdict,
    opts: { note?: string; overrideReason?: OverrideReason; manualAction?: string; actor?: string } = {},
    tenantId?: string,
  ): Promise<{ found: false } | { found: true; entry: ShadowEntry; overrideId?: string }> {
    const sql = getSql();
    const tid = tenantId ?? DEFAULT_TENANT;

    const rows = await sql`SELECT * FROM shadow_log WHERE tenant_id = ${tid} AND id = ${id}`;
    if (rows.length === 0) return { found: false };

    const entry = rowToEntry(rows[0] as Record<string, unknown>);
    const verdictAt = Date.now();
    const note = opts.note?.slice(0, 200);

    let overrideId: string | undefined;
    if (verdict === 'would-override' && entry.command) {
      try {
        const ov = await getStores().overrides.recordOverride(
          {
            incidentTag:     entry.incidentTag,
            proposedCommand: entry.command,
            overrideReason:  opts.overrideReason ?? 'on-call-discretion',
            note:            opts.note,
            service:         entry.service,
            environment:     'production',
            manualAction:    opts.manualAction,
            actor:           opts.actor ?? 'shadow-review',
          },
          tid,
        );
        overrideId = ov.id;
      } catch (err) {
        logger.warn({ err, id }, 'pg-shadow-log: failed to record override from verdict');
      }
    }

    await sql`
      UPDATE shadow_log
      SET human_verdict = ${verdict},
          verdict_at    = ${verdictAt},
          human_note    = ${note ?? null},
          override_id   = ${overrideId ?? null}
      WHERE tenant_id = ${tid} AND id = ${id}
    `;

    entry.humanVerdict = verdict;
    entry.verdictAt    = verdictAt;
    if (note) entry.humanNote = note;
    if (overrideId) entry.overrideId = overrideId;

    return { found: true, entry, overrideId };
  }

  async updateShadowReasonByPid(
    pid: string,
    skipReason: ShadowSkipReason,
    tenantId?: string,
  ): Promise<void> {
    const sql = getSql();
    const tid = tenantId ?? DEFAULT_TENANT;
    await sql`
      UPDATE shadow_log SET skip_reason = ${skipReason}
      WHERE tenant_id = ${tid} AND pid = ${pid}
    `;
  }

  async getShadowEntries(tenantId?: string): Promise<readonly ShadowEntry[]> {
    const sql = getSql();
    const tid = tenantId ?? DEFAULT_TENANT;
    const rows = await sql`
      SELECT * FROM shadow_log
      WHERE tenant_id = ${tid}
      ORDER BY recorded_at ASC
    `;
    return rows.map((r) => rowToEntry(r as Record<string, unknown>));
  }

  async getShadowReport(windowDays = 30, tenantId?: string): Promise<ShadowReport> {
    const entries = await this.getShadowEntries(tenantId);
    return computeShadowReport(entries, windowDays);
  }

  async getShadowSlackDigest(windowDays = 7, tenantId?: string): Promise<object> {
    const entries = await this.getShadowEntries(tenantId);
    return computeShadowSlackDigest(entries, windowDays);
  }

  async exportShadowCsv(tenantId?: string): Promise<string> {
    const entries = await this.getShadowEntries(tenantId);
    return computeShadowCsv(entries);
  }
}

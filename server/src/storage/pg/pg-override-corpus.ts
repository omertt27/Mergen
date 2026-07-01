/**
 * pg-override-corpus.ts — IOverrideCorpus backed by the Postgres
 * `override_corpus` table.
 *
 * Compaction and summary logic runs in-process against data fetched from
 * Postgres — same algorithm as override-corpus.ts, different data source.
 */

import { randomUUID } from 'crypto';
import { getSql } from './pg-client.js';
import type {
  OverrideEvent,
  OverrideReason,
  OverrideOutcome,
  CompactedRule,
  OverrideSummary,
} from '../../intelligence/override-corpus.js';
import { dominantCommandSignatures } from '../../intelligence/override-corpus.js';
import type { IOverrideCorpus } from '../interfaces.js';

const DEFAULT_TENANT = 'local';
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function rowToOverrideEvent(row: Record<string, unknown>): OverrideEvent {
  return {
    id: String(row.id ?? ''),
    incidentTag: String(row.incident_tag ?? ''),
    proposedCommand: String(row.proposed_command ?? ''),
    overrideReason: (row.override_reason as OverrideReason) ?? 'other',
    note: row.note ? String(row.note) : undefined,
    service: String(row.service ?? ''),
    environment: String(row.environment ?? 'production'),
    dayOfWeek: Number(row.day_of_week ?? 0),
    hourOfDay: Number(row.hour_of_day ?? 0),
    manualAction: row.manual_action ? String(row.manual_action) : undefined,
    outcome: row.outcome ? (row.outcome as OverrideOutcome) : undefined,
    recordedAt: row.recorded_at instanceof Date
      ? (row.recorded_at as Date).getTime()
      : new Date(String(row.recorded_at ?? 0)).getTime(),
    reviewedAt: row.reviewed_at == null
      ? undefined
      : row.reviewed_at instanceof Date
        ? (row.reviewed_at as Date).getTime()
        : new Date(String(row.reviewed_at)).getTime(),
    actor: String(row.actor ?? ''),
  };
}

export class PgOverrideCorpus implements IOverrideCorpus {
  async recordOverride(
    input: Omit<OverrideEvent, 'id' | 'dayOfWeek' | 'hourOfDay' | 'recordedAt'>,
    tenantId?: string,
  ): Promise<OverrideEvent> {
    const sql = getSql();
    const tid = tenantId ?? DEFAULT_TENANT;
    const now = new Date();
    const id = randomUUID();

    const rows = await sql`
      INSERT INTO override_corpus (
        id, tenant_id, incident_tag, proposed_command, override_reason,
        note, service, environment, day_of_week, hour_of_day,
        manual_action, actor, recorded_at
      ) VALUES (
        ${id}, ${tid},
        ${input.incidentTag},
        ${input.proposedCommand.slice(0, 500)},
        ${input.overrideReason},
        ${input.note?.slice(0, 200) ?? null},
        ${input.service},
        ${input.environment ?? 'production'},
        ${now.getUTCDay()},
        ${now.getUTCHours()},
        ${input.manualAction?.slice(0, 500) ?? null},
        ${input.actor},
        ${now}
      )
      RETURNING *
    `;

    return rowToOverrideEvent(rows[0] as Record<string, unknown>);
  }

  async updateOutcome(id: string, outcome: OverrideOutcome, tenantId?: string): Promise<boolean> {
    const sql = getSql();
    const tid = tenantId ?? DEFAULT_TENANT;
    const rows = await sql`
      UPDATE override_corpus
      SET outcome = ${outcome}
      WHERE tenant_id = ${tid} AND id = ${id}
      RETURNING 1
    `;
    return rows.length > 0;
  }

  async hasRecentOverride(
    incidentTag: string,
    service: string,
    dayOfWeek: number,
    hourOfDay: number,
    tenantId?: string,
  ): Promise<boolean> {
    const sql = getSql();
    const tid = tenantId ?? DEFAULT_TENANT;
    const rows = await sql`
      SELECT 1 FROM override_corpus
      WHERE tenant_id     = ${tid}
        AND incident_tag  = ${incidentTag}
        AND service       = ${service}
        AND day_of_week   = ${dayOfWeek}
        AND recorded_at   > NOW() - INTERVAL '90 days'
        AND ABS(hour_of_day - ${hourOfDay}) <= 1
      LIMIT 1
    `;
    return rows.length > 0;
  }

  async dominantOverrideReason(
    incidentTag: string,
    service: string,
    tenantId?: string,
  ): Promise<OverrideReason | null> {
    const sql = getSql();
    const tid = tenantId ?? DEFAULT_TENANT;
    const rows = await sql`
      SELECT override_reason, COUNT(*) AS cnt
      FROM override_corpus
      WHERE tenant_id = ${tid} AND incident_tag = ${incidentTag} AND service = ${service}
      GROUP BY override_reason
      ORDER BY cnt DESC
      LIMIT 1
    `;
    if (rows.length === 0) return null;
    return (rows[0].override_reason as OverrideReason) ?? null;
  }

  async getOverridesForTag(tag: string, tenantId?: string): Promise<OverrideEvent[]> {
    const sql = getSql();
    const tid = tenantId ?? DEFAULT_TENANT;
    const rows = await sql`
      SELECT * FROM override_corpus
      WHERE tenant_id = ${tid} AND incident_tag = ${tag}
      ORDER BY recorded_at DESC
    `;
    return rows.map((r) => rowToOverrideEvent(r as Record<string, unknown>));
  }

  async getOverrideById(id: string, tenantId?: string): Promise<OverrideEvent | null> {
    const sql = getSql();
    const tid = tenantId ?? DEFAULT_TENANT;
    const rows = await sql`
      SELECT * FROM override_corpus
      WHERE tenant_id = ${tid} AND id = ${id}
      LIMIT 1
    `;
    if (rows.length === 0) return null;
    return rowToOverrideEvent(rows[0] as Record<string, unknown>);
  }

  async getAllOverrides(tenantId?: string): Promise<readonly OverrideEvent[]> {
    const sql = getSql();
    const tid = tenantId ?? DEFAULT_TENANT;
    const rows = await sql`
      SELECT * FROM override_corpus
      WHERE tenant_id = ${tid}
      ORDER BY recorded_at DESC
    `;
    return rows.map((r) => rowToOverrideEvent(r as Record<string, unknown>));
  }

  async compactCorpus(tenantId?: string): Promise<CompactedRule[]> {
    const events = await this.getAllOverrides(tenantId);
    return _compactEvents([...events]);
  }

  async getRulesForTag(incidentTag: string, service: string, tenantId?: string): Promise<CompactedRule[]> {
    const rules = await this.compactCorpus(tenantId);
    return rules.filter((r) => r.incidentTag === incidentTag && r.service === service);
  }

  async describeTopRule(incidentTag: string, service: string, tenantId?: string): Promise<string | null> {
    const rules = await this.getRulesForTag(incidentTag, service, tenantId);
    if (rules.length === 0) return null;
    const r = rules[0];
    const timePart = r.dayOfWeek !== null
      ? ` (${DAY_NAMES[r.dayOfWeek]}${r.hourWindow ? ` ${r.hourWindow[0]}–${r.hourWindow[1] - 1} UTC` : ''}, ${r.occurrences} overrides)`
      : ` (${r.occurrences} overrides)`;
    return `${r.incidentTag} for ${r.service} — ${r.overrideReason}${timePart}`;
  }

  async getOverrideSummary(tenantId?: string): Promise<OverrideSummary[]> {
    const events = await this.getAllOverrides(tenantId as string | undefined);
    return _buildOverrideSummary([...events]);
  }

  async compileOverrideFromSlackThread(
    slackThread: string,
    service?: string,
    tenantId?: string,
  ): Promise<OverrideEvent | null> {
    if (!slackThread) return null;

    const backtickCommands = [...slackThread.matchAll(/`([^`]{4,200})`/g)].map((m) => m[1].trim());

    let proposedCommand = '';
    let manualAction = '';

    for (const cmd of backtickCommands) {
      if (/^(kubectl|docker|systemctl|service|npm|yarn|pnpm|make)\s/i.test(cmd)) {
        if (/restart|stop|scale|revert|rollback|install/i.test(cmd)) {
          if (!proposedCommand) proposedCommand = cmd;
          else if (!manualAction && cmd !== proposedCommand) manualAction = cmd;
        }
      }
    }

    if (!proposedCommand) {
      for (const line of slackThread.split('\n')) {
        const trimmed = line.trim();
        if (/^(kubectl|docker|systemctl|service|npm|yarn|pnpm|make)\s/i.test(trimmed)) {
          proposedCommand = trimmed;
          break;
        }
      }
    }

    if (!proposedCommand) return null;

    let reason: OverrideReason = 'on-call-discretion';
    let note = 'Extracted from Slack thread discussion';
    const lower = slackThread.toLowerCase();

    if (lower.includes('window') || lower.includes('settlement') || lower.includes('friday') || lower.includes('batch')) {
      reason = 'batch-window'; note = 'Override reason mapping: batch-window context discussed';
    } else if (lower.includes('cost') || lower.includes('budget') || lower.includes('scale')) {
      reason = 'cost-constraint'; note = 'Override reason mapping: cost constraints discussed';
    } else if (lower.includes('cab') || lower.includes('freeze') || lower.includes('compliance')) {
      reason = 'compliance-hold'; note = 'Override reason mapping: compliance hold discussed';
    } else if (lower.includes('replica') || lower.includes('read') || lower.includes('primary')) {
      reason = 'prefer-read-replica'; note = 'Override reason mapping: read-replica preference discussed';
    } else if (lower.includes('maintenance') || lower.includes('scheduled')) {
      reason = 'maintenance-window'; note = 'Override reason mapping: maintenance window discussed';
    } else if (lower.includes('wrong diagnosis') || lower.includes('misidentified')) {
      reason = 'wrong-diagnosis'; note = 'Override reason mapping: wrong root-cause discussed';
    } else if (lower.includes('wrong fix') || lower.includes('bad command')) {
      reason = 'wrong-fix'; note = 'Override reason mapping: wrong remediation discussed';
    }

    let incidentTag = 'infra_db_connection_pool';
    if (lower.includes('oom') || lower.includes('memory'))          incidentTag = 'infra_oom_kill';
    else if (lower.includes('rate') || lower.includes('throttl'))   incidentTag = 'infra_rate_limit_cascade';
    else if (lower.includes('cert') || lower.includes('tls'))       incidentTag = 'infra_certificate_expiry';
    else if (lower.includes('disk') || lower.includes('space'))     incidentTag = 'infra_disk_pressure';
    else if (lower.includes('slow') || lower.includes('query'))     incidentTag = 'infra_slow_query';

    return this.recordOverride(
      {
        incidentTag,
        proposedCommand,
        overrideReason: reason,
        note,
        service: service ?? 'unknown',
        environment: 'production',
        manualAction: manualAction || undefined,
        actor: 'Slack NLP Parser',
      },
      tenantId,
    );
  }

  async compileOverridesFromSlackThread(
    slackThread: string,
    service?: string,
    tenantId?: string,
  ): Promise<OverrideEvent[]> {
    const single = await this.compileOverrideFromSlackThread(slackThread, service, tenantId);
    return single ? [single] : [];
  }

  async getStaleOverrides(daysThreshold = 60, tenantId?: string): Promise<OverrideEvent[]> {
    const sql = getSql();
    const tid = tenantId ?? DEFAULT_TENANT;
    // Stale = never-or-long-ago reviewed. Fall back to recorded_at when the
    // entry has never been reviewed (reviewed_at IS NULL).
    const rows = await sql`
      SELECT * FROM override_corpus
      WHERE tenant_id = ${tid}
        AND COALESCE(reviewed_at, recorded_at) < NOW() - (${daysThreshold} * INTERVAL '1 day')
      ORDER BY COALESCE(reviewed_at, recorded_at) ASC
    `;
    return rows.map((r) => rowToOverrideEvent(r as Record<string, unknown>));
  }

  async markOverrideReviewed(id: string, tenantId?: string): Promise<boolean> {
    const sql = getSql();
    const tid = tenantId ?? DEFAULT_TENANT;
    const rows = await sql`
      UPDATE override_corpus
      SET reviewed_at = NOW()
      WHERE tenant_id = ${tid} AND id = ${id}
      RETURNING 1
    `;
    return rows.length > 0;
  }
}

function _compactEvents(events: OverrideEvent[]): CompactedRule[] {
  const buckets = new Map<string, OverrideEvent[]>();
  for (const e of events) {
    const key = `${e.incidentTag}\x00${e.service}\x00${e.overrideReason}`;
    const list = buckets.get(key) ?? [];
    list.push(e);
    buckets.set(key, list);
  }

  const rules: CompactedRule[] = [];
  const now = Date.now();

  for (const evs of buckets.values()) {
    if (evs.length === 0) continue;
    const first = evs[0];

    const dayCounts = new Map<number, number>();
    for (const e of evs) dayCounts.set(e.dayOfWeek, (dayCounts.get(e.dayOfWeek) ?? 0) + 1);

    let dominantDay: number | null = null;
    let dominantDayCount = 0;
    for (const [day, count] of dayCounts) {
      if (count > dominantDayCount) { dominantDay = day; dominantDayCount = count; }
    }
    if (dominantDay !== null && dominantDayCount / evs.length < 0.4) dominantDay = null;

    const hoursToWindow = dominantDay !== null
      ? evs.filter((e) => e.dayOfWeek === dominantDay).map((e) => e.hourOfDay)
      : evs.map((e) => e.hourOfDay);

    let hourWindow: [number, number] | null = null;
    if (hoursToWindow.length > 0) {
      const minH = Math.min(...hoursToWindow);
      const maxH = Math.max(...hoursToWindow);
      if (maxH - minH < 20) hourWindow = [minH, maxH + 1];
    }

    rules.push({
      incidentTag: first.incidentTag,
      service: first.service,
      overrideReason: first.overrideReason,
      dayOfWeek: dominantDay,
      hourWindow,
      occurrences: evs.length,
      commandSignatures: dominantCommandSignatures(evs),
      compactedAt: now,
    });
  }

  rules.sort((a, b) => b.occurrences - a.occurrences);
  return rules;
}

function _buildOverrideSummary(events: OverrideEvent[]): OverrideSummary[] {
  const byTag = new Map<string, OverrideEvent[]>();
  for (const e of events) {
    const list = byTag.get(e.incidentTag) ?? [];
    list.push(e);
    byTag.set(e.incidentTag, list);
  }

  const out: OverrideSummary[] = [];
  for (const [tag, evs] of byTag) {
    const reasonCounts = new Map<OverrideReason, number>();
    const services = new Set<string>();
    const dayCounts = new Map<number, number>();
    const outcomes = { resolved: 0, escalated: 0, unresolved: 0, unknown: 0 };

    for (const e of evs) {
      reasonCounts.set(e.overrideReason, (reasonCounts.get(e.overrideReason) ?? 0) + 1);
      services.add(e.service);
      dayCounts.set(e.dayOfWeek, (dayCounts.get(e.dayOfWeek) ?? 0) + 1);
      if (e.outcome) outcomes[e.outcome]++;
      else outcomes.unknown++;
    }

    let dominant: OverrideReason | null = null;
    let bestCount = 0;
    for (const [r, c] of reasonCounts) {
      if (c > bestCount) { dominant = r; bestCount = c; }
    }

    let dominantDay: number | null = null;
    let dominantDayCount = 0;
    for (const [day, count] of dayCounts) {
      if (count > dominantDayCount) { dominantDay = day; dominantDayCount = count; }
    }

    let timePattern: string | null = null;
    if (dominantDay !== null && dominantDayCount / evs.length >= 0.4) {
      const hoursOnDay = evs.filter((e) => e.dayOfWeek === dominantDay).map((e) => e.hourOfDay);
      const minHour = Math.min(...hoursOnDay);
      const maxHour = Math.max(...hoursOnDay);
      timePattern = maxHour > minHour
        ? `${DAY_NAMES[dominantDay]} ${minHour}–${maxHour} UTC`
        : `${DAY_NAMES[dominantDay]} ${minHour} UTC`;
    }

    out.push({ tag, total: evs.length, dominantReason: dominant, services: [...services], timePattern, outcomes });
  }

  out.sort((a, b) => b.total - a.total);
  return out;
}

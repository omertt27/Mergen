/**
 * pg-incident-store.ts — IIncidentStore backed by the Postgres `incidents` and
 * `service_edges` tables.
 */

import { getSql } from './pg-client.js';
import type { Incident, IncidentStatus, ServiceEdge } from '../../sensor/incident-store.js';
import type { IIncidentStore } from '../interfaces.js';

const DEFAULT_TENANT = 'local';

function toMs(value: Date | string | null | undefined): number {
  if (!value) return 0;
  if (value instanceof Date) return value.getTime();
  return new Date(value).getTime();
}

function toMsNullable(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  if (value instanceof Date) return value.getTime();
  return new Date(value).getTime();
}

function rowToIncident(row: Record<string, unknown>): Incident {
  return {
    pid: String(row.pid ?? ''),
    hypothesis: String(row.hypothesis ?? ''),
    tag: String(row.tag ?? ''),
    status: (row.status as IncidentStatus) ?? 'open',
    assignee: row.assignee ? String(row.assignee) : null,
    notes: Array.isArray(row.notes) ? row.notes as string[] : (() => {
      try { return JSON.parse(String(row.notes ?? '[]')); } catch { return []; }
    })(),
    sha: row.sha ? String(row.sha) : null,
    environment: row.environment ? String(row.environment) : null,
    service: row.service ? String(row.service) : null,
    cluster: row.cluster ? String(row.cluster) : null,
    confidence: Number(row.confidence ?? 0),
    createdAt: toMs(row.created_at as Date | string | null),
    updatedAt: toMs(row.updated_at as Date | string | null),
    acknowledgedBy: row.acknowledged_by ? String(row.acknowledged_by) : null,
    resolvedAt: toMsNullable(row.resolved_at as Date | string | null),
    resolvedAutonomously: Boolean(row.resolved_autonomously),
    causallyCorrect: Boolean(row.causally_correct),
    contextBriefViewedAt: toMsNullable(row.context_brief_viewed_at as Date | string | null),
  };
}

export class PgIncidentStore implements IIncidentStore {
  async init(): Promise<void> {
    // No-op: schema is created by runMigrations() at boot.
  }

  async upsert(
    pid: string,
    fields: Partial<Omit<Incident, 'pid' | 'createdAt' | 'updatedAt'>>,
    tenantId?: string,
  ): Promise<Incident> {
    const sql = getSql();
    const tid = tenantId ?? DEFAULT_TENANT;
    const notes = JSON.stringify(fields.notes ?? []);

    const rows = await sql`
      INSERT INTO incidents (
        pid, tenant_id, hypothesis, tag, status, assignee, notes,
        sha, environment, service, cluster, confidence,
        acknowledged_by, resolved_at, resolved_autonomously, causally_correct
      ) VALUES (
        ${pid}, ${tid},
        ${fields.hypothesis ?? ''},
        ${fields.tag ?? ''},
        ${fields.status ?? 'open'},
        ${fields.assignee ?? null},
        ${notes}::jsonb,
        ${fields.sha ?? null},
        ${fields.environment ?? null},
        ${fields.service ?? null},
        ${fields.cluster ?? null},
        ${fields.confidence ?? 0},
        ${fields.acknowledgedBy ?? null},
        ${fields.resolvedAt ? new Date(fields.resolvedAt) : null},
        ${fields.resolvedAutonomously ?? false},
        ${fields.causallyCorrect ?? false}
      )
      ON CONFLICT (tenant_id, pid) DO UPDATE SET
        hypothesis            = EXCLUDED.hypothesis,
        tag                   = EXCLUDED.tag,
        status                = EXCLUDED.status,
        assignee              = EXCLUDED.assignee,
        notes                 = EXCLUDED.notes,
        sha                   = EXCLUDED.sha,
        environment           = EXCLUDED.environment,
        service               = EXCLUDED.service,
        cluster               = EXCLUDED.cluster,
        confidence            = EXCLUDED.confidence,
        updated_at            = NOW(),
        acknowledged_by       = EXCLUDED.acknowledged_by,
        resolved_at           = EXCLUDED.resolved_at,
        resolved_autonomously = EXCLUDED.resolved_autonomously,
        causally_correct      = EXCLUDED.causally_correct
      RETURNING *
    `;

    const incident = rowToIncident(rows[0] as Record<string, unknown>);
    if (incident.service) {
      await this.updateServiceEdges(incident.service, incident.updatedAt, undefined, tid);
    }
    return incident;
  }

  async get(pid: string, tenantId?: string): Promise<Incident | null> {
    const sql = getSql();
    const tid = tenantId ?? DEFAULT_TENANT;
    const rows = await sql`
      SELECT * FROM incidents WHERE tenant_id = ${tid} AND pid = ${pid}
    `;
    if (rows.length === 0) return null;
    return rowToIncident(rows[0] as Record<string, unknown>);
  }

  async list(status?: IncidentStatus, limit = 50, tenantId?: string): Promise<Incident[]> {
    const sql = getSql();
    const tid = tenantId ?? DEFAULT_TENANT;
    const rows = await sql`
      SELECT * FROM incidents
      WHERE tenant_id = ${tid}
        ${status != null ? sql`AND status = ${status}` : sql``}
      ORDER BY updated_at DESC
      LIMIT ${limit}
    `;
    return rows.map((r) => rowToIncident(r as Record<string, unknown>));
  }

  async addNote(pid: string, note: string, author?: string, tenantId?: string): Promise<Incident | null> {
    const inc = await this.get(pid, tenantId);
    if (!inc) return null;
    const entry = author ? `[${author}] ${note}` : note;
    return this.upsert(pid, { notes: [...inc.notes, entry] }, tenantId);
  }

  async markContextViewed(pid: string, tenantId?: string): Promise<void> {
    const sql = getSql();
    const tid = tenantId ?? DEFAULT_TENANT;
    await sql`
      UPDATE incidents
      SET context_brief_viewed_at = NOW()
      WHERE tenant_id = ${tid} AND pid = ${pid} AND context_brief_viewed_at IS NULL
    `;
  }

  async coOccurringServices(
    service: string,
    windowMs = 10 * 60 * 1000,
    limit = 4,
    tenantId?: string,
  ): Promise<Array<{ service: string; count: number }>> {
    const sql = getSql();
    const tid = tenantId ?? DEFAULT_TENANT;
    const intervalSec = Math.round(windowMs / 1000);
    const rows = await sql`
      SELECT other.service, COUNT(*) AS cnt
      FROM incidents AS base
      JOIN incidents AS other
        ON other.service != base.service
       AND other.service IS NOT NULL
       AND other.created_at BETWEEN base.created_at - (${intervalSec} || ' seconds')::interval
                                 AND base.created_at + (${intervalSec} || ' seconds')::interval
      WHERE base.tenant_id = ${tid}
        AND other.tenant_id = ${tid}
        AND base.service = ${service}
      GROUP BY other.service
      ORDER BY cnt DESC
      LIMIT ${limit}
    `;
    return rows.map((r) => ({ service: String(r.service ?? ''), count: Number(r.cnt ?? 0) }));
  }

  async updateServiceEdges(
    service: string,
    at: number,
    windowMs = 10 * 60 * 1_000,
    tenantId?: string,
  ): Promise<void> {
    const sql = getSql();
    const tid = tenantId ?? DEFAULT_TENANT;
    const coServices = await this.coOccurringServices(service, windowMs, 20, tid);
    const lastAt = new Date(at);

    for (const { service: target } of coServices) {
      for (const [src, tgt] of [[service, target], [target, service]]) {
        await sql`
          INSERT INTO service_edges (tenant_id, source, target, weight, last_incident_at)
          VALUES (${tid}, ${src}, ${tgt}, 1, ${lastAt})
          ON CONFLICT (tenant_id, source, target)
          DO UPDATE SET
            weight           = service_edges.weight + 1,
            last_incident_at = EXCLUDED.last_incident_at
        `;
      }
    }
  }

  async getInteractionGraph(service?: string, tenantId?: string): Promise<ServiceEdge[]> {
    const sql = getSql();
    const tid = tenantId ?? DEFAULT_TENANT;
    const rows = await sql`
      SELECT source, target, weight, last_incident_at
      FROM service_edges
      WHERE tenant_id = ${tid}
        ${service != null ? sql`AND (source = ${service} OR target = ${service})` : sql``}
      ORDER BY weight DESC
      LIMIT ${service != null ? 100 : 200}
    `;
    return rows.map((r) => ({
      source: String(r.source ?? ''),
      target: String(r.target ?? ''),
      weight: Number(r.weight ?? 0),
      lastIncidentAt: toMs(r.last_incident_at as Date | string | null),
    }));
  }
}

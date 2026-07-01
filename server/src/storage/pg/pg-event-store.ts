/**
 * pg-event-store.ts — IEventStore backed by the Postgres `events` table.
 *
 * Events are inserted as JSONB. Query filters are pushed down to SQL so
 * the database does the heavy lifting rather than scanning in JS.
 */

import { getSql } from './pg-client.js';
import type { BrowserEvent } from '../../sensor/buffer.js';
import type { IEventStore } from '../interfaces.js';

const DEFAULT_TENANT = 'local';
const DEFAULT_RETENTION_HOURS = 72;

export class PgEventStore implements IEventStore {
  /** init() is a no-op — migrations handle schema creation. */
  async init(): Promise<void> {
    // No-op: schema is created by runMigrations() at boot.
  }

  async push(event: BrowserEvent, tenantId?: string): Promise<void> {
    const sql = getSql();
    const tid = tenantId ?? DEFAULT_TENANT;
    const type = event.type;
    const ts = (event as { timestamp?: number }).timestamp ?? Date.now();

    // Extract level: console events have .level; network events use .status as level proxy.
    let level: string | null = null;
    if (event.type === 'console') {
      level = (event as { level?: string }).level ?? null;
    } else if (event.type === 'network') {
      const status = (event as { status?: number }).status;
      level = status != null ? String(status) : null;
    }

    await sql`
      INSERT INTO events (tenant_id, type, level, data, ts)
      VALUES (${tid}, ${type}, ${level}, ${sql.json(event as object)}, ${ts})
    `;
  }

  async query(opts: {
    since?: number;
    limit?: number;
    level?: string;
    type?: string;
    tenantId?: string;
  }): Promise<BrowserEvent[]> {
    const sql = getSql();
    const tid = opts.tenantId ?? DEFAULT_TENANT;
    const limit = opts.limit ?? 500;

    // Build dynamic WHERE fragments — postgres tagged templates compose safely.
    const rows = await sql`
      SELECT data FROM events
      WHERE tenant_id = ${tid}
        ${opts.since != null ? sql`AND ts >= ${opts.since}` : sql``}
        ${opts.level != null ? sql`AND level = ${opts.level}` : sql``}
        ${opts.type != null ? sql`AND type = ${opts.type}` : sql``}
      ORDER BY ts DESC
      LIMIT ${limit}
    `;

    return rows.map((r) => r.data as BrowserEvent);
  }

  async size(): Promise<number> {
    const sql = getSql();
    const rows = await sql`SELECT COUNT(*)::int AS cnt FROM events`;
    return rows[0]?.cnt ?? 0;
  }

  async clear(tenantId?: string): Promise<void> {
    const sql = getSql();
    if (tenantId) {
      await sql`DELETE FROM events WHERE tenant_id = ${tenantId}`;
    } else {
      await sql`DELETE FROM events`;
    }
  }

  async pruneOld(): Promise<void> {
    const sql = getSql();
    const hours = Number(process.env.MERGEN_RETENTION_HOURS ?? DEFAULT_RETENTION_HOURS);
    await sql`
      DELETE FROM events
      WHERE inserted_at < NOW() - (${hours} || ' hours')::interval
    `;
  }
}

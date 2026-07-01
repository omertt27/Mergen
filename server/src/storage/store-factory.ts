/**
 * store-factory.ts — Instantiates the correct store implementations based on
 * environment configuration.
 *
 * Phase 1: SQLite implementations (local single-tenant mode).
 * Phase 2: Postgres implementations behind MERGEN_CLOUD_MODE=true.
 *
 * createStores() is async because Postgres modules are loaded lazily via
 * dynamic import() — this avoids importing `postgres` (and requiring
 * MERGEN_PG_URL) when running in local SQLite mode.
 *
 * Call once at boot:
 *   const stores = await createStores();
 *   setStores(stores);
 */

import type { IEventStore, IIncidentStore, IOverrideCorpus, IApprovalStore } from './interfaces.js';
import { SqliteEventStore } from './sqlite/sqlite-event-store.js';
import { SqliteIncidentStore } from './sqlite/sqlite-incident-store.js';
import { SqliteOverrideCorpus } from './sqlite/sqlite-override-corpus.js';
import { SqliteApprovalStore } from './sqlite/sqlite-approval-store.js';

export interface Stores {
  events: IEventStore;
  incidents: IIncidentStore;
  overrides: IOverrideCorpus;
  approvals: IApprovalStore;
}

export async function createStores(): Promise<Stores> {
  const cloudMode = process.env.MERGEN_CLOUD_MODE === 'true';

  if (cloudMode) {
    // Dynamic import avoids loading the postgres package (and requiring
    // MERGEN_PG_URL) when running in local SQLite mode.
    const [
      { PgEventStore },
      { PgIncidentStore },
      { PgOverrideCorpus },
      { PgApprovalStore },
    ] = await Promise.all([
      import('./pg/pg-event-store.js'),
      import('./pg/pg-incident-store.js'),
      import('./pg/pg-override-corpus.js'),
      import('./pg/pg-approval-store.js'),
    ]);

    return {
      events:    new PgEventStore(),
      incidents: new PgIncidentStore(),
      overrides: new PgOverrideCorpus(),
      approvals: new PgApprovalStore(),
    };
  }

  return {
    events:    new SqliteEventStore(),
    incidents: new SqliteIncidentStore(),
    overrides: new SqliteOverrideCorpus(),
    approvals: new SqliteApprovalStore(),
  };
}

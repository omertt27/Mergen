/**
 * store-factory.ts — Instantiates the correct store implementations based on
 * environment configuration.
 *
 * Local mode (default): SQLite wrappers around the existing singletons.
 * Cloud mode (MERGEN_CLOUD_MODE=true): Postgres implementations.
 *
 * createStores() is async in cloud mode because Postgres modules are loaded via
 * dynamic import() to avoid importing `postgres` (and requiring MERGEN_PG_URL)
 * when running in local SQLite mode.
 *
 * Call once at boot:
 *   const stores = await createStores();
 *   setStores(stores);
 */

import type { IEventStore, IIncidentStore, IOverrideCorpus, IApprovalStore, IShadowLog, IBlunderStore } from './interfaces.js';
import { SqliteEventStore } from './sqlite/sqlite-event-store.js';
import { SqliteIncidentStore } from './sqlite/sqlite-incident-store.js';
import { SqliteOverrideCorpus } from './sqlite/sqlite-override-corpus.js';
import { SqliteApprovalStore } from './sqlite/sqlite-approval-store.js';
import { SqliteShadowLog } from './sqlite/sqlite-shadow-log.js';
import { SqliteBlunderStore } from './sqlite/sqlite-blunder-store.js';

export interface Stores {
  events: IEventStore;
  incidents: IIncidentStore;
  overrides: IOverrideCorpus;
  approvals: IApprovalStore;
  shadowLog: IShadowLog;
  blunders: IBlunderStore;
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
      { PgShadowLog },
      { PgBlunderStore },
    ] = await Promise.all([
      import('./pg/pg-event-store.js'),
      import('./pg/pg-incident-store.js'),
      import('./pg/pg-override-corpus.js'),
      import('./pg/pg-approval-store.js'),
      import('./pg/pg-shadow-log.js'),
      import('./pg/pg-blunder-store.js'),
    ]);

    return {
      events:    new PgEventStore(),
      incidents: new PgIncidentStore(),
      overrides: new PgOverrideCorpus(),
      approvals: new PgApprovalStore(),
      shadowLog: new PgShadowLog(),
      blunders:  new PgBlunderStore(),
    };
  }

  return {
    events:    new SqliteEventStore(),
    incidents: new SqliteIncidentStore(),
    overrides: new SqliteOverrideCorpus(),
    approvals: new SqliteApprovalStore(),
    shadowLog: new SqliteShadowLog(),
    blunders:  new SqliteBlunderStore(),
  };
}

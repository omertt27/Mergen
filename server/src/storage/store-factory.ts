/**
 * store-factory.ts — Instantiates the correct store implementations based on
 * environment configuration.
 *
 * Phase 1: only SQLite implementations are available.
 * Phase 2: Postgres implementations will be added here behind the
 *   MERGEN_CLOUD_MODE=true guard.
 *
 * Call createStores() once at boot (in index.ts or app.ts) and hand the result
 * to setStores() so every module can reach it via getStores().
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

export function createStores(): Stores {
  const cloudMode = process.env.MERGEN_CLOUD_MODE === 'true';

  if (cloudMode) {
    // Postgres implementations will be dropped in here in Phase 2.
    // For now, throw to enforce the boot guard in index.ts.
    throw new Error(
      'MERGEN_CLOUD_MODE=true requires Postgres stores — not yet implemented. ' +
      'Remove MERGEN_CLOUD_MODE or wait for Phase 2.',
    );
  }

  return {
    events: new SqliteEventStore(),
    incidents: new SqliteIncidentStore(),
    overrides: new SqliteOverrideCorpus(),
    approvals: new SqliteApprovalStore(),
  };
}

/**
 * store-registry.ts — Module-level singleton registry for the active Stores bundle.
 *
 * Usage:
 *   // In index.ts (boot):
 *   import { createStores } from './storage/store-factory.js';
 *   import { setStores } from './storage/store-registry.js';
 *   setStores(createStores());
 *
 *   // Anywhere else:
 *   import { getStores } from './storage/store-registry.js';
 *   const { events, incidents, overrides, approvals } = getStores();
 */

import type { Stores } from './store-factory.js';
import { SqliteEventStore } from './sqlite/sqlite-event-store.js';
import { SqliteIncidentStore } from './sqlite/sqlite-incident-store.js';
import { SqliteOverrideCorpus } from './sqlite/sqlite-override-corpus.js';
import { SqliteApprovalStore } from './sqlite/sqlite-approval-store.js';
import { SqliteShadowLog } from './sqlite/sqlite-shadow-log.js';
import { SqliteBlunderStore } from './sqlite/sqlite-blunder-store.js';

let _stores: Stores | null = null;

export function setStores(s: Stores): void {
  _stores = s;
}

export function getStores(): Stores {
  if (!_stores) {
    _stores = {
      events:    new SqliteEventStore(),
      incidents: new SqliteIncidentStore(),
      overrides: new SqliteOverrideCorpus(),
      approvals: new SqliteApprovalStore(),
      shadowLog: new SqliteShadowLog(),
      blunders:  new SqliteBlunderStore(),
    };
  }
  return _stores;
}


/**
 * sqlite-event-store.ts — IEventStore backed by the existing SqliteHistoryStore singleton.
 *
 * All methods are thin async wrappers around the synchronous (or already-async)
 * calls on historyStore. Zero business logic lives here — this file is purely
 * the Promise seam that lets Phase 2 swap in a Postgres implementation without
 * touching any call sites.
 */

import { historyStore } from '../../sensor/sqlite-store.js';
import type { BrowserEvent } from '../../sensor/buffer.js';
import type { IEventStore } from '../interfaces.js';

export class SqliteEventStore implements IEventStore {
  /** Delegates to historyStore.init() which is already async (sql.js WASM load). */
  async init(): Promise<void> {
    return historyStore.init();
  }

  async push(event: BrowserEvent, tenantId?: string): Promise<void> {
    return Promise.resolve(historyStore.push(event, tenantId));
  }

  async query(opts: {
    since?: number;
    limit?: number;
    level?: string;
    type?: string;
    tenantId?: string;
  }): Promise<BrowserEvent[]> {
    return Promise.resolve(historyStore.query(opts));
  }

  async size(): Promise<number> {
    return Promise.resolve(historyStore.size());
  }

  /**
   * tenantId is accepted for interface conformance but ignored in SQLite mode —
   * the underlying clear() operates on the whole single-tenant database.
   */
  async clear(_tenantId?: string): Promise<void> {
    return Promise.resolve(historyStore.clear());
  }

  async pruneOld(): Promise<void> {
    return Promise.resolve(historyStore.pruneOld());
  }
}

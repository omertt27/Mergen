/**
 * sqlite-approval-store.ts — IApprovalStore backed by an in-memory Map, with
 * disk persistence delegated to flushApprovals() from execution-gate.ts.
 *
 * Background: execution-gate.ts holds its own private `_pending` Map that is
 * not exported. Phase 1 therefore maintains a parallel Map here as the storage
 * seam. When Phase 2 updates call sites to use getStores().approvals.* instead
 * of requestApproval/approveExecution/denyExecution directly, this Map becomes
 * the single source of truth and the execution-gate primitives are retired.
 *
 * flush() delegates to the exported flushApprovals() from execution-gate so
 * that the SIGTERM handler in index.ts can continue to call it unchanged
 * throughout the Phase 1 → Phase 2 transition.
 */

import { flushApprovals } from '../../intelligence/execution-gate.js';
import type { PendingExecution } from '../../intelligence/execution-gate.js';
import type { IApprovalStore } from '../interfaces.js';

export class SqliteApprovalStore implements IApprovalStore {
  /** In-memory store — mirrors the structure of execution-gate's private _pending map. */
  private readonly _map = new Map<string, PendingExecution>();

  async add(token: string, execution: PendingExecution): Promise<void> {
    this._map.set(token, execution);
  }

  async get(token: string): Promise<PendingExecution | null> {
    return Promise.resolve(this._map.get(token) ?? null);
  }

  async resolve(token: string): Promise<boolean> {
    return Promise.resolve(this._map.delete(token));
  }

  async listPending(): Promise<Array<[string, PendingExecution]>> {
    return Promise.resolve([...this._map.entries()]);
  }

  /** Remove all entries whose expiresAt has passed. */
  async pruneExpired(): Promise<void> {
    const now = Date.now();
    for (const [token, execution] of this._map) {
      if (execution.expiresAt <= now) {
        this._map.delete(token);
      }
    }
  }

  /**
   * Delegates to execution-gate's flushApprovals() so the SIGTERM handler in
   * index.ts can flush the approval state without knowing which store is active.
   * Phase 2 will update this to serialize our own _map to disk.
   */
  async flush(): Promise<void> {
    return Promise.resolve(flushApprovals());
  }
}

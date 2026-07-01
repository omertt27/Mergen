/**
 * sqlite-blunder-store.ts — IBlunderStore backed by the existing file-based
 * agent-blunder-store.ts singleton.
 *
 * Thin async wrappers. tenantId params are accepted for interface conformance
 * but ignored — the JSON-file blunder log is single-tenant.
 *
 * The underlying singleton handles its own file locking, hash chaining, HMAC
 * sidecar, and test-reset helpers. This class is a pure delegation seam so
 * that call sites can be written against IBlunderStore and transparently
 * switch to PgBlunderStore in cloud mode.
 */

import {
  recordBlunder,
  getBlunders,
  getBlunderStats,
  verifyChain,
  isBlunderIntegrityViolated,
} from '../../sensor/agent-blunder-store.js';
import type { BlunderEvent } from '../../sensor/agent-blunder-store.js';
import type { IBlunderStore } from '../interfaces.js';

export class SqliteBlunderStore implements IBlunderStore {
  async record(
    event: Omit<BlunderEvent, 'hash' | 'previousHash' | 'id' | 'recordedAt'> & {
      id?: string;
      recordedAt?: number;
    },
    _tenantId?: string,
  ): Promise<void> {
    recordBlunder(event);
  }

  async list(_tenantId?: string): Promise<BlunderEvent[]> {
    return getBlunders();
  }

  async getStats(_tenantId?: string): Promise<{
    total: number;
    byType: Record<string, number>;
    last7Days: number;
    last30Days: number;
  }> {
    return getBlunderStats();
  }

  async verifyChain(_tenantId?: string): Promise<{
    valid: boolean;
    truncated?: boolean;
    verifiedFrom?: string;
    verified?: number;
    firstInvalidIdx?: number;
    reason?: string;
    note?: string;
  }> {
    return verifyChain();
  }

  isIntegrityViolated(): boolean {
    return isBlunderIntegrityViolated();
  }
}

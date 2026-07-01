import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgApprovalStore } from '../pg-approval-store.js';
import { PgOverrideCorpus } from '../pg-override-corpus.js';

// Mock pg-client module
const mockSql = vi.fn();
vi.mock('../pg-client.js', () => ({
  getSql: () => mockSql,
  closeSql: () => Promise.resolve(),
}));

describe('PostgreSQL Audit Chaining', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('PgApprovalStore chains hashes starting with genesis', async () => {
    let queryCount = 0;
    let firstHash = '';

    mockSql.mockImplementation(async (strings: TemplateStringsArray, ...values: any[]) => {
      queryCount++;
      const queryText = strings.join('?');
      if (queryText.includes('SELECT hash FROM pending_approvals')) {
        return [];
      }
      if (queryText.includes('INSERT INTO pending_approvals')) {
        const prevHash = values[values.length - 1];
        firstHash = values[values.length - 2];
        expect(prevHash).toBe('genesis_approvals');
        expect(firstHash).toHaveLength(64);
        return [];
      }
      return [];
    });

    const store = new PgApprovalStore();
    await store.add('token123', {
      pid: 'pid1',
      command: 'rm -rf /tmp/a',
      tier: 'restart',
      service: 'api',
      remediationConfidence: 0.9,
      requestedAt: 1000000,
      expiresAt: 2000000,
    });

    expect(queryCount).toBe(2);

    mockSql.mockReset();
    queryCount = 0;
    mockSql.mockImplementation(async (strings: TemplateStringsArray, ...values: any[]) => {
      queryCount++;
      const queryText = strings.join('?');
      if (queryText.includes('SELECT hash FROM pending_approvals')) {
        return [{ hash: firstHash }];
      }
      if (queryText.includes('INSERT INTO pending_approvals')) {
        const prevHash = values[values.length - 1];
        const secondHash = values[values.length - 2];
        expect(prevHash).toBe(firstHash);
        expect(secondHash).toHaveLength(64);
        expect(secondHash).not.toBe(firstHash);
        return [];
      }
      return [];
    });

    await store.add('token456', {
      pid: 'pid2',
      command: 'rm -rf /tmp/b',
      tier: 'restart',
      service: 'checkout',
      remediationConfidence: 0.8,
      requestedAt: 1005000,
      expiresAt: 2005000,
    });

    expect(queryCount).toBe(2);
  });

  it('PgOverrideCorpus chains hashes starting with genesis', async () => {
    let queryCount = 0;
    let firstHash = '';

    mockSql.mockImplementation(async (strings: TemplateStringsArray, ...values: any[]) => {
      queryCount++;
      const queryText = strings.join('?');
      if (queryText.includes('SELECT hash FROM override_corpus')) {
        return [];
      }
      if (queryText.includes('INSERT INTO override_corpus')) {
        const prevHash = values[values.length - 1];
        firstHash = values[values.length - 2];
        expect(prevHash).toBe('genesis_override');
        expect(firstHash).toHaveLength(64);
        return [{
          id: 'uuid123',
          incident_tag: 'tag',
          proposed_command: 'cmd',
          override_reason: 'other',
          service: 'api',
          environment: 'production',
          day_of_week: 1,
          hour_of_day: 12,
          actor: 'alice',
          recorded_at: new Date(),
        }];
      }
      return [];
    });

    const store = new PgOverrideCorpus();
    await store.recordOverride({
      incidentTag: 'db_fail',
      proposedCommand: 'kubectl restart api',
      overrideReason: 'wrong-fix',
      service: 'api',
      environment: 'production',
      actor: 'bob',
    });

    expect(queryCount).toBe(2);

    mockSql.mockReset();
    queryCount = 0;
    mockSql.mockImplementation(async (strings: TemplateStringsArray, ...values: any[]) => {
      queryCount++;
      const queryText = strings.join('?');
      if (queryText.includes('SELECT hash FROM override_corpus')) {
        return [{ hash: firstHash }];
      }
      if (queryText.includes('INSERT INTO override_corpus')) {
        const prevHash = values[values.length - 1];
        const secondHash = values[values.length - 2];
        expect(prevHash).toBe(firstHash);
        expect(secondHash).toHaveLength(64);
        expect(secondHash).not.toBe(firstHash);
        return [{
          id: 'uuid456',
          incident_tag: 'tag2',
          proposed_command: 'cmd2',
          override_reason: 'other',
          service: 'checkout',
          environment: 'production',
          day_of_week: 1,
          hour_of_day: 13,
          actor: 'alice',
          recorded_at: new Date(),
        }];
      }
      return [];
    });

    await store.recordOverride({
      incidentTag: 'db_fail_2',
      proposedCommand: 'kubectl restart checkout',
      overrideReason: 'wrong-fix',
      service: 'checkout',
      environment: 'production',
      actor: 'bob',
    });

    expect(queryCount).toBe(2);
  });
});

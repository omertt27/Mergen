/**
 * override-pack.test.ts — Policy pack export/import on the real file-backed
 * override corpus (scratch MERGEN_DATA_DIR, no mocks).
 *
 * Covers:
 *   1. importOverrides preserves the pattern's dayOfWeek/hourOfDay (unlike
 *      recordOverride, which stamps the current clock) and tags provenance.
 *   2. Import is idempotent — same pattern key is skipped on re-import.
 *   3. buildOverridePack strips team-local provenance and excludes
 *      community-sourced entries unless asked.
 *   4. Imported entries participate in the corpus gate (hasRecentOverride).
 *   5. loadCommunityCorpus seeds entries with their intended time windows —
 *      regression for the seeder discarding dayOfWeek/hourOfDay.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { OverridePackEntry } from '../intelligence/override-corpus.js';

let tmpDir: string;
let corpus: typeof import('../intelligence/override-corpus.js');
let seeds: typeof import('../seeds/community-corpus.js');

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mergen-override-pack-test-'));
  process.env.MERGEN_DATA_DIR = tmpDir;
  corpus = await import('../intelligence/override-corpus.js');
  seeds  = await import('../seeds/community-corpus.js');
});

afterAll(() => {
  delete process.env.MERGEN_DATA_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const FRIDAY_ENTRY: OverridePackEntry = {
  incidentTag:     'pack_test_db_pool',
  proposedCommand: 'ALTER SYSTEM SET max_connections = 300',
  overrideReason:  'compliance-hold',
  rationale:       'Friday settlement window — resize needs DBA sign-off',
  service:         'pack-test-postgres',
  environment:     'production',
  dayOfWeek:       5,
  hourOfDay:       14,
};

describe('importOverrides', () => {
  it('preserves dayOfWeek/hourOfDay and tags community provenance', () => {
    const result = corpus.importOverrides([FRIDAY_ENTRY]);
    expect(result).toEqual({ imported: 1, skipped: 0 });

    const events = corpus.getAllOverrides().filter((e) => e.incidentTag === 'pack_test_db_pool');
    expect(events).toHaveLength(1);
    expect(events[0].dayOfWeek).toBe(5);
    expect(events[0].hourOfDay).toBe(14);
    expect(events[0].source).toBe('community');
    expect(events[0].actor).toBe('community');
    expect(events[0].expiresAt).toBe(0); // packs are permanent by default
    expect(events[0].rationale).toContain('Friday settlement window');
  });

  it('is idempotent — re-importing the same pattern key is skipped', () => {
    const result = corpus.importOverrides([FRIDAY_ENTRY]);
    expect(result).toEqual({ imported: 0, skipped: 1 });
    expect(corpus.getAllOverrides().filter((e) => e.incidentTag === 'pack_test_db_pool')).toHaveLength(1);
  });

  it('applies expiresInDays as a relative lifetime', () => {
    const before = Date.now();
    corpus.importOverrides([{
      ...FRIDAY_ENTRY,
      incidentTag: 'pack_test_expiring',
      expiresInDays: 30,
    }]);
    const [event] = corpus.getAllOverrides().filter((e) => e.incidentTag === 'pack_test_expiring');
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1_000;
    expect(event.expiresAt).toBeGreaterThanOrEqual(before + thirtyDaysMs);
    expect(event.expiresAt).toBeLessThanOrEqual(Date.now() + thirtyDaysMs);
  });

  it('imported entries fire the corpus gate for their time window', () => {
    expect(corpus.hasRecentOverride('pack_test_db_pool', 'pack-test-postgres', 5, 14)).toBe(true);
    expect(corpus.hasRecentOverride('pack_test_db_pool', 'pack-test-postgres', 5, 15)).toBe(true);  // ±1h window
    expect(corpus.hasRecentOverride('pack_test_db_pool', 'pack-test-postgres', 2, 14)).toBe(false); // wrong day
  });
});

describe('buildOverridePack', () => {
  it('excludes community entries by default and strips provenance', () => {
    corpus.recordOverride({
      incidentTag:     'pack_test_team_entry',
      proposedCommand: 'kubectl rollout restart deployment/api',
      overrideReason:  'wrong-fix',
      service:         'pack-test-api',
      environment:     'production',
      actor:           'alice@team.com',
    });

    const pack = corpus.buildOverridePack(corpus.getAllOverrides(), { name: 'team-pack' });
    expect(pack.format).toBe('mergen-pack');
    expect(pack.version).toBe(1);
    expect(pack.name).toBe('team-pack');
    expect(pack.entryCount).toBe(pack.entries.length);

    const tags = pack.entries.map((e) => e.incidentTag);
    expect(tags).toContain('pack_test_team_entry');
    expect(tags).not.toContain('pack_test_db_pool'); // community-sourced import excluded

    // Provenance stripped: no ids, actors, or timestamps in the shareable form.
    for (const entry of pack.entries) {
      expect(entry).not.toHaveProperty('id');
      expect(entry).not.toHaveProperty('actor');
      expect(entry).not.toHaveProperty('recordedAt');
      expect(entry).not.toHaveProperty('source');
    }
  });

  it('includes community entries when asked, and the pack round-trips through import', () => {
    const pack = corpus.buildOverridePack(corpus.getAllOverrides(), { includeCommunity: true });
    expect(pack.entries.map((e) => e.incidentTag)).toContain('pack_test_db_pool');

    // Re-importing an exported pack into the same corpus is a no-op (all keys exist)
    // except team entries, whose pack key (original day/hour) matches too.
    const result = corpus.importOverrides(pack.entries);
    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(pack.entries.length);
  });
});

describe('loadCommunityCorpus (seeder regression)', () => {
  it('seeds entries with their intended time windows, not the current clock', () => {
    const { loaded } = seeds.loadCommunityCorpus();
    expect(loaded).toBeGreaterThan(0);

    // The canonical "Friday settlement window" seed must land on Friday 14:00 UTC
    // regardless of when the server first started.
    const settlement = corpus.getAllOverrides().filter(
      (e) => e.incidentTag === 'infra_db_connection_pool' && e.service === 'postgres' && e.hourOfDay === 14,
    );
    expect(settlement).toHaveLength(1);
    expect(settlement[0].dayOfWeek).toBe(5);
    expect(settlement[0].source).toBe('community');

    // Idempotent on restart.
    const second = seeds.loadCommunityCorpus();
    expect(second.loaded).toBe(0);
    expect(second.skipped).toBeGreaterThan(0);
  });
});

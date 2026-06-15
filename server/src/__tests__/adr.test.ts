/**
 * adr.test.ts — Tests for the ADR store and REST route.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { adrStore } from '../sensor/adr-store.js';

describe('adrStore', () => {
  it('is seeded with the five initial ADRs', () => {
    const all = adrStore.list();
    expect(all.length).toBeGreaterThanOrEqual(5);
    const ids = all.map((a) => a.id);
    expect(ids).toContain('ADR-001');
    expect(ids).toContain('ADR-002');
    expect(ids).toContain('ADR-003');
    expect(ids).toContain('ADR-004');
    expect(ids).toContain('ADR-005');
  });

  it('get() retrieves an ADR by exact ID', () => {
    const adr = adrStore.get('ADR-001');
    expect(adr).toBeDefined();
    expect(adr?.title.toLowerCase()).toContain('ring buffer');
  });

  it('get() is case-insensitive', () => {
    expect(adrStore.get('adr-001')).toBeDefined();
    expect(adrStore.get('ADR-001')).toBeDefined();
  });

  it('get() returns undefined for unknown IDs', () => {
    expect(adrStore.get('ADR-999')).toBeUndefined();
  });

  it('list() with query filters by title', () => {
    const results = adrStore.list('buffer');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].id).toBe('ADR-001');
  });

  it('list() with query filters by rationale text', () => {
    const results = adrStore.list('MCP');
    expect(results.some((r) => r.id === 'ADR-002')).toBe(true);
  });

  it('list() with no query returns all ADRs', () => {
    const all = adrStore.list();
    const filtered = adrStore.list(undefined);
    expect(all.length).toBe(filtered.length);
  });

  it('every ADR has required fields', () => {
    for (const adr of adrStore.list()) {
      expect(adr.id).toBeTruthy();
      expect(adr.title).toBeTruthy();
      expect(adr.decision).toBeTruthy();
      expect(adr.rationale).toBeTruthy();
      expect(['proposed', 'accepted', 'deprecated', 'superseded']).toContain(adr.status);
    }
  });
});

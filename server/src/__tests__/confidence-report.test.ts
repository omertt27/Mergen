/**
 * confidence-report.test.ts — Tests for the confidence report store and formatter.
 */

import { describe, it, expect } from 'vitest';
import { confidenceStore, formatConfidenceReport } from '../intelligence/confidence-report.js';

describe('confidenceStore', () => {
  it('add() returns a report with an auto-assigned ID', () => {
    const report = confidenceStore.add({
      confidence: 0.82,
      scope: 'Add Stripe webhook handler',
      assumptions: ['Stripe signature validation already exists'],
      unknowns: ['Retry semantics not documented'],
      filesModified: ['src/routes/stripe.ts'],
      rationale: 'Familiar with the existing webhook pattern',
    });

    expect(report.id).toMatch(/^CR-\d{4}$/);
    expect(report.confidence).toBe(0.82);
    expect(report.scope).toBe('Add Stripe webhook handler');
    expect(report.createdAt).toBeTruthy();
  });

  it('add() stores the report and list() returns it', () => {
    const before = confidenceStore.list(50).length;
    confidenceStore.add({
      confidence: 0.9,
      scope: 'Test report',
      assumptions: [],
      unknowns: [],
      filesModified: [],
      rationale: '',
    });
    const after = confidenceStore.list(50).length;
    expect(after).toBe(before + 1);
  });

  it('get() retrieves a report by ID', () => {
    const added = confidenceStore.add({
      confidence: 0.5,
      scope: 'Lookup test',
      assumptions: [],
      unknowns: ['Unknown A'],
      filesModified: ['src/foo.ts'],
      rationale: '',
    });
    const found = confidenceStore.get(added.id);
    expect(found).toBeDefined();
    expect(found?.scope).toBe('Lookup test');
  });

  it('get() returns undefined for unknown IDs', () => {
    expect(confidenceStore.get('CR-9999')).toBeUndefined();
  });

  it('list() returns most recent first', () => {
    const r1 = confidenceStore.add({ confidence: 0.7, scope: 'First', assumptions: [], unknowns: [], filesModified: [], rationale: '' });
    const r2 = confidenceStore.add({ confidence: 0.8, scope: 'Second', assumptions: [], unknowns: [], filesModified: [], rationale: '' });
    const list = confidenceStore.list(5);
    expect(list[0].id).toBe(r2.id);
    expect(list[1].id).toBe(r1.id);
  });
});

describe('formatConfidenceReport', () => {
  it('includes the confidence percentage and label', () => {
    const report = confidenceStore.add({
      confidence: 0.82,
      scope: 'Format test',
      assumptions: ['A1'],
      unknowns: ['U1'],
      filesModified: ['src/x.ts'],
      rationale: 'Looks straightforward',
    });
    const text = formatConfidenceReport(report);
    expect(text).toContain('82%');
    expect(text).toContain('MEDIUM-HIGH');
  });

  it('lists assumptions and unknowns', () => {
    const report = confidenceStore.add({
      confidence: 0.6,
      scope: 'Format test 2',
      assumptions: ['Database schema is unchanged'],
      unknowns: ['Rate limit behavior'],
      filesModified: [],
      rationale: '',
    });
    const text = formatConfidenceReport(report);
    expect(text).toContain('Database schema is unchanged');
    expect(text).toContain('Rate limit behavior');
  });

  it('shows a low-confidence warning when score < 0.6', () => {
    const report = confidenceStore.add({
      confidence: 0.4,
      scope: 'Low confidence test',
      assumptions: [],
      unknowns: ['Almost everything'],
      filesModified: [],
      rationale: '',
    });
    const text = formatConfidenceReport(report);
    expect(text).toContain('Low confidence');
  });

  it('does not show a warning at confidence >= 0.6', () => {
    const report = confidenceStore.add({
      confidence: 0.75,
      scope: 'High enough',
      assumptions: [],
      unknowns: [],
      filesModified: [],
      rationale: '',
    });
    const text = formatConfidenceReport(report);
    expect(text).not.toContain('Low confidence');
  });
});

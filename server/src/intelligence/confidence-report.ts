/**
 * confidence-report.ts — Structured pre-implementation confidence declarations.
 *
 * Before making changes an agent calls report_confidence with its plan.
 * The report captures what the agent knows, what it's assuming, and what it
 * doesn't know — making the implicit explicit and queryable.
 *
 * Stored in memory (last 100 reports) and optionally surfaced via REST.
 */

import { z } from 'zod';

export const ConfidenceReportSchema = z.object({
  /** Unique ID assigned on creation. */
  id: z.string().optional(),
  /** 0.0 (no confidence) to 1.0 (fully certain). */
  confidence: z.number().min(0).max(1),
  /** What this report covers — e.g. "Add Stripe webhook handler" */
  scope: z.string().min(1).max(300),
  /** Things the agent is treating as true without verifying. */
  assumptions: z.array(z.string().max(500)).default([]),
  /** Open questions that could affect correctness. */
  unknowns: z.array(z.string().max(500)).default([]),
  /** Source files this change will touch. */
  filesModified: z.array(z.string().max(500)).default([]),
  /** Human-readable explanation for the confidence score. */
  rationale: z.string().max(1000).default(''),
});

export type ConfidenceReport = z.infer<typeof ConfidenceReportSchema> & { id: string; createdAt: string };

function confidenceLabel(score: number): string {
  if (score >= 0.9) return 'HIGH';
  if (score >= 0.75) return 'MEDIUM-HIGH';
  if (score >= 0.6) return 'MEDIUM';
  if (score >= 0.4) return 'LOW-MEDIUM';
  return 'LOW';
}

class ConfidenceStore {
  private readonly MAX = 100;
  private reports: ConfidenceReport[] = [];
  private counter = 0;

  add(input: Omit<ConfidenceReport, 'id' | 'createdAt'>): ConfidenceReport {
    this.counter += 1;
    const report: ConfidenceReport = {
      ...input,
      id: `CR-${String(this.counter).padStart(4, '0')}`,
      createdAt: new Date().toISOString(),
    };
    this.reports.push(report);
    if (this.reports.length > this.MAX) this.reports.shift();
    return report;
  }

  list(limit = 20): ConfidenceReport[] {
    return this.reports.slice(-limit).reverse();
  }

  get(id: string): ConfidenceReport | undefined {
    return this.reports.find((r) => r.id === id);
  }
}

export const confidenceStore = new ConfidenceStore();

/** Format a confidence report as a human-readable markdown block. */
export function formatConfidenceReport(r: ConfidenceReport): string {
  const label = confidenceLabel(r.confidence);
  const pct   = Math.round(r.confidence * 100);
  const lines: string[] = [
    `## Confidence Report ${r.id}`,
    '',
    `**Scope:** ${r.scope}`,
    `**Confidence:** ${pct}% (${label})  |  **Filed:** ${r.createdAt}`,
    '',
  ];

  if (r.rationale) {
    lines.push(`**Rationale:** ${r.rationale}`, '');
  }

  if (r.assumptions.length > 0) {
    lines.push('**Assumptions:**');
    for (const a of r.assumptions) lines.push(`  - ${a}`);
    lines.push('');
  }

  if (r.unknowns.length > 0) {
    lines.push('**Unknowns:**');
    for (const u of r.unknowns) lines.push(`  - ${u}`);
    lines.push('');
  }

  if (r.filesModified.length > 0) {
    lines.push('**Files to modify:**');
    for (const f of r.filesModified) lines.push(`  - \`${f}\``);
    lines.push('');
  }

  if (r.confidence < 0.6) {
    lines.push('> ⚠ **Low confidence** — resolve unknowns before proceeding or halt and present an impact report.');
  }

  return lines.join('\n');
}

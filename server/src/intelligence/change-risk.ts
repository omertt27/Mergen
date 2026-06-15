/**
 * change-risk.ts — Pre-edit change risk scoring.
 *
 * Given a list of files an agent intends to modify, computes a risk score
 * (0–100) and a structured breakdown. Scores ≥ 70 should require human
 * approval before proceeding.
 *
 * Risk factors and weights:
 *   +8   per file modified
 *   +15  per additional subsystem touched (first subsystem is free)
 *   +20  per routes/* file (public API surface change)
 *   +25  per critical entry point touched (app.ts, index.ts)
 *   +5   per test file that imports a modified file (blast radius on test suite)
 *   +10  per modified file with zero test coverage (no test imports it)
 *
 * Approval thresholds:
 *   < 40  LOW    — auto-approve
 *   40-69 MEDIUM — flag for review (call report_confidence first)
 *   ≥ 70  HIGH   — require explicit human sign-off before proceeding
 */

import path from 'path';
import { buildGraph, getZone, ZONE_DISPLAY, type ArchZone } from './arch-graph.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';

export interface RiskFactor {
  label: string;
  delta: number;
  detail: string;
}

export interface ChangeRiskReport {
  score: number;          // 0–100
  level: RiskLevel;
  requiresApproval: boolean;
  files: number;
  subsystems: ArchZone[];
  publicApiFiles: string[];
  criticalEntryPoints: string[];
  testsAffected: number;
  untestedFiles: string[];
  factors: RiskFactor[];
  recommendation: string;
}

const CRITICAL_ENTRY_POINTS = new Set(['app.ts', 'index.ts', 'cli.ts']);

// ── Scorer ────────────────────────────────────────────────────────────────────

export function scoreChangeRisk(filesModified: string[], srcDir: string): ChangeRiskReport {
  const graph = buildGraph(srcDir);
  const factors: RiskFactor[] = [];
  let score = 0;

  // ── Files ─────────────────────────────────────────────────────────────────
  const fileCount = filesModified.length;
  const fileDelta = fileCount * 8;
  score += fileDelta;
  factors.push({ label: 'Files modified', delta: fileDelta, detail: `${fileCount} file(s) × 8` });

  // ── Subsystems ────────────────────────────────────────────────────────────
  const zones = new Set<ArchZone>();
  for (const f of filesModified) zones.add(getZone(f));
  zones.delete('other');
  const subsystems = [...zones] as ArchZone[];
  if (subsystems.length > 1) {
    const delta = (subsystems.length - 1) * 15;
    score += delta;
    factors.push({ label: 'Cross-subsystem change', delta, detail: `${subsystems.length} subsystems: ${subsystems.join(', ')}` });
  }

  // ── Public API surface (routes/*) ────────────────────────────────────────
  const publicApiFiles = filesModified.filter((f) => getZone(f) === 'routes');
  if (publicApiFiles.length > 0) {
    const delta = publicApiFiles.length * 20;
    score += delta;
    factors.push({ label: 'Public API changes', delta, detail: `${publicApiFiles.length} route file(s)` });
  }

  // ── Critical entry points ─────────────────────────────────────────────────
  const criticalEntryPoints = filesModified.filter((f) => CRITICAL_ENTRY_POINTS.has(path.basename(f)));
  if (criticalEntryPoints.length > 0) {
    const delta = criticalEntryPoints.length * 25;
    score += delta;
    factors.push({ label: 'Critical entry points', delta, detail: criticalEntryPoints.map((f) => path.basename(f)).join(', ') });
  }

  // ── Test blast radius ─────────────────────────────────────────────────────
  const affectedTestFiles = new Set<string>();
  for (const f of filesModified) {
    const dependents = graph.reverse.get(f) ?? new Set();
    for (const dep of dependents) {
      if (dep.endsWith('.test.ts')) affectedTestFiles.add(dep);
    }
  }
  const testCount = affectedTestFiles.size;
  if (testCount > 0) {
    const delta = testCount * 5;
    score += delta;
    factors.push({ label: 'Tests affected', delta, detail: `${testCount} test file(s) will need verification` });
  }

  // ── Untested files ────────────────────────────────────────────────────────
  const untestedFiles = filesModified.filter((f) => {
    if (f.endsWith('.test.ts') || f.endsWith('.d.ts')) return false;
    const importers = graph.reverse.get(f) ?? new Set();
    return ![...importers].some((imp) => imp.endsWith('.test.ts'));
  });
  if (untestedFiles.length > 0) {
    const delta = untestedFiles.length * 10;
    score += delta;
    factors.push({ label: 'Untested files', delta, detail: `${untestedFiles.length} file(s) have no test coverage` });
  }

  const clampedScore = Math.min(100, score);
  const level: RiskLevel = clampedScore >= 70 ? 'HIGH' : clampedScore >= 40 ? 'MEDIUM' : 'LOW';
  const requiresApproval = clampedScore >= 70;

  const recommendation = requiresApproval
    ? 'HIGH RISK: Get explicit human sign-off before proceeding. File a confidence report and rollback plan first.'
    : level === 'MEDIUM'
      ? 'MEDIUM RISK: File a confidence report (report_confidence) and rollback plan (plan_rollback) before proceeding.'
      : 'LOW RISK: Proceed. File a confidence report if confidence < 0.8.';

  return {
    score: clampedScore,
    level,
    requiresApproval,
    files: fileCount,
    subsystems,
    publicApiFiles,
    criticalEntryPoints,
    testsAffected: testCount,
    untestedFiles,
    factors,
    recommendation,
  };
}

export function formatRiskReport(r: ChangeRiskReport): string {
  const badge = r.level === 'HIGH' ? '🔴 HIGH' : r.level === 'MEDIUM' ? '🟡 MEDIUM' : '🟢 LOW';
  const lines: string[] = [
    `## Change Risk Score: ${r.score}/100 — ${badge}`,
    '',
    r.requiresApproval
      ? '> ⛔ **Human approval required** before making these changes.'
      : r.level === 'MEDIUM'
        ? '> ⚠ **Review recommended.** File confidence report and rollback plan first.'
        : '> ✅ Safe to proceed.',
    '',
    `**Files:** ${r.files}  |  **Subsystems:** ${r.subsystems.join(', ') || 'none'}  |  **Tests affected:** ${r.testsAffected}`,
    '',
    '### Risk factors',
    '',
  ];

  for (const f of r.factors) {
    lines.push(`| +${f.delta} | **${f.label}** | ${f.detail} |`);
  }
  if (r.factors.length === 0) lines.push('*No significant risk factors.*');
  lines.push('');

  if (r.untestedFiles.length > 0) {
    lines.push('### Untested files (add coverage before proceeding)', '');
    for (const f of r.untestedFiles) lines.push(`  - \`${path.basename(f)}\``);
    lines.push('');
  }

  lines.push(`**Recommendation:** ${r.recommendation}`);
  return lines.join('\n');
}

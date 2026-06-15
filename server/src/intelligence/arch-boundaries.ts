/**
 * arch-boundaries.ts — Architectural boundary rules and violation detection.
 *
 * Defines which layers (zones) may import from which other layers. Violations
 * are reported as structured findings that can be surfaced by the
 * check_arch_violations MCP tool, the GET /arch/violations REST endpoint,
 * and the post-implementation critic.
 *
 * Default rules (Mergen's own architecture):
 *   sensor       → cannot import routes or intelligence
 *   intelligence → cannot import routes
 *   datadog      → cannot import routes or intelligence
 *   routes       → unrestricted (consumes all other layers)
 *
 * Custom rules can be supplied at call time or stored in mergen-arch.json at
 * the project root.
 */

import path from 'path';
import { buildGraph, getZone, type ArchZone } from './arch-graph.js';

// ── Rule definitions ──────────────────────────────────────────────────────────

export interface BoundaryRule {
  fromZone: ArchZone;
  cannotImport: ArchZone[];
  rationale: string;
}

export const DEFAULT_BOUNDARY_RULES: BoundaryRule[] = [
  {
    fromZone: 'sensor',
    cannotImport: ['routes', 'intelligence'],
    rationale:
      'sensor/* is the data ingestion and storage layer. ' +
      'Importing routes would create a circular dependency; ' +
      'importing intelligence would tie storage to business logic.',
  },
  {
    fromZone: 'intelligence',
    cannotImport: ['routes'],
    rationale:
      'intelligence/* (MCP tools, analysis) must not depend on route handlers. ' +
      'Routes consume intelligence, not the other way around.',
  },
  {
    fromZone: 'datadog',
    cannotImport: ['routes', 'intelligence'],
    rationale:
      'datadog/* is an external integration adapter. ' +
      'It may only depend on the sensor layer (shared data types and storage).',
  },
];

// ── Violation type ─────────────────────────────────────────────────────────────

export interface BoundaryViolation {
  file: string;
  fromZone: ArchZone;
  importedFile: string;
  importedZone: ArchZone;
  rule: BoundaryRule;
  /** Relative paths for display (less noisy than absolute). */
  relativeFile: string;
  relativeImport: string;
}

// ── Checker ───────────────────────────────────────────────────────────────────

export interface BoundaryCheckOptions {
  srcDir: string;
  rules?: BoundaryRule[];
  /** Limit scan to a specific file (used by the critic for targeted checks). */
  singleFile?: string;
}

export interface BoundaryCheckResult {
  violations: BoundaryViolation[];
  filesChecked: number;
  rulesApplied: number;
  cleanFiles: number;
}

export function checkBoundaries(opts: BoundaryCheckOptions): BoundaryCheckResult {
  const { srcDir, rules = DEFAULT_BOUNDARY_RULES, singleFile } = opts;
  const graph = buildGraph(srcDir);
  const violations: BoundaryViolation[] = [];

  const ruleset = new Map<ArchZone, Set<ArchZone>>();
  for (const rule of rules) {
    ruleset.set(rule.fromZone, new Set(rule.cannotImport));
  }

  const filesToCheck = singleFile ? [singleFile] : graph.files;

  for (const file of filesToCheck) {
    const fromZone = getZone(file);
    const forbidden = ruleset.get(fromZone);
    if (!forbidden) continue;

    const imports = graph.forward.get(file) ?? new Set();
    for (const imported of imports) {
      const importedZone = getZone(imported);
      if (forbidden.has(importedZone)) {
        const rule = rules.find((r) => r.fromZone === fromZone)!;
        violations.push({
          file,
          fromZone,
          importedFile: imported,
          importedZone,
          rule,
          relativeFile: path.relative(srcDir, file),
          relativeImport: path.relative(srcDir, imported),
        });
      }
    }
  }

  const filesWithViolations = new Set(violations.map((v) => v.file));
  const cleanFiles = filesToCheck.filter((f) => getZone(f) !== 'other' && !filesWithViolations.has(f)).length;

  return {
    violations,
    filesChecked: filesToCheck.length,
    rulesApplied: rules.length,
    cleanFiles,
  };
}

/** Format violation findings as a markdown report. */
export function formatBoundaryReport(result: BoundaryCheckResult, srcDir: string): string {
  if (result.violations.length === 0) {
    return [
      '## Architectural Boundary Check: PASS ✅',
      '',
      `${result.filesChecked} files checked · ${result.rulesApplied} rules applied · 0 violations`,
    ].join('\n');
  }

  const byFile = new Map<string, BoundaryViolation[]>();
  for (const v of result.violations) {
    const arr = byFile.get(v.relativeFile) ?? [];
    arr.push(v);
    byFile.set(v.relativeFile, arr);
  }

  const lines: string[] = [
    `## Architectural Boundary Check: FAIL ❌`,
    '',
    `${result.violations.length} violation(s) found in ${byFile.size} file(s). ` +
    `${result.filesChecked} files checked · ${result.rulesApplied} rules applied.`,
    '',
  ];

  for (const [file, vs] of byFile) {
    lines.push(`### \`${file}\``);
    for (const v of vs) {
      lines.push(`  - ❌ **${v.fromZone}** → **${v.importedZone}**: imports \`${v.relativeImport}\``);
      lines.push(`    > ${v.rule.rationale}`);
    }
    lines.push('');
  }

  lines.push('**Fix:** Refactor so that dependencies only flow in the permitted direction (sensor ← intelligence ← routes).');
  return lines.join('\n');
}

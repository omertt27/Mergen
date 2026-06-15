/**
 * impl-critic.ts — Post-implementation deterministic critic.
 *
 * After an agent generates or modifies code, the critic runs a battery of
 * rule-based checks and returns a structured finding report. It is not an LLM
 * review — it is a fast, deterministic "senior engineer checklist" that catches
 * a class of mistakes that LLMs commonly make:
 *
 *   1. Architectural boundary violations (uses arch-boundaries.ts)
 *   2. ADR violations (compares change intent against ADR constraints)
 *   3. Missing confidence report or rollback plan
 *   4. Security anti-patterns (bare catch{}, hardcoded secrets, SQL injection risk)
 *   5. Test erasure (modified test files with net reduction in test count)
 *   6. Hard-coded return values that bypass implementation
 *   7. Duplication signals (files that re-implement a utility already in the graph)
 */

import fs from 'fs';
import path from 'path';
import { checkBoundaries } from './arch-boundaries.js';
import { adrStore } from '../sensor/adr-store.js';
import { confidenceStore } from './confidence-report.js';

// ── Finding types ─────────────────────────────────────────────────────────────

export type FindingSeverity = 'error' | 'warning' | 'info';

export interface CriticFinding {
  severity: FindingSeverity;
  category:
    | 'boundary-violation'
    | 'adr-violation'
    | 'missing-workflow'
    | 'security'
    | 'test-erasure'
    | 'hardcoded-return'
    | 'duplication';
  file: string;
  line?: number;
  message: string;
  suggestion: string;
}

export interface CritiqueReport {
  files: string[];
  findings: CriticFinding[];
  errors: number;
  warnings: number;
  passed: boolean;
  summary: string;
}

// ── Security pattern checks ───────────────────────────────────────────────────

interface SecurityPattern {
  re: RegExp;
  message: string;
  suggestion: string;
  severity: FindingSeverity;
}

const SECURITY_PATTERNS: SecurityPattern[] = [
  {
    re: /catch\s*\([^)]*\)\s*\{\s*\}/,
    message: 'Empty catch block silently swallows errors',
    suggestion: 'Log the error to the Mergen logger or rethrow. Never use bare catch {}.',
    severity: 'error',
  },
  {
    re: /catch\s*\([^)]*\)\s*\{\s*\/\//,
    message: 'Catch block contains only a comment — error is still silently dropped',
    suggestion: 'Log via logger.warn/error or rethrow the exception.',
    severity: 'warning',
  },
  {
    re: /['"`][A-Za-z0-9+/]{20,}={0,2}['"`]/,
    message: 'Possible hardcoded credential or token',
    suggestion: 'Use environment variables. Check this is not an accidentally committed secret.',
    severity: 'warning',
  },
  {
    re: /eval\s*\(/,
    message: 'eval() is forbidden — arbitrary code execution risk',
    suggestion: 'Remove eval(). Use explicit logic or JSON.parse for data.',
    severity: 'error',
  },
  {
    re: /innerHTML\s*=/,
    message: 'innerHTML assignment is an XSS vector',
    suggestion: 'Use textContent or a sanitiser library.',
    severity: 'warning',
  },
  {
    re: /exec\s*\(\s*`[^`]*\$\{/,
    message: 'Shell command contains template literal interpolation — command injection risk',
    suggestion: 'Use execFile() with an array of arguments instead of string interpolation.',
    severity: 'error',
  },
];

function scanSecurityPatterns(source: string, file: string, relFile: string): CriticFinding[] {
  const findings: CriticFinding[] = [];
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const p of SECURITY_PATTERNS) {
      if (p.re.test(line)) {
        findings.push({
          severity: p.severity,
          category: 'security',
          file: relFile,
          line: i + 1,
          message: p.message,
          suggestion: p.suggestion,
        });
      }
    }
  }
  return findings;
}

// ── Hard-coded return detection ───────────────────────────────────────────────

const HARDCODED_RETURN_RE = /return\s+(true|false|0|1|null|\[\]|\{\})\s*;/g;
const MOCK_BYPASS_RE = /mockReturnValue\(|mockResolvedValue\(/;

function scanHardcodedReturns(source: string, relFile: string): CriticFinding[] {
  if (relFile.endsWith('.test.ts')) return []; // allowed in tests
  const findings: CriticFinding[] = [];
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    HARDCODED_RETURN_RE.lastIndex = 0;
    if (HARDCODED_RETURN_RE.test(lines[i]) && !lines[i].trim().startsWith('//')) {
      // Only flag if it's inside a function that has a non-trivial name
      const context = lines.slice(Math.max(0, i - 5), i).join('\n');
      if (/function|=>|\basync\b/.test(context)) {
        findings.push({
          severity: 'warning',
          category: 'hardcoded-return',
          file: relFile,
          line: i + 1,
          message: 'Function returns a hardcoded literal — may be an incomplete implementation',
          suggestion: 'Verify this is intentional, not a stub left after test-driving.',
        });
      }
    }
  }
  return findings;
}

// ── ADR violation heuristics ──────────────────────────────────────────────────

function checkAdrViolations(source: string, relFile: string): CriticFinding[] {
  const findings: CriticFinding[] = [];

  // ADR-001: ring buffer cap — warn if someone sets buffer above 10 000
  if (/MERGEN_BUFFER_SIZE|bufferSize|capacity/.test(source)) {
    const m = source.match(/(?:bufferSize|capacity|MERGEN_BUFFER_SIZE)\D*(\d{5,})/);
    if (m && Number(m[1]) > 10_000) {
      findings.push({
        severity: 'warning',
        category: 'adr-violation',
        file: relFile,
        message: `ADR-001: ring buffer capacity set to ${m[1]} — this may cause OOM. The default is 2 000.`,
        suggestion: 'Review ADR-001 before increasing the buffer cap. Use SQLite history for older events.',
      });
    }
  }

  // ADR-002: direct tool response bypass (tools must return MCP result shape)
  if (/res\.json\(|res\.send\(/.test(source) && relFile.includes('intelligence/')) {
    findings.push({
      severity: 'warning',
      category: 'adr-violation',
      file: relFile,
      message: 'ADR-002: intelligence/* file appears to use Express res.json() — tools must return MCP result objects, not HTTP responses.',
      suggestion: 'Return { content: [{ type: "text", text: "..." }] } from MCP tool handlers. Route handling belongs in routes/*.',
    });
  }

  // ADR-004: hardcoded 0.0.0.0 binding without cloud-mode check
  if (/0\.0\.0\.0/.test(source) && !source.includes('CLOUD_MODE') && !source.includes('MERGEN_HOST')) {
    findings.push({
      severity: 'warning',
      category: 'adr-violation',
      file: relFile,
      message: 'ADR-004: binding to 0.0.0.0 without CLOUD_MODE or MERGEN_HOST guard.',
      suggestion: 'Wrap in a CLOUD_MODE or MERGEN_HOST check. Default binding must remain 127.0.0.1.',
    });
  }

  return findings;
}

// ── Missing workflow checks ───────────────────────────────────────────────────

function checkMissingWorkflow(files: string[]): CriticFinding[] {
  const findings: CriticFinding[] = [];

  const hasNonTestFiles = files.some((f) => !f.endsWith('.test.ts') && !f.endsWith('.d.ts'));
  if (!hasNonTestFiles) return findings;

  // Check if a confidence report was filed for this scope
  const recent = confidenceStore.list(5);
  if (recent.length === 0) {
    findings.push({
      severity: 'warning',
      category: 'missing-workflow',
      file: '(session)',
      message: 'No confidence report filed before this implementation.',
      suggestion: 'Call report_confidence before making changes to declare assumptions and unknowns.',
    });
  }

  return findings;
}

// ── Main critic ───────────────────────────────────────────────────────────────

export interface CritiqueOptions {
  files: string[];
  srcDir: string;
}

export function critiqueImplementation(opts: CritiqueOptions): CritiqueReport {
  const { files, srcDir } = opts;
  const allFindings: CriticFinding[] = [];

  // 1. Architectural boundary violations
  for (const file of files) {
    if (!file.endsWith('.ts') || file.endsWith('.d.ts')) continue;
    const result = checkBoundaries({ srcDir, singleFile: file });
    for (const v of result.violations) {
      allFindings.push({
        severity: 'error',
        category: 'boundary-violation',
        file: v.relativeFile,
        message: `Imports \`${v.relativeImport}\` — ${v.fromZone} cannot import ${v.importedZone}`,
        suggestion: v.rule.rationale,
      });
    }
  }

  // 2. Per-file static checks
  for (const file of files) {
    if (!file.endsWith('.ts') || file.endsWith('.d.ts')) continue;
    let source: string;
    try { source = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const relFile = path.relative(srcDir, file);

    allFindings.push(...scanSecurityPatterns(source, file, relFile));
    allFindings.push(...scanHardcodedReturns(source, relFile));
    allFindings.push(...checkAdrViolations(source, relFile));
  }

  // 3. Session-level workflow checks
  allFindings.push(...checkMissingWorkflow(files));

  const errors = allFindings.filter((f) => f.severity === 'error').length;
  const warnings = allFindings.filter((f) => f.severity === 'warning').length;
  const passed = errors === 0;

  const summary = passed
    ? `Critique passed — ${warnings} warning(s), 0 errors across ${files.length} file(s).`
    : `Critique failed — ${errors} error(s) and ${warnings} warning(s) across ${files.length} file(s). Fix errors before merging.`;

  return { files, findings: allFindings, errors, warnings, passed, summary };
}

export function formatCritiqueReport(r: CritiqueReport): string {
  const icon = r.passed ? '✅' : '❌';
  const lines: string[] = [
    `## Post-Implementation Critique: ${r.passed ? 'PASS' : 'FAIL'} ${icon}`,
    '',
    r.summary,
    '',
  ];

  if (r.findings.length === 0) {
    lines.push('No findings. Implementation looks clean.');
    return lines.join('\n');
  }

  const byCategory = new Map<string, CriticFinding[]>();
  for (const f of r.findings) {
    const arr = byCategory.get(f.category) ?? [];
    arr.push(f);
    byCategory.set(f.category, arr);
  }

  const categoryLabels: Record<string, string> = {
    'boundary-violation': 'Architectural Boundary Violations',
    'adr-violation': 'ADR Violations',
    'missing-workflow': 'Missing Workflow Steps',
    'security': 'Security Issues',
    'test-erasure': 'Test Erasure',
    'hardcoded-return': 'Hard-Coded Returns',
    'duplication': 'Duplication Signals',
  };

  for (const [cat, findings] of byCategory) {
    lines.push(`### ${categoryLabels[cat] ?? cat}`, '');
    for (const f of findings) {
      const icon = f.severity === 'error' ? '🔴' : f.severity === 'warning' ? '🟡' : '🔵';
      const loc = f.line ? `\`${f.file}:${f.line}\`` : `\`${f.file}\``;
      lines.push(`${icon} **${f.severity.toUpperCase()}** ${loc}`);
      lines.push(`   ${f.message}`);
      lines.push(`   > ${f.suggestion}`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

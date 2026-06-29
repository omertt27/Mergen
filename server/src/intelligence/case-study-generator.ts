/**
 * case-study-generator.ts — Converts raw blunder log events into publishable
 * case study narratives.
 *
 * Each blunder event records a real agent action that Mergen blocked. This
 * module anonymizes the event (replacing service names and PIDs with stable
 * opaque identifiers) and generates a two-sentence narrative suitable for
 * a customer-facing case study or website.
 *
 * Anonymization rules:
 *   Service names → svc-{sha256(name).slice(0,6)}
 *   PIDs          → sequential case IDs (case-001, case-002, ...)
 *   Timestamps    → relative ("3 days ago", "11 days ago")
 *   File paths    → path segments beyond depth-2 are redacted
 *   Credentials   → entire command redacted when PII shield fires
 *
 * Export formats: JSON (default) and Markdown.
 */

import { createHash } from 'crypto';
import type { BlunderEvent, BlunderType } from '../sensor/agent-blunder-store.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CaseStudy {
  caseId: string;
  recordedRelative: string;
  blunderType: BlunderType;
  anonymizedService: string;
  anonymizedCommand: string | null;
  narrative: string;
  policyTriggered: string;
  alternativeSuggested: string;
}

export interface CaseStudyReport {
  generatedAt: string;
  totalBlocks: number;
  cases: CaseStudy[];
}

// ── Anonymization helpers ─────────────────────────────────────────────────────

function anonService(name: string | null): string {
  if (!name) return 'svc-unknown';
  const hash = createHash('sha256').update(name).digest('hex').slice(0, 6);
  return `svc-${hash}`;
}

function relativeTime(ts: number): string {
  const diffMs   = Date.now() - ts;
  const diffMins = Math.floor(diffMs / 60_000);
  const diffHrs  = Math.floor(diffMs / 3_600_000);
  const diffDays = Math.floor(diffMs / 86_400_000);

  if (diffMins < 60)  return `${diffMins} minute${diffMins !== 1 ? 's' : ''} ago`;
  if (diffHrs  < 24)  return `${diffHrs} hour${diffHrs !== 1 ? 's' : ''} ago`;
  if (diffDays < 60)  return `${diffDays} day${diffDays !== 1 ? 's' : ''} ago`;
  return `${Math.floor(diffDays / 30)} month${Math.floor(diffDays / 30) !== 1 ? 's' : ''} ago`;
}

const CREDENTIAL_PATTERNS = [
  /[A-Za-z0-9+/]{32,}={0,2}/,               // base64-ish
  /(?:AKIA|ASIA)[A-Z0-9]{16}/,               // AWS access key
  /(?:password|secret|token|key)\s*[:=]\s*\S+/i,
  /Bearer\s+[A-Za-z0-9._-]+/i,
];

function sanitizeCommand(cmd: string | null): string | null {
  if (!cmd) return null;

  // Redact if credential-shaped content detected.
  if (CREDENTIAL_PATTERNS.some((re) => re.test(cmd))) {
    return '[command redacted — contained potential credential]';
  }

  // Truncate deep file paths: /a/b/c/d/... → /a/b/…
  return cmd.replace(/(?:\/[\w.-]+){3,}/g, (match) => {
    const parts = match.split('/').filter(Boolean);
    return '/' + parts.slice(0, 2).join('/') + '/…';
  });
}

// ── Narrative generation ──────────────────────────────────────────────────────

const BLUNDER_TYPE_LABELS: Record<BlunderType, string> = {
  allowlist_block:       'allowlist policy',
  injection_attempt:     'prompt injection detection',
  rbac_block:            'RBAC role check',
  override_corpus_block: 'override corpus (prior human decision)',
  pipeline_block:        'governance pipeline',
  planning_gate_block:   'planning gate (blast-radius / confidence check)',
};

const ALTERNATIVES: Record<BlunderType, string> = {
  allowlist_block:
    'verify the action is on the approved allowlist, or submit an override request',
  injection_attempt:
    'rephrase the request without instruction-injection patterns',
  rbac_block:
    'request elevated permissions through the access-control workflow',
  override_corpus_block:
    'review the prior override decision and open a HITL approval if the context has changed',
  pipeline_block:
    'reduce the blast radius of the action or increase diagnostic confidence before retrying',
  planning_gate_block:
    'narrow the action scope and resubmit once confidence exceeds the configured threshold',
};

function buildNarrative(
  anonSvc: string,
  cmd: string | null,
  blunderType: BlunderType,
  blockReason: string,
): string {
  const cmdPhrase = cmd ? `attempted \`${cmd}\`` : 'attempted an unrecorded action';
  const policyLabel = BLUNDER_TYPE_LABELS[blunderType] ?? blunderType;
  const alt = ALTERNATIVES[blunderType] ?? 'reformulate the request within policy bounds';

  return (
    `An AI agent targeting ${anonSvc} ${cmdPhrase}. ` +
    `Mergen intercepted the call at the ${policyLabel} layer in <1ms — ` +
    `the agent received a structured error explaining why the action was blocked ` +
    `(${blockReason.slice(0, 120)}${blockReason.length > 120 ? '…' : ''}) ` +
    `and was guided to ${alt}.`
  );
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Convert an array of BlunderEvents into anonymized CaseStudy objects.
 * Events are deduplicated by (blunderType, sanitizedCommand, anonService)
 * so repeated identical blocks appear as a single case in the report.
 */
export function generateCaseStudies(blunders: readonly BlunderEvent[]): CaseStudy[] {
  const seen = new Set<string>();
  const cases: CaseStudy[] = [];
  let seq = 1;

  // Most recent first so the freshest evidence leads the export.
  const sorted = [...blunders].sort((a, b) => b.recordedAt - a.recordedAt);

  for (const b of sorted) {
    const anonSvc = anonService(b.service);
    const cmd     = sanitizeCommand(b.command);
    const dedupeKey = `${b.blunderType}|${cmd ?? ''}|${anonSvc}`;

    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const caseId   = `case-${String(seq++).padStart(3, '0')}`;
    const narrative = buildNarrative(anonSvc, cmd, b.blunderType, b.blockReason);

    cases.push({
      caseId,
      recordedRelative: relativeTime(b.recordedAt),
      blunderType: b.blunderType,
      anonymizedService: anonSvc,
      anonymizedCommand: cmd,
      narrative,
      policyTriggered: BLUNDER_TYPE_LABELS[b.blunderType] ?? b.blunderType,
      alternativeSuggested: ALTERNATIVES[b.blunderType] ?? 'reformulate within policy bounds',
    });
  }

  return cases;
}

export function buildReport(blunders: readonly BlunderEvent[]): CaseStudyReport {
  return {
    generatedAt: new Date().toISOString(),
    totalBlocks: blunders.length,
    cases: generateCaseStudies(blunders),
  };
}

// ── Markdown renderer ─────────────────────────────────────────────────────────

export function renderMarkdown(report: CaseStudyReport): string {
  const lines: string[] = [
    '# Mergen — Agent Action Case Studies',
    '',
    `> Generated ${report.generatedAt}  `,
    `> ${report.totalBlocks} total agent actions blocked · ${report.cases.length} unique patterns shown`,
    '',
  ];

  for (const c of report.cases) {
    lines.push(`## ${c.caseId} — ${c.blunderType.replace(/_/g, ' ')}`);
    lines.push('');
    lines.push(`**Recorded:** ${c.recordedRelative}  `);
    lines.push(`**Service:** \`${c.anonymizedService}\`  `);
    if (c.anonymizedCommand) {
      lines.push(`**Command attempted:** \`${c.anonymizedCommand}\`  `);
    }
    lines.push(`**Policy triggered:** ${c.policyTriggered}  `);
    lines.push('');
    lines.push(c.narrative);
    lines.push('');
    lines.push(`**Agent was guided to:** ${c.alternativeSuggested}`);
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}
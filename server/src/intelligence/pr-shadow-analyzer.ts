/**
 * pr-shadow-analyzer.ts — Computes what Mergen would post as a PR comment.
 *
 * Called when a PR is opened, updated, or marked ready for review.
 * No comment is actually posted — result is stored in the PR shadow ring buffer.
 *
 * Analysis pipeline:
 *   1. Tokenize PR title + body → keyword set
 *   2. Search commit context archive for historical PRs with keyword overlap
 *   3. Search incident store for incidents tied to this service
 *   4. Compute relevance score: contextScore * 0.6 + incidentScore * 0.4
 *   5. wouldHaveShown = matchedIncidents ≥ 1 AND relevanceScore ≥ 0.7
 *      (Phase 2 comment type 1: high-confidence historical incidents only)
 *
 * The scored output lets us answer, before enabling PR comments:
 *   "Would this have been useful or just noise?"
 */

import path from 'path';
import { commitContextStore } from '../sensor/commit-context-store.js';
import { incidentStore } from '../sensor/incident-store.js';
import { recordPRShadow, type PRShadowResult } from '../sensor/pr-shadow-store.js';
import { getOverrideSummary } from './override-corpus.js';
import { hybridSearch } from './postmortem-retrieval.js';
import { memoryStore } from '../datadog/memory-store.js';
import logger from '../sensor/logger.js';

// ── Tokenizer ─────────────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can',
  'was', 'one', 'have', 'from', 'had', 'has', 'his', 'her', 'its',
  'add', 'fix', 'use', 'update', 'this', 'that', 'with', 'into',
  'feat', 'chore', 'refactor', 'docs', 'test',
]);

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w)),
  );
}

function overlapScore(query: Set<string>, doc: Set<string>): number {
  if (query.size === 0 || doc.size === 0) return 0;
  let overlap = 0;
  for (const t of query) { if (doc.has(t)) overlap++; }
  // Jaccard-like: overlap / union to penalise very short query sets
  return overlap / Math.max(query.size, 3);
}

// ── Comment builder ───────────────────────────────────────────────────────────

interface ContextMatch {
  title: string;
  author: string;
  prNumber: number | null;
  daysAgo: number;
  rationale?: string | null;
  aiGenerated?: boolean;
}

interface IncidentMatch {
  hypothesis: string;
  daysAgo: number;
  confidence: number;
  resolvedAutonomously?: boolean;
  causallyCorrect?: boolean;
}

interface OperationalConstraint {
  tag: string;
  topReason: string;
  count: number;
}

interface FileDangerMatch {
  file: string;
  /** Incidents from the Datadog memory store that implicated this file. */
  memoryIncidents: number;
  /** Top postmortem corpus hits for this filename. */
  postmortems: Array<{ rootCause: string; confidence: number; service: string }>;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function buildComment(
  prTitle: string,
  matchedContextResults: ContextMatch[],
  matchedIncidentResults: IncidentMatch[],
  operationalConstraints: OperationalConstraint[],
  fileDangerMatches: FileDangerMatch[],
): string {
  const lines: string[] = [
    '## 🔍 Mergen Context',
    '',
  ];

  if (fileDangerMatches.length > 0) {
    lines.push('**Files with production incident history:**');
    for (const f of fileDangerMatches.slice(0, 5)) {
      const parts: string[] = [];
      if (f.memoryIncidents > 0) {
        parts.push(`${f.memoryIncidents} tracked incident${f.memoryIncidents !== 1 ? 's' : ''}`);
      }
      if (f.postmortems.length > 0) {
        const pm = f.postmortems[0];
        parts.push(`corpus: ${truncate(pm.rootCause, 60)} (${Math.round(pm.confidence * 100)}% conf · ${pm.service})`);
      }
      lines.push(`- \`${f.file}\` — ${parts.join('; ')}`);
    }
    lines.push('');
  }

  if (matchedIncidentResults.length > 0) {
    lines.push('**Related incidents from memory:**');
    for (const inc of matchedIncidentResults.slice(0, 3)) {
      const when = inc.daysAgo === 0 ? 'today' : `${inc.daysAgo}d ago`;
      const pct = Math.round(inc.confidence * 100);
      const outcome = inc.causallyCorrect
        ? ' · ✅ fix confirmed'
        : inc.resolvedAutonomously
          ? ' · ⚙️ auto-resolved'
          : '';
      lines.push(`- ${inc.hypothesis} _(${pct}% confidence · ${when}${outcome})_`);
    }
    lines.push('');
  }

  if (matchedContextResults.length > 0) {
    lines.push('**Historical PR context:**');
    for (const ctx of matchedContextResults.slice(0, 3)) {
      const ref = ctx.prNumber ? `#${ctx.prNumber}` : 'direct push';
      const when = ctx.daysAgo === 0 ? 'today' : `${ctx.daysAgo}d ago`;
      const aiTag = ctx.aiGenerated ? ' · 🤖 AI-generated' : '';
      lines.push(`- ${ref}: **${ctx.title}** — @${ctx.author} _(${when}${aiTag})_`);
      if (ctx.rationale) {
        // Show the first sentence of the PR description — this is the "why" that
        // junior engineers need to see: the constraint or reasoning the original
        // author recorded, not just the title.
        const firstSentence = ctx.rationale.split(/[.\n]/)[0]?.trim();
        if (firstSentence && firstSentence.length > 10) {
          lines.push(`  > ${firstSentence.slice(0, 160)}`);
        }
      }
    }
    lines.push('');
  }

  if (operationalConstraints.length > 0) {
    lines.push('**Operational constraints on this service:**');
    for (const c of operationalConstraints.slice(0, 3)) {
      lines.push(`- \`${c.tag}\` overridden ${c.count}× — top reason: \`${c.topReason}\``);
    }
    lines.push('');
  }

  lines.push('_[Mergen shadow mode — not posted yet]_');
  return lines.join('\n');
}

// ── Main analyzer ─────────────────────────────────────────────────────────────

export interface PRAnalysisInput {
  repo: string;
  prNumber: number;
  prTitle: string;
  prBody: string | null;
  author: string;
  branch: string;
  action: string;
  /** File paths changed by this PR — used for diff-level outage pattern matching. */
  changedFiles?: string[];
}

export async function analyzePRForShadow(
  input: PRAnalysisInput,
): Promise<PRShadowResult> {
  const { repo, prNumber, prTitle, prBody, author, branch, action, changedFiles = [] } = input;
  const serviceName = repo.split('/').pop() ?? repo;

  const queryText = [prTitle, prBody ?? ''].join(' ');
  const queryTokens = tokenize(queryText);

  // ── Context archive match ─────────────────────────────────────────────────

  const historicalPRs = commitContextStore.listByRepo(repo, 30);
  const now = Date.now();
  const DAY_MS = 86_400_000;

  const contextMatches: Array<{
    score: number;
    title: string;
    author: string;
    prNumber: number | null;
    daysAgo: number;
    rationale: string | null;
    aiGenerated: boolean;
  }> = [];

  for (const ctx of historicalPRs) {
    if (ctx.prNumber === prNumber) continue; // skip the PR itself if somehow present
    const docText = [ctx.prTitle ?? '', ctx.prBody ?? ''].join(' ');
    const docTokens = tokenize(docText);
    const score = overlapScore(queryTokens, docTokens);
    if (score >= 0.15) {
      contextMatches.push({
        score,
        title: ctx.prTitle ?? '(no title)',
        author: ctx.author ?? 'unknown',
        prNumber: ctx.prNumber,
        daysAgo: Math.floor((now - (ctx.mergedAt ?? ctx.capturedAt)) / DAY_MS),
        rationale: ctx.prBody ?? null,
        aiGenerated: ctx.aiGenerated ?? false,
      });
    }
  }
  contextMatches.sort((a, b) => b.score - a.score);
  const topContextMatches = contextMatches.slice(0, 5);

  const contextScore =
    topContextMatches.length === 0
      ? 0
      : Math.min(1, topContextMatches[0].score * 1.5); // normalise top score → 0–1

  // ── Incident store match ──────────────────────────────────────────────────

  const recentIncidents = incidentStore.list(undefined, 100);
  const incidentMatches: Array<{
    hypothesis: string;
    daysAgo: number;
    confidence: number;
    resolvedAutonomously: boolean;
    causallyCorrect: boolean;
  }> = [];

  const serviceNameLower = serviceName.toLowerCase();
  for (const inc of recentIncidents) {
    const serviceMatch =
      (inc.service ?? '').toLowerCase() === serviceNameLower ||
      (inc.hypothesis ?? '').toLowerCase().includes(serviceNameLower);
    if (serviceMatch) {
      incidentMatches.push({
        hypothesis: inc.hypothesis,
        daysAgo: Math.floor((now - inc.createdAt) / DAY_MS),
        confidence: inc.confidence,
        resolvedAutonomously: inc.resolvedAutonomously ?? false,
        causallyCorrect: inc.causallyCorrect ?? false,
      });
    }
  }
  // Prefer recent and high-confidence
  incidentMatches.sort((a, b) => a.daysAgo - b.daysAgo || b.confidence - a.confidence);
  const topIncidentMatches = incidentMatches.slice(0, 3);

  const incidentScore =
    topIncidentMatches.length === 0
      ? 0
      : Math.min(1, topIncidentMatches.length / 3 + topIncidentMatches[0].confidence * 0.5);

  // ── File danger match — diff-level outage signature detection ────────────
  // For each changed file, check the Datadog memory store (file-level incident
  // history) and the postmortem corpus (BM25+TF-IDF on filename). A file that
  // has previously been implicated in a production incident is a danger signal
  // even when PR title/body keywords don't overlap.

  const fileDangerMatches: FileDangerMatch[] = [];
  for (const file of changedFiles.slice(0, 20)) {
    const base = path.basename(file, path.extname(file));
    const memIncidents = memoryStore.findByFile(file, 3);
    let pmMatches: Array<{ rootCause: string; confidence: number; service: string }> = [];
    if (base.length >= 3) {
      try {
        const pmResults = hybridSearch(base, { topK: 2, maxCorpus: 200 });
        pmMatches = pmResults.map((r) => ({
          rootCause: r.postmortem.rootCause,
          confidence: r.postmortem.confidence,
          service: r.postmortem.service,
        }));
      } catch { /* postmortem store may not be initialised yet */ }
    }
    if (memIncidents.length > 0 || pmMatches.length > 0) {
      fileDangerMatches.push({ file, memoryIncidents: memIncidents.length, postmortems: pmMatches });
    }
  }

  // ── Composite score & decision ────────────────────────────────────────────
  // File danger contributes up to 0.3 of the final score (capped), weighted
  // at 20% so keyword/incident signals still dominate when both are present.

  const fileDangerScore = fileDangerMatches.length > 0
    ? Math.min(0.3, fileDangerMatches.length * 0.15)
    : 0;

  const relevanceScore = Math.min(
    1,
    Math.round((contextScore * 0.5 + incidentScore * 0.3 + fileDangerScore * 0.2) * 1000) / 1000,
  );

  const matchedIncidents = topIncidentMatches.length;
  const matchedContexts = topContextMatches.length;

  const triggeredBy: string[] = [];
  if (matchedIncidents > 0) triggeredBy.push('incident_match');
  if (topContextMatches.some((c) => c.score >= 0.3)) triggeredBy.push('context_match');
  if (historicalPRs.length >= 10) triggeredBy.push('rich_history');
  if (fileDangerMatches.length > 0) triggeredBy.push('file_danger_match');

  // Phase 2 gate: show when we have incident evidence AND high relevance,
  // OR when any changed file has a confirmed incident history (highest-signal
  // case — the diff directly touches code that has broken production before).
  const wouldHaveShown =
    (matchedIncidents >= 1 && relevanceScore >= 0.7) ||
    fileDangerMatches.length >= 1;

  // Build operational constraints section from the override corpus so that
  // junior engineers see why certain actions on this service have been
  // overridden — the "why this constraint exists" layer.
  const overrideSummary = getOverrideSummary()
    .filter((s) => s.services.includes(serviceName))
    .map((s) => ({
      tag: s.tag,
      topReason: s.dominantReason ?? 'other',
      count: s.total,
    }));

  const wouldHaveComment = wouldHaveShown
    ? buildComment(prTitle, topContextMatches, topIncidentMatches, overrideSummary, fileDangerMatches)
    : null;

  const result = recordPRShadow({
    prId: `${repo}#${prNumber}`,
    repo,
    prNumber,
    prTitle,
    author,
    branch,
    action,
    wouldHaveShown,
    relevanceScore,
    matchedIncidents,
    matchedContexts,
    triggeredBy,
    wouldHaveComment,
  });

  logger.info(
    {
      prId: result.prId,
      wouldHaveShown,
      relevanceScore,
      matchedIncidents,
      matchedContexts,
    },
    'pr-shadow: analysis complete',
  );

  return result;
}

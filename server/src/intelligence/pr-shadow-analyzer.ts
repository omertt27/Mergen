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

import { commitContextStore } from '../sensor/commit-context-store.js';
import { incidentStore } from '../sensor/incident-store.js';
import { recordPRShadow, type PRShadowResult } from '../sensor/pr-shadow-store.js';
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

function buildComment(
  prTitle: string,
  matchedContextResults: Array<{ title: string; author: string; prNumber: number | null; daysAgo: number }>,
  matchedIncidentResults: Array<{ hypothesis: string; daysAgo: number; confidence: number }>,
): string {
  const lines: string[] = [
    '## 🔍 Mergen Context',
    '',
  ];

  if (matchedIncidentResults.length > 0) {
    lines.push('**Related incidents from memory:**');
    for (const inc of matchedIncidentResults.slice(0, 3)) {
      const when = inc.daysAgo === 0 ? 'today' : `${inc.daysAgo}d ago`;
      const pct = Math.round(inc.confidence * 100);
      lines.push(`- ${inc.hypothesis} _(${pct}% confidence · ${when})_`);
    }
    lines.push('');
  }

  if (matchedContextResults.length > 0) {
    lines.push('**Historical PR context:**');
    for (const ctx of matchedContextResults.slice(0, 3)) {
      const ref = ctx.prNumber ? `#${ctx.prNumber}` : 'direct push';
      const when = ctx.daysAgo === 0 ? 'today' : `${ctx.daysAgo}d ago`;
      lines.push(`- ${ref}: **${ctx.title}** — @${ctx.author} _(${when})_`);
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
}

export async function analyzePRForShadow(
  input: PRAnalysisInput,
): Promise<PRShadowResult> {
  const { repo, prNumber, prTitle, prBody, author, branch, action } = input;
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

  // ── Composite score & decision ────────────────────────────────────────────

  const relevanceScore = Math.min(
    1,
    Math.round((contextScore * 0.6 + incidentScore * 0.4) * 1000) / 1000,
  );

  const matchedIncidents = topIncidentMatches.length;
  const matchedContexts = topContextMatches.length;

  const triggeredBy: string[] = [];
  if (matchedIncidents > 0) triggeredBy.push('incident_match');
  if (topContextMatches.some((c) => c.score >= 0.3)) triggeredBy.push('context_match');
  if (historicalPRs.length >= 10) triggeredBy.push('rich_history');

  // Phase 2 gate: only show when we have incident evidence AND high relevance.
  // This is the conservative threshold that earns the right to interrupt.
  const wouldHaveShown = matchedIncidents >= 1 && relevanceScore >= 0.7;

  const wouldHaveComment = wouldHaveShown
    ? buildComment(prTitle, topContextMatches, topIncidentMatches)
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

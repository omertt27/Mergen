/**
 * pr-commenter.ts — Posts Mergen context comments on GitHub PRs.
 *
 * Only active when MERGEN_PR_COMMENTS=true.
 * Threshold is 0.85 — stricter than shadow mode's 0.7 gate — so only
 * genuinely high-confidence matches interrupt a reviewer's workflow.
 * De-duplicates in-memory so the same PR never receives a second comment
 * even if multiple synchronize events arrive before the first posts.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { type PRShadowResult } from '../sensor/pr-shadow-store.js';
import { recordHabituationEvent } from '../sensor/habituation-store.js';
import logger from '../sensor/logger.js';

const COMMENT_THRESHOLD = 0.85;

// Keyed by "org/repo#prNumber". Resets on server restart — a duplicate
// comment on restart is less harmful than blocking the pipeline.
const _commented = new Set<string>();

/** True when Mergen has posted a comment on this repo#prNumber in the current process. */
export function hasMergenComment(repoAndPr: string): boolean {
  return _commented.has(repoAndPr);
}

function loadGitHubToken(): string {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    const cfgPath = path.join(os.homedir(), '.mergen', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as Record<string, unknown>;
    const gh = (cfg.github ?? {}) as Record<string, unknown>;
    if (typeof gh.token === 'string' && gh.token) return gh.token;
  } catch {}
  return '';
}

async function postGitHubComment(
  repo: string,
  prNumber: number,
  body: string,
  token: string,
): Promise<void> {
  const res = await fetch(`https://api.github.com/repos/${repo}/issues/${prNumber}/comments`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({ body }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GitHub API ${res.status}: ${text.slice(0, 120)}`);
  }
}

export async function maybePostPRComment(result: PRShadowResult): Promise<void> {
  if (process.env.MERGEN_PR_COMMENTS !== 'true') return;
  if (!result.wouldHaveShown) return;
  if (result.relevanceScore < COMMENT_THRESHOLD) return;
  if (!result.wouldHaveComment) return;

  const key = `${result.repo}#${result.prNumber}`;
  if (_commented.has(key)) return;

  const token = loadGitHubToken();
  if (!token) {
    logger.warn(
      { prId: result.prId },
      'pr-commenter: MERGEN_PR_COMMENTS=true but no GitHub token — set GITHUB_TOKEN or run: mergen-server connect github',
    );
    return;
  }

  // Mark before posting so a concurrent synchronize event can't double-post
  _commented.add(key);

  const liveComment = result.wouldHaveComment.replace(
    /\n_\[Mergen shadow mode — not posted yet\]_\n?/,
    '\n',
  );

  try {
    await postGitHubComment(result.repo, result.prNumber, liveComment, token);
    logger.info(
      { prId: result.prId, score: result.relevanceScore },
      'pr-commenter: comment posted',
    );
    recordHabituationEvent({
      recordedAt: Date.now(),
      eventType: 'comment_posted',
      actor: result.author,
      repo: result.repo,
      prNumber: result.prNumber,
      relevanceScore: result.relevanceScore,
    });
  } catch (err) {
    // Roll back dedup on failure so the next synchronize event can retry
    _commented.delete(key);
    logger.warn({ err, prId: result.prId }, 'pr-commenter: post failed');
  }
}

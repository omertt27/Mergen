/**
 * routes/github-webhook.ts — GitHub webhook receiver.
 *
 * Captures the causal intent behind every AI-influenced code change:
 * PR title + description (business reasoning), linked issues (tickets),
 * human approvers, AI tool attribution, and changed file paths.
 *
 * This is the Pillar 1 data moat: GitHub PR data becomes effectively
 * unrecoverable after ~90 days. We capture it at merge time and store
 * it permanently in the commit context archive.
 *
 * Supported events:
 *   pull_request (closed + merged) — full PR context
 *   pull_request_review             — reviewer/approver capture
 *   push                            — direct-to-branch commits
 *
 * Auth: optional HMAC-SHA256 via GITHUB_WEBHOOK_SECRET env var.
 *
 * Setup in GitHub:
 *   Repository → Settings → Webhooks → Add webhook
 *   Payload URL: https://your-server:3000/webhooks/github
 *   Content type: application/json
 *   Secret: value of GITHUB_WEBHOOK_SECRET
 *   Events: Pull requests, Pull request reviews, Pushes
 */

import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { memoryStore } from '../datadog/memory-store.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { commitContextStore, extractLinkedIssues, type CommitContext } from '../sensor/commit-context-store.js';
import { detectAiCommit } from '../intelligence/ai-commit.js';
import { analyzePRForShadow } from '../intelligence/pr-shadow-analyzer.js';
import { maybePostPRComment, hasMergenComment } from '../intelligence/pr-commenter.js';
import { recordHabituationEvent } from '../sensor/habituation-store.js';
import { type PRShadowResult } from '../sensor/pr-shadow-store.js';
import logger from '../sensor/logger.js';

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

/** Returns file paths changed by a PR via the GitHub REST API. */
async function fetchPRFiles(repo: string, prNumber: number, token: string): Promise<string[]> {
  const url = `https://api.github.com/repos/${repo}/pulls/${prNumber}/files?per_page=100`;
  const res = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) {
    logger.warn({ repo, prNumber, status: res.status }, 'github-webhook: failed to fetch PR files');
    return [];
  }
  const data = await res.json() as Array<{ filename: string }>;
  return data.map((f) => f.filename);
}

/**
 * Post a GitHub Check Run for the Mergen Context Gate.
 * Requires `checks:write` permission on the installation or PAT.
 */
async function maybeCreateCheckRun(
  shadowResult: PRShadowResult,
  headSha: string,
  token: string,
): Promise<void> {
  if (!token) return;

  const HIGH_RELEVANCE = 0.7;
  const isWarning = shadowResult.relevanceScore >= HIGH_RELEVANCE;

  const summary = isWarning
    ? `Mergen found ${shadowResult.matchedIncidents} past incident(s) and ${shadowResult.matchedContexts} PR context(s) related to this change (relevance ${(shadowResult.relevanceScore * 100).toFixed(0)}%).`
    : `No high-relevance incidents found for this PR's changes.`;

  const body = {
    name: 'Mergen Context Gate',
    head_sha: headSha,
    status: 'completed',
    conclusion: isWarning ? 'action_required' : 'success',
    output: {
      title: isWarning ? '⚠️ Related past incidents detected' : '✅ No related incidents',
      summary,
      text: shadowResult.wouldHaveComment ?? '',
    },
  };

  try {
    const res = await fetch(`https://api.github.com/repos/${shadowResult.repo}/check-runs`, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      logger.warn(
        { repo: shadowResult.repo, pr: shadowResult.prNumber, status: res.status },
        'github-webhook: check run post failed (need checks:write scope)',
      );
    } else {
      logger.info(
        { repo: shadowResult.repo, pr: shadowResult.prNumber, conclusion: body.conclusion },
        'github-webhook: check run posted',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'github-webhook: check run error (non-fatal)');
  }
}

// Load secret from env first, then fall back to the file written by
// `mergen connect github` so users don't need to manually set env vars.
function loadWebhookSecret(): string {
  if (process.env.GITHUB_WEBHOOK_SECRET) return process.env.GITHUB_WEBHOOK_SECRET;
  try {
    const secretFile = path.join(os.homedir(), '.mergen', 'github-webhook-secret');
    return fs.readFileSync(secretFile, 'utf8').trim();
  } catch {
    return '';
  }
}

const WEBHOOK_SECRET = loadWebhookSecret();
if (WEBHOOK_SECRET) {
  logger.info('github-webhook: secret loaded (verification enabled)');
} else {
  logger.warn(
    'github-webhook: GITHUB_WEBHOOK_SECRET is not set — signature verification is DISABLED. ' +
    'Any caller can inject fake PR/push events and poison the commit context corpus. ' +
    'Set GITHUB_WEBHOOK_SECRET to the secret configured in your GitHub webhook settings.',
  );
}

function verifySignature(rawBody: Buffer, signature: string | undefined): boolean {
  if (!WEBHOOK_SECRET) return true; // verification disabled if no secret configured
  if (!signature) return false;
  const expected = 'sha256=' + crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

// ── GitHub payload types (minimal — only what we archive) ────────────────────

interface GitHubUser { login: string }

interface GitHubPR {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  user: GitHubUser;
  head: { sha: string; ref: string };
  base: { ref: string };
  merge_commit_sha: string | null;
  merged_at: string | null;
  merged: boolean;
  requested_reviewers?: GitHubUser[];
}

interface PullRequestPayload {
  action: string;
  pull_request: GitHubPR;
  repository: { full_name: string };
}

interface PullRequestReviewPayload {
  action: string;
  review: { state: string; user: GitHubUser };
  pull_request: GitHubPR;
  repository: { full_name: string };
}

interface PushPayload {
  ref: string;
  after: string;
  commits: Array<{
    id: string;
    message: string;
    author: { name: string; email?: string; username?: string };
    added?: string[];
    modified?: string[];
    removed?: string[];
  }>;
  repository: { full_name: string };
  pusher: { name: string };
}

// In-memory cache of approvers collected from review events before the PR merges.
// Keyed by "repo#pr_number". Cleared after merge is captured.
const _pendingApprovers = new Map<string, Set<string>>();

export function createGitHubWebhookRouter(): Router {
  const router = Router();

  router.post('/webhooks/github', (req: Request, res: Response) => {
    const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2 MB
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    req.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        res.status(413).json({ error: 'payload too large' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (res.headersSent) return;
      const rawBody = Buffer.concat(chunks);
      const signature = req.headers['x-hub-signature-256'] as string | undefined;
      const event = req.headers['x-github-event'] as string | undefined;

      if (!verifySignature(rawBody, signature)) {
        res.status(401).json({ error: 'invalid x-hub-signature-256' });
        return;
      }

      let payload: unknown;
      try {
        payload = JSON.parse(rawBody.toString('utf8'));
      } catch {
        res.status(400).json({ error: 'malformed JSON' });
        return;
      }

      // ACK immediately — GitHub retries on 5xx or timeout
      res.json({ status: 'accepted', event });

      // Handle events asynchronously so we don't block the response
      void handleEvent(event ?? '', payload).catch((err: unknown) => {
        logger.warn({ err, event }, 'github-webhook: handler error');
      });
    });
  });

  return router;
}

async function handleEvent(event: string, payload: unknown): Promise<void> {
  if (event === 'pull_request_review') {
    handleReviewEvent(payload as PullRequestReviewPayload);
    return;
  }

  if (event === 'pull_request') {
    const prPayload = payload as PullRequestPayload;
    const { action, pull_request: pr, repository } = prPayload ?? {};

    // Shadow analysis fires on open/update events — before the PR merges.
    // We silently compute what we would have posted and log it for measurement.
    if (
      action === 'opened' ||
      action === 'synchronize' ||
      action === 'ready_for_review'
    ) {
      const headSha = pr?.head?.sha ?? '';
      const ghToken = loadGitHubToken();
      // Fetch changed files eagerly so analyzePRForShadow can run diff-level
      // outage pattern matching against the incident and postmortem corpus.
      const changedFiles = ghToken
        ? await fetchPRFiles(repository?.full_name ?? '', pr?.number ?? 0, ghToken).catch(() => [] as string[])
        : [];
      void analyzePRForShadow({
        repo: repository?.full_name ?? '',
        prNumber: pr?.number ?? 0,
        prTitle: pr?.title ?? '',
        prBody: pr?.body ?? null,
        author: pr?.user?.login ?? '',
        branch: pr?.head?.ref ?? '',
        action,
        changedFiles,
      }).then(async (shadowResult) => {
        await maybePostPRComment(shadowResult);
        await maybeCreateCheckRun(shadowResult, headSha, ghToken);
      }).catch((err: unknown) => {
        logger.warn({ err }, 'pr-shadow/comment/checkrun: error (non-fatal)');
      });
    }

    await handlePREvent(prPayload);
    return;
  }

  if (event === 'push') {
    handlePushEvent(payload as PushPayload);
    return;
  }

  // All other events silently ignored
}

function handleReviewEvent(payload: PullRequestReviewPayload): void {
  if (payload?.review?.state !== 'approved') return;
  const repo = payload?.repository?.full_name ?? '';
  const prNum = payload?.pull_request?.number;
  if (!repo || prNum == null) return;

  const key = `${repo}#${prNum}`;
  if (!_pendingApprovers.has(key)) _pendingApprovers.set(key, new Set());
  _pendingApprovers.get(key)!.add(payload.review.user.login);
  logger.debug({ repo, prNum, approver: payload.review.user.login }, 'github-webhook: approval captured');

  // Habituation signal: engineer submitted a review on a PR where Mergen commented
  if (hasMergenComment(key)) {
    recordHabituationEvent({
      recordedAt: Date.now(),
      eventType: 'pr_review_submitted',
      actor: payload.review.user.login,
      repo,
      prNumber: prNum,
    });
  }
}

async function handlePREvent(payload: PullRequestPayload): Promise<void> {
  const { action, pull_request: pr, repository } = payload ?? {};
  if (!pr || !repository) return;

  const repo = repository.full_name ?? '';
  const prKey = `${repo}#${pr.number}`;

  if (action !== 'closed' || !pr.merged) {
    // Still collect reviewers before merge for when the close event arrives
    if ((action === 'review_requested' || action === 'review_request_removed') && pr.requested_reviewers) {
      // not yet approved — skip
    }
    return;
  }

  const mergedAt = pr.merged_at ? new Date(pr.merged_at).getTime() : Date.now();
  const sha = pr.merge_commit_sha ?? pr.head.sha;

  // Collect approvers: from pending review cache + requested_reviewers on the PR
  const approverSet = _pendingApprovers.get(prKey) ?? new Set<string>();
  _pendingApprovers.delete(prKey);

  // AI attribution: check PR author login and title/body
  const prText = [pr.title, pr.body ?? ''].join(' ');
  const aiSignal = detectAiCommit(prText, pr.user.login);

  const linkedIssues = extractLinkedIssues(pr.body ?? '');

  const ctx: CommitContext = {
    sha,
    repo,
    branch: pr.base.ref,
    prNumber: pr.number,
    prTitle: pr.title,
    prBody: pr.body,
    author: pr.user.login,
    approvers: [...approverSet],
    linkedIssues,
    aiGenerated: aiSignal.detected,
    aiTool: aiSignal.tool,
    filesChanged: [],   // populated below if file list is available in payload
    capturedAt: Date.now(),
    mergedAt,
  };

  commitContextStore.upsert(ctx);

  // Async: fetch the list of changed files from the GitHub API and re-upsert
  // so that listByFile() can match PRs to specific files.
  const ghToken = loadGitHubToken();
  if (ghToken) {
    void fetchPRFiles(repo, pr.number, ghToken).then((files) => {
      if (files.length > 0) {
        commitContextStore.upsert({ ...ctx, filesChanged: files });
        logger.debug(
          { sha: sha.slice(0, 7), repo, pr: pr.number, files: files.length },
          'github-webhook: PR files populated',
        );
      }
    }).catch((err: unknown) => {
      logger.warn({ err }, 'github-webhook: fetchPRFiles failed (non-fatal)');
    });
  }

  // Backward compat: also feed the legacy memory store correlation
  memoryStore.correlateGitHubPR({ prUrl: pr.html_url, prTitle: pr.title, prSha: sha, mergedAt });

  logger.info(
    { sha: sha.slice(0, 7), repo, pr: pr.number, ai: aiSignal.detected, issues: linkedIssues.length },
    'github-webhook: PR context captured',
  );
}

function handlePushEvent(payload: PushPayload): void {
  const { ref, after: sha, commits, repository, pusher } = payload ?? {};
  if (!sha || !commits?.length || !repository) return;

  const repo = repository.full_name ?? '';
  const branch = ref?.replace('refs/heads/', '') ?? null;

  // Capture each commit individually — direct pushes bypass PR review flow
  for (const commit of commits.slice(0, 20)) {
    const commitSha = commit.id;
    const author = commit.author?.username ?? commit.author?.name ?? pusher?.name ?? '';
    const message = commit.message ?? '';
    const aiSignal = detectAiCommit(message, author);

    const changedFiles = [
      ...(commit.added ?? []),
      ...(commit.modified ?? []),
      ...(commit.removed ?? []),
    ];

    const ctx: CommitContext = {
      sha: commitSha,
      repo,
      branch,
      prNumber: null,
      prTitle: message.split('\n')[0].slice(0, 200),
      prBody: message,
      author,
      approvers: [],
      linkedIssues: extractLinkedIssues(message),
      aiGenerated: aiSignal.detected,
      aiTool: aiSignal.tool,
      filesChanged: changedFiles,
      capturedAt: Date.now(),
      mergedAt: null,
    };

    commitContextStore.upsert(ctx);
  }

  logger.info(
    { sha: sha.slice(0, 7), repo, branch, commits: commits.length },
    'github-webhook: push commits captured',
  );
}

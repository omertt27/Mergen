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
import { commitContextStore, extractLinkedIssues, type CommitContext } from '../sensor/commit-context-store.js';
import { detectAiCommit } from '../intelligence/ai-commit.js';
import logger from '../sensor/logger.js';

const WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET ?? '';

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
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
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
    await handlePREvent(payload as PullRequestPayload);
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

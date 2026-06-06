import { Router } from 'express';
import { z } from 'zod';
import { memoryStore } from '../datadog/memory-store.js';
import logger from '../sensor/logger.js';

// GitHub sends pull_request events for every PR action.
// We only care about closed + merged PRs for causality correlation.
const PrEventSchema = z.object({
  action: z.string(),
  pull_request: z.object({
    merged: z.boolean().optional(),
    merged_at: z.string().nullable().optional(),
    html_url: z.string(),
    title: z.string(),
    merge_commit_sha: z.string().nullable().optional(),
    head: z.object({ sha: z.string() }),
  }),
});

export function createGitHubWebhookRouter(): Router {
  const router = Router();

  router.post('/webhooks/github', (req, res) => {
    const event = req.headers['x-github-event'];

    // Only handle pull_request events — ack everything else silently
    if (event !== 'pull_request') {
      res.json({ status: 'ignored', event });
      return;
    }

    const parsed = PrEventSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid pull_request payload' });
      return;
    }

    const { action, pull_request: pr } = parsed.data;

    if (action !== 'closed' || !pr.merged) {
      res.json({ status: 'ignored', reason: 'not a merge' });
      return;
    }

    const mergedAt = pr.merged_at ? new Date(pr.merged_at).getTime() : Date.now();
    const prSha = pr.merge_commit_sha ?? pr.head.sha;

    logger.info({ prUrl: pr.html_url, title: pr.title }, 'github PR merged — checking incident correlation');

    memoryStore.correlateGitHubPR({
      prUrl: pr.html_url,
      prTitle: pr.title,
      prSha,
      mergedAt,
    });

    res.json({ status: 'accepted' });
  });

  return router;
}

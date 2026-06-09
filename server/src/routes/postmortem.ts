import express from 'express';
import { z } from 'zod';
import { fetchSlackThread } from '../intelligence/slack.js';
import { draftPostmortemDoc } from '../intelligence/tools-runbook.js';

const BodySchema = z.object({
  thread_url:       z.string().url(),
  service:          z.string().optional(),
  summary:          z.string().optional(),
  severity:         z.enum(['sev1', 'sev2', 'sev3']).optional(),
  duration_minutes: z.number().int().min(1).max(1440).optional(),
  affected_users:   z.string().optional(),
});

export function createPostmortemRouter(): express.Router {
  const router = express.Router();

  /**
   * POST /postmortem/from-slack
   *
   * Fetches a Slack thread via conversations.replies (requires MERGEN_SLACK_BOT_TOKEN
   * with channels:history scope), then drafts a blameless post-mortem from the thread
   * content combined with live telemetry and the incident corpus.
   *
   * Body:
   *   thread_url       — Slack thread URL (https://*.slack.com/archives/C.../p...)
   *   service          — affected service name (optional, improves corpus search)
   *   summary          — one-sentence description (optional)
   *   severity         — sev1|sev2|sev3 (default: sev2)
   *   duration_minutes — incident window for telemetry lookup (default: 60)
   *   affected_users   — who was impacted (optional)
   *
   * Returns:
   *   { markdown: string }   — blameless post-mortem draft
   *   { error: string }      — if thread fetch fails or body is invalid
   */
  router.post('/postmortem/from-slack', async (req, res) => {
    const parsed = BodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid request', details: parsed.error.flatten() });
      return;
    }

    const { thread_url, service = 'unknown', summary, severity, duration_minutes, affected_users } = parsed.data;

    const slackThread = await fetchSlackThread(thread_url);
    if (slackThread === null) {
      res.status(422).json({
        error: 'Could not fetch Slack thread. Ensure MERGEN_SLACK_BOT_TOKEN is set with channels:history scope and the URL is a valid Slack thread link.',
      });
      return;
    }

    const markdown = await draftPostmortemDoc({
      service,
      summary,
      severity,
      duration_minutes,
      affected_users,
      slack_thread: slackThread,
    });

    res.json({ markdown });
  });

  return router;
}

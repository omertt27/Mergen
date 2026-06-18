/**
 * routes/slack-routing.ts — HTTP API for managing service-to-Slack routing rules.
 *
 * GET  /slack/routing          — list all rules
 * POST /slack/routing          — create or update a rule (upserts by service name)
 * DELETE /slack/routing/:id    — remove a rule by id
 * POST /slack/test             — send a test message to verify bot token + channel
 */

import { Router } from 'express';
import { getRules, upsertRule, deleteRule, type SlackRoutingRule } from '../intelligence/slack-routing.js';
import logger from '../sensor/logger.js';

export function createSlackRoutingRouter(): Router {
  const router = Router();

  router.get('/slack/routing', (_req, res) => {
    res.json({ ok: true, rules: getRules() });
  });

  router.post('/slack/routing', (req, res) => {
    const body = (req.body ?? {}) as Partial<SlackRoutingRule>;

    if (!body.service || typeof body.service !== 'string') {
      res.status(400).json({ ok: false, error: 'service (string) is required' });
      return;
    }
    if (!body.webhook || typeof body.webhook !== 'string') {
      res.status(400).json({ ok: false, error: 'webhook (string) is required' });
      return;
    }
    try { new URL(body.webhook); } catch {
      res.status(400).json({ ok: false, error: 'webhook must be a valid URL' });
      return;
    }
    if (body.minConfidence !== undefined) {
      const v = Number(body.minConfidence);
      if (isNaN(v) || v < 0 || v > 1) {
        res.status(400).json({ ok: false, error: 'minConfidence must be a number between 0 and 1' });
        return;
      }
    }

    const rule = upsertRule({
      id:              typeof body.id === 'string' ? body.id : undefined,
      service:         body.service,
      webhook:         body.webhook,
      channel:         typeof body.channel === 'string' ? body.channel : undefined,
      minConfidence:   typeof body.minConfidence === 'number' ? body.minConfidence : undefined,
      escalateAt:      typeof body.escalateAt === 'number' ? body.escalateAt : undefined,
      oncallMention:   typeof body.oncallMention === 'string' ? body.oncallMention : undefined,
    });
    res.status(201).json({ ok: true, rule });
  });

  router.delete('/slack/routing/:id', (req, res) => {
    const { id } = req.params;
    if (!id) { res.status(400).json({ ok: false, error: 'id is required' }); return; }
    const deleted = deleteRule(id);
    if (!deleted) { res.status(404).json({ ok: false, error: `no rule with id: ${id}` }); return; }
    res.json({ ok: true });
  });

  // ── POST /slack/test ──────────────────────────────────────────────────────
  router.post('/slack/test', async (req, res) => {
    const token   = process.env.MERGEN_SLACK_BOT_TOKEN;
    const channel = (req.body as { channel?: string })?.channel ?? process.env.MERGEN_SLACK_CHANNEL;

    if (!token) {
      res.status(400).json({
        ok: false,
        error:   'MERGEN_SLACK_BOT_TOKEN not set',
        fix:     'export MERGEN_SLACK_BOT_TOKEN=xoxb-...',
        docsUrl: 'https://api.slack.com/apps',
      });
      return;
    }
    if (!channel) {
      res.status(400).json({
        ok: false,
        error: 'channel is required — pass in body or set MERGEN_SLACK_CHANNEL',
        fix:   'POST /slack/test { "channel": "#my-channel" }',
      });
      return;
    }

    try {
      const payload = {
        channel,
        text: '⬡ *Mergen test message* — your Slack integration is working correctly.',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '⬡ *Mergen test message*\nYour Slack integration is configured correctly. Mergen will post incident alerts and autonomous resolution updates to this channel.',
            },
          },
          {
            type: 'context',
            elements: [{ type: 'mrkdwn', text: `Sent at ${new Date().toISOString()} via \`POST /slack/test\`` }],
          },
        ],
      };

      const r = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5000),
      });

      const d = await r.json() as { ok: boolean; error?: string; ts?: string; channel?: string };
      if (!d.ok) {
        const fixMap: Record<string, string> = {
          'not_in_channel':    'Invite the Mergen bot to the channel: /invite @mergen',
          'channel_not_found': 'Check that the channel name is correct and the bot has access',
          'invalid_auth':      'Check MERGEN_SLACK_BOT_TOKEN — it may be expired or revoked',
          'missing_scope':     'The bot token needs chat:write scope — update at https://api.slack.com/apps',
        };
        logger.warn({ slackError: d.error, channel }, 'slack: test message failed');
        res.status(400).json({
          ok: false,
          error:  `Slack error: ${d.error}`,
          fix:    fixMap[d.error ?? ''] ?? 'Check your Slack app configuration at https://api.slack.com/apps',
        });
        return;
      }

      logger.info({ channel, ts: d.ts }, 'slack: test message sent');
      res.json({ ok: true, channel: d.channel, ts: d.ts });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown error';
      res.status(500).json({ ok: false, error: `Failed to reach Slack API: ${msg}` });
    }
  });

  return router;
}

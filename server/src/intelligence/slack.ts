/**
 * slack.ts — Post HIGH-confidence hypotheses to a Slack webhook with
 * interactive feedback buttons.
 *
 * Modes:
 *   Simple   — MERGEN_SLACK_WEBHOOK only: alert with link buttons
 *   Interactive — MERGEN_SLACK_BOT_TOKEN + MERGEN_SLACK_SIGNING_SECRET:
 *                 real button-click callbacks that route to /slack/actions
 *                 and close the calibration loop without leaving Slack
 *
 * The interactive mode requires a Slack app with the Interactivity feature
 * enabled and the Request URL set to https://your-mergen-server/slack/actions.
 */

import https from 'https';
import crypto from 'crypto';
import type { Request, Response } from 'express';
import type { Hypothesis } from './causal.js';
import { recordVerdict } from './calibration.js';
import logger from '../sensor/logger.js';

const WEBHOOK        = process.env.MERGEN_SLACK_WEBHOOK ?? '';
const BOT_TOKEN      = process.env.MERGEN_SLACK_BOT_TOKEN ?? '';
const SIGNING_SECRET = process.env.MERGEN_SLACK_SIGNING_SECRET ?? '';
const COOLDOWN       = 5 * 60 * 1_000;
const MIN_CONFIDENCE = 0.75;

export const isInteractive = !!BOT_TOKEN && !!SIGNING_SECRET;

const _lastAlertAt = new Map<string, number>();

export function shouldAlert(hyp: Hypothesis): boolean {
  if (!WEBHOOK) return false;
  if ((hyp.confidenceScore ?? 0) < MIN_CONFIDENCE) return false;
  const last = _lastAlertAt.get(hyp.tag) ?? 0;
  return Date.now() - last > COOLDOWN;
}

export async function postSlackAlert(
  hyp: Hypothesis,
  context: {
    sha?: string;
    branch?: string;
    owners?: string[];
    environment?: string;
    dashboardUrl?: string;
  } = {},
): Promise<void> {
  if (!WEBHOOK || !shouldAlert(hyp)) return;
  _lastAlertAt.set(hyp.tag, Date.now());

  const pct   = Math.round((hyp.confidenceScore ?? 0) * 100);
  const color = pct >= 85 ? '#d32f2f' : '#f57c00';

  const metaParts: string[] = [];
  if (context.sha)         metaParts.push(`Commit: \`${context.sha.slice(0, 7)}\``);
  if (context.branch)      metaParts.push(`Branch: \`${context.branch}\``);
  if (context.environment) metaParts.push(`Env: \`${context.environment}\``);
  if (context.owners?.length) metaParts.push(`Owners: ${context.owners.join(' ')}`);

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `🔴 Mergen Alert — ${pct}% confidence`, emoji: true },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*${hyp.summary}*` },
    },
    ...(metaParts.length ? [{
      type: 'section',
      text: { type: 'mrkdwn', text: metaParts.join('  |  ') },
    }] : []),
    ...(hyp.fixHint ? [{
      type: 'section',
      text: { type: 'mrkdwn', text: `💡 *Fix:* ${hyp.fixHint}` },
    }] : []),
    ...(hyp.evidence?.length ? [{
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Evidence:*\n${hyp.evidence.slice(0, 3).map((e) => `• ${e}`).join('\n')}`,
      },
    }] : []),
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `Detector: \`${hyp.tag}\` · Mergen` }],
    },
    // Action buttons — feedback + dashboard link
    {
      type: 'actions',
      elements: [
        ...(context.dashboardUrl ? [{
          type: 'button',
          text: { type: 'plain_text', text: '🗂 View Timeline', emoji: true },
          url: context.dashboardUrl,
          style: 'primary',
        }] : []),
        // Feedback buttons: interactive if bot token is set, link-based otherwise
        ...(hyp.pid ? (isInteractive ? [
          {
            type: 'button',
            action_id: `feedback_correct_${hyp.pid}`,
            text: { type: 'plain_text', text: '✅ Correct', emoji: true },
            value: JSON.stringify({ pid: hyp.pid, verdict: 'correct' }),
            style: 'primary',
          },
          {
            type: 'button',
            action_id: `feedback_wrong_${hyp.pid}`,
            text: { type: 'plain_text', text: '❌ Wrong', emoji: true },
            value: JSON.stringify({ pid: hyp.pid, verdict: 'wrong' }),
            style: 'danger',
          },
        ] : context.dashboardUrl ? [
          {
            type: 'button',
            text: { type: 'plain_text', text: '✅ Correct', emoji: true },
            url: `${context.dashboardUrl}/feedback?pid=${encodeURIComponent(hyp.pid)}&verdict=correct`,
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: '❌ Wrong', emoji: true },
            url: `${context.dashboardUrl}/feedback?pid=${encodeURIComponent(hyp.pid)}&verdict=wrong`,
          },
        ] : []) : []),
      ],
    },
  ];

  const payload = JSON.stringify({ attachments: [{ color, blocks }] });

  return new Promise((resolve) => {
    try {
      const url = new URL(WEBHOOK);
      const req = https.request(
        { hostname: url.hostname, path: url.pathname + url.search, method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
        (res) => { res.resume(); resolve(); },
      );
      req.on('error', (err) => { logger.warn({ err }, 'slack: webhook post failed'); resolve(); });
      req.write(payload);
      req.end();
    } catch (err) {
      logger.warn({ err }, 'slack: failed to post alert');
      resolve();
    }
  });
}

// ── Slack interactive actions handler ─────────────────────────────────────────
// Mounted at POST /slack/actions by app.ts when MERGEN_SLACK_BOT_TOKEN is set.
// Slack sends a JSON payload with action_id and value when a button is clicked.
// We verify the signature, parse the action, submit the verdict, and ACK.

export function verifySlackSignature(req: Request): boolean {
  if (!SIGNING_SECRET) return false;
  try {
    const ts  = req.headers['x-slack-request-timestamp'] as string | undefined;
    const sig = req.headers['x-slack-signature'] as string | undefined;
    if (!ts || !sig) return false;
    if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false; // replay protection

    const body   = (req as unknown as { rawBody?: Buffer }).rawBody?.toString('utf8') ?? '';
    const hmac   = crypto.createHmac('sha256', SIGNING_SECRET);
    const computed = 'v0=' + hmac.update(`v0:${ts}:${body}`).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(sig));
  } catch { return false; }
}

export async function handleSlackActions(req: Request, res: Response): Promise<void> {
  if (isInteractive && !verifySlackSignature(req)) {
    res.status(401).send('Unauthorized');
    return;
  }

  try {
    const body = req.body as { payload?: string };
    const payload = JSON.parse(body.payload ?? '{}') as {
      actions?: Array<{ action_id: string; value: string }>;
    };

    for (const action of payload.actions ?? []) {
      if (action.action_id.startsWith('feedback_')) {
        try {
          const { pid, verdict } = JSON.parse(action.value) as { pid: string; verdict: string };
          recordVerdict(pid, verdict as 'correct' | 'wrong' | 'partial');
          logger.info({ pid, verdict }, 'slack: feedback submitted via button');
        } catch (err) {
          logger.warn({ err, action }, 'slack: failed to parse action value');
        }
      }
    }

    res.status(200).send(''); // ACK within 3s
  } catch (err) {
    logger.warn({ err }, 'slack: actions handler error');
    res.status(200).send(''); // Always ACK to avoid Slack retries
  }
}

// ── Link-based feedback handler ───────────────────────────────────────────────
// When not using interactive mode, Slack buttons are plain links that open
// GET /feedback?pid=<pid>&verdict=<verdict> in a browser.

export async function handleFeedbackLink(req: Request, res: Response): Promise<void> {
  const { pid, verdict } = req.query as Record<string, string>;
  if (!pid || !verdict) { res.status(400).send('Missing pid or verdict'); return; }

  try {
    recordVerdict(pid, verdict as 'correct' | 'wrong' | 'partial');
    logger.info({ pid, verdict }, 'feedback submitted via link');
    res.send(`<!DOCTYPE html><html><head><title>Mergen Feedback</title></head><body style="font-family:system-ui;text-align:center;padding:60px">
      <h2>${verdict === 'correct' ? '✅' : '❌'} Feedback recorded</h2>
      <p style="color:#666">Thank you. Mergen's accuracy will improve over time.</p>
      <p style="margin-top:20px"><a href="/dashboard">Back to dashboard</a></p>
    </body></html>`);
  } catch (err) {
    logger.warn({ err, pid, verdict }, 'feedback link handler error');
    res.status(500).send('Error recording feedback');
  }
}

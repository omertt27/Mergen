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
import type { BlameAttribution } from '../datadog/blame-attribution.js';
import type { BlastRadiusReport } from '../sensor/buffer.js';
import { memoryStore } from '../datadog/memory-store.js';
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
      text: { type: 'plain_text', text: `🔴 Mergen Causal Alert`, emoji: true },
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
  return _postWebhook(payload);
}

// ── Incident alert ────────────────────────────────────────────────────────────
// Called by pagerduty.ts after blame attribution and blast radius are computed.
// This is the primary design-partner-visible surface: the Slack message that
// shows up in the war room channel when a P1 fires.

export async function postIncidentAlert(opts: {
  alertTitle: string;
  service: string;
  firedAt: number;
  incidentId?: number | null;
  pdUrl?: string | null;
  blame: BlameAttribution | null;
  blastRadius?: BlastRadiusReport | null;
  dashboardUrl?: string;
}): Promise<void> {
  if (!WEBHOOK) return;

  const { alertTitle, service, firedAt, incidentId, pdUrl, blame, blastRadius, dashboardUrl } = opts;
  const ageMin  = Math.round((Date.now() - firedAt) / 60_000);
  const ageTxt  = ageMin < 2 ? 'just now' : `${ageMin}m ago`;

  const blocks: unknown[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `🚨 Production Incident — ${service}`, emoji: true },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*${alertTitle}*\nFired *${ageTxt}*${pdUrl ? `  |  <${pdUrl}|PagerDuty>` : ''}` },
    },
  ];

  // Blame attribution block
  if (blame?.topCandidate) {
    const sha8   = blame.topCandidate.sha.slice(0, 8);
    const pct    = Math.round(blame.confidence * 100);
    const label  = blame.confidenceLabel;
    const color  = label === 'HIGH' ? '✅' : label === 'MEDIUM' ? '⚠️' : '❓';
    const signals = [blame.signals.timing, blame.signals.shaMatch, blame.signals.fileOverlap]
      .filter((s) => s.available && s.score > 0)
      .map((s) => `• ${s.detail.slice(0, 80)}`);

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          `*${color} Causal Attribution — ${pct}% [${label}]*`,
          `Deploy \`${sha8}\` • ${blame.topCandidate.environment}`,
          ...signals.slice(0, 3),
          blame.lowConfidence ? '_⚠️ Below confidence threshold — manual investigation recommended_' : '',
        ].filter(Boolean).join('\n'),
      },
    });
  } else {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '_Attribution pending — no deploy events found. Post deployments to `/deployments` or connect CI._' },
    });
  }

  // Blast radius block
  if (blastRadius && blastRadius.errorCount > 0) {
    const sessions = blastRadius.affectedSessions > 0
      ? `*${blastRadius.affectedSessions}* session${blastRadius.affectedSessions !== 1 ? 's' : ''} affected`
      : `*${blastRadius.errorCount}* error events`;
    const users = blastRadius.affectedUsers > 0
      ? ` (${blastRadius.affectedUsers} authenticated users)` : '';
    const browsers = Object.entries(blastRadius.browserSegments)
      .sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([b, n]) => `${b}: ${n}`).join(' | ');
    const durationTxt = blastRadius.durationMs
      ? ` • Active *${_fmtDuration(blastRadius.durationMs)}*` : '';

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          `*📊 Blast Radius*`,
          `${sessions}${users}${durationTxt}`,
          browsers ? `Browsers: ${browsers}` : '',
        ].filter(Boolean).join('\n'),
      },
    });
  }

  // Action buttons
  const actions: unknown[] = [];

  if (dashboardUrl) {
    actions.push({
      type: 'button',
      text: { type: 'plain_text', text: '🗂 War Room', emoji: true },
      url: `${dashboardUrl}#war-room`,
      style: 'primary',
    });
  }

  if (incidentId != null && blame?.topCandidate && isInteractive) {
    actions.push(
      {
        type: 'button',
        action_id: `inc_attr_correct_${incidentId}`,
        text: { type: 'plain_text', text: '✅ Attribution Correct', emoji: true },
        value: String(incidentId),
        style: 'primary',
      },
      {
        type: 'button',
        action_id: `inc_attr_wrong_${incidentId}`,
        text: { type: 'plain_text', text: '❌ Wrong', emoji: true },
        value: String(incidentId),
        style: 'danger',
      },
    );
  } else if (incidentId != null && blame?.topCandidate && dashboardUrl) {
    // Link-based fallback when no bot token
    actions.push(
      {
        type: 'button',
        text: { type: 'plain_text', text: '✅ Attribution Correct', emoji: true },
        url: `${dashboardUrl}/attribution-feedback?id=${incidentId}&correct=1`,
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: '❌ Wrong', emoji: true },
        url: `${dashboardUrl}/attribution-feedback?id=${incidentId}&correct=0`,
      },
    );
  }

  if (actions.length > 0) {
    blocks.push({ type: 'actions', elements: actions });
  }

  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `Mergen · ${service} · <${dashboardUrl ?? 'http://127.0.0.1:3000'}/dashboard|Dashboard>` }],
  });

  const color = blame?.confidenceLabel === 'HIGH' ? '#d32f2f' :
                blame?.confidenceLabel === 'MEDIUM' ? '#f57c00' : '#64748b';

  return _postWebhook(JSON.stringify({ attachments: [{ color, blocks }] }));
}

function _fmtDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

function _postWebhook(payload: string): Promise<void> {
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
      logger.warn({ err }, 'slack: failed to post');
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
      // Calibration hypothesis feedback
      if (action.action_id.startsWith('feedback_')) {
        try {
          const { pid, verdict } = JSON.parse(action.value) as { pid: string; verdict: string };
          recordVerdict(pid, verdict as 'correct' | 'wrong' | 'partial');
          logger.info({ pid, verdict }, 'slack: feedback submitted via button');
        } catch (err) {
          logger.warn({ err, action }, 'slack: failed to parse action value');
        }
      }

      // Attribution accuracy feedback (inc_attr_correct_{id} / inc_attr_wrong_{id})
      if (action.action_id.startsWith('inc_attr_correct_') || action.action_id.startsWith('inc_attr_wrong_')) {
        const correct = action.action_id.startsWith('inc_attr_correct_');
        const id = parseInt(action.value, 10);
        if (!isNaN(id)) {
          memoryStore.recordAttributionFeedback(id, correct ? 1 : 0);
          logger.info({ id, correct }, 'slack: attribution feedback via button');
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

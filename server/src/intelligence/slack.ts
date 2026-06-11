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
import { recordOverride, type OverrideReason } from './override-corpus.js';
import { getRoutingForService } from './slack-routing.js';
import { approveExecution, denyExecution } from './execution-gate.js';
import { executeRemediation } from './autonomy.js';
import logger from '../sensor/logger.js';

const WEBHOOK        = process.env.MERGEN_SLACK_WEBHOOK ?? '';
const BOT_TOKEN      = process.env.MERGEN_SLACK_BOT_TOKEN ?? '';
const SLACK_CHANNEL  = process.env.MERGEN_SLACK_CHANNEL ?? '';

// In-memory thread registry: pid → { channel, ts }
// Lets the autonomous loop reply to the original incident thread.
const _threadByPid = new Map<string, { channel: string; ts: string }>();

export function getThread(pid: string): { channel: string; ts: string } | undefined {
  return _threadByPid.get(pid);
}

/** GET a Slack Web API endpoint (read-only calls like conversations.replies). */
async function _slackApiGet(path: string): Promise<unknown> {
  if (!BOT_TOKEN) return null;
  return new Promise((resolve) => {
    try {
      const req = https.request(
        {
          hostname: 'slack.com',
          path,
          method: 'GET',
          headers: { 'Authorization': `Bearer ${BOT_TOKEN}` },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
          res.on('end', () => {
            try { resolve(JSON.parse(data)); } catch { resolve(null); }
          });
        },
      );
      req.on('error', (err) => { logger.warn({ err, path }, 'slack: GET request failed'); resolve(null); });
      req.end();
    } catch (err) {
      logger.warn({ err, path }, 'slack: GET request failed');
      resolve(null);
    }
  });
}

/**
 * Fetch all messages in a Slack thread and return them as formatted plain text.
 *
 * Requires MERGEN_SLACK_BOT_TOKEN with channels:history scope (public channels)
 * or groups:history (private channels).
 *
 * URL format: https://{workspace}.slack.com/archives/{CHANNEL_ID}/p{TIMESTAMP}
 * where TIMESTAMP is the thread_ts with the dot removed (16 digits).
 *
 * Returns null when BOT_TOKEN is missing or the URL is unparseable.
 */
export async function fetchSlackThread(threadUrl: string): Promise<string | null> {
  if (!BOT_TOKEN) return null;

  const match = threadUrl.match(/\/archives\/([A-Z0-9]+)\/p(\d{16})/);
  if (!match) {
    logger.warn({ threadUrl }, 'slack: could not parse thread URL');
    return null;
  }

  const channel = match[1];
  const rawTs   = match[2];
  // Slack timestamps: first 10 digits = seconds, remaining 6 = microseconds
  const ts = `${rawTs.slice(0, 10)}.${rawTs.slice(10)}`;

  type SlackRepliesPage = {
    ok?: boolean;
    error?: string;
    messages?: Array<{ ts?: string; user?: string; username?: string; bot_profile?: { name?: string }; text?: string }>;
    has_more?: boolean;
    response_metadata?: { next_cursor?: string };
  };

  const allMessages: NonNullable<SlackRepliesPage['messages']> = [];
  let cursor: string | undefined;
  const MAX_PAGES = 5; // cap at 500 messages — enough for any incident thread

  for (let page = 0; page < MAX_PAGES; page++) {
    const qs = new URLSearchParams({ channel, ts, limit: '100' });
    if (cursor) qs.set('cursor', cursor);

    const result = await _slackApiGet(`/api/conversations.replies?${qs.toString()}`) as SlackRepliesPage | null;

    if (!result?.ok || !Array.isArray(result.messages)) {
      logger.warn({ channel, ts, error: result?.error, page }, 'slack: conversations.replies failed');
      if (page === 0) return null; // first page failure = nothing to return
      break;
    }

    allMessages.push(...result.messages);
    if (!result.has_more || !result.response_metadata?.next_cursor) break;
    cursor = result.response_metadata.next_cursor;
  }

  const lines = allMessages.map((msg) => {
    const time = msg.ts
      ? new Date(parseFloat(msg.ts) * 1000).toISOString().slice(11, 16)
      : '??:??';
    const user = msg.username ?? msg.bot_profile?.name ?? msg.user ?? 'unknown';
    const text = (msg.text ?? '').slice(0, 500);
    return `[${time}] @${user}: ${text}`;
  });

  return lines.join('\n');
}

// Cache: channel name → channel ID (avoids repeated conversations.list calls)
const _channelIdCache = new Map<string, string>();

async function _resolveChannelId(nameOrId: string): Promise<string | null> {
  if (!BOT_TOKEN) return null;
  // Already an ID — Slack channel IDs start with C (public) or G (private/mpim)
  if (/^[CG][A-Z0-9]{6,}$/i.test(nameOrId)) return nameOrId;
  const clean = nameOrId.replace(/^#/, '').toLowerCase();
  if (_channelIdCache.has(clean)) return _channelIdCache.get(clean)!;

  type ChannelListPage = {
    ok?: boolean;
    channels?: Array<{ id?: string; name?: string }>;
    response_metadata?: { next_cursor?: string };
  };
  let cursor: string | undefined;
  for (let page = 0; page < 3; page++) {
    const qs = new URLSearchParams({
      limit: '200',
      types: 'public_channel,private_channel',
      exclude_archived: 'true',
      ...(cursor ? { cursor } : {}),
    });
    const result = await _slackApiGet(`/api/conversations.list?${qs.toString()}`) as ChannelListPage | null;
    if (!result?.ok || !Array.isArray(result.channels)) break;
    for (const ch of result.channels) {
      if (ch.name && ch.id) _channelIdCache.set(ch.name.toLowerCase(), ch.id);
    }
    if (!result.response_metadata?.next_cursor) break;
    cursor = result.response_metadata.next_cursor;
  }
  return _channelIdCache.get(clean) ?? null;
}

/**
 * Fetch recent messages from the incident channel in a window around a given
 * timestamp and return them as formatted plain text. Used by the autopilot to
 * include on-call conversation as evidence in the causal chain.
 *
 * Requires MERGEN_SLACK_BOT_TOKEN with channels:history or groups:history scope
 * and MERGEN_SLACK_CHANNEL set to either a channel ID (C…) or name (#incidents).
 *
 * windowMs: how many ms after firedAt to include (default 20 min).
 * Starts 5 min before firedAt to capture any pre-alert discussion.
 */
export async function fetchIncidentChannelContext(
  firedAt: number,
  windowMs = 20 * 60 * 1000,
): Promise<string | null> {
  if (!BOT_TOKEN || !SLACK_CHANNEL) return null;

  const channelId = await _resolveChannelId(SLACK_CHANNEL);
  if (!channelId) {
    logger.warn({ channel: SLACK_CHANNEL }, 'slack: could not resolve channel ID for context fetch');
    return null;
  }

  type HistoryPage = {
    ok?: boolean;
    error?: string;
    messages?: Array<{ ts?: string; user?: string; username?: string; bot_profile?: { name?: string }; text?: string }>;
  };

  const oldest = String((firedAt - 5 * 60 * 1000) / 1000);
  const latest = String((firedAt + windowMs) / 1000);
  const qs = new URLSearchParams({ channel: channelId, oldest, latest, limit: '50', inclusive: 'true' });
  const result = await _slackApiGet(`/api/conversations.history?${qs.toString()}`) as HistoryPage | null;

  if (!result?.ok || !Array.isArray(result.messages) || result.messages.length === 0) {
    if (result?.error) logger.debug({ error: result.error, channel: channelId }, 'slack: conversations.history returned error');
    return null;
  }

  const lines = result.messages.map((msg) => {
    const time = msg.ts ? new Date(parseFloat(msg.ts) * 1000).toISOString().slice(11, 16) : '??:??';
    const user = msg.username ?? msg.bot_profile?.name ?? msg.user ?? 'unknown';
    const text = (msg.text ?? '').slice(0, 500);
    return `[${time}] @${user}: ${text}`;
  });

  return lines.length > 0 ? lines.join('\n') : null;
}

/** Post a JSON payload to a generic Slack Web API endpoint. */
async function _slackApi(
  path: string,
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; ts?: string; error?: string } | null> {
  if (!BOT_TOKEN) return null;
  const body = JSON.stringify(payload);
  return new Promise((resolve) => {
    try {
      const req = https.request(
        {
          hostname: 'slack.com',
          path,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${BOT_TOKEN}`,
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
          res.on('end', () => {
            try {
              const parsed = JSON.parse(data) as { ok: boolean; ts?: string; error?: string };
              if (!parsed.ok) {
                logger.warn({ error: parsed.error, path }, 'slack: Web API call failed');
              }
              resolve(parsed);
            } catch { resolve(null); }
          });
        },
      );
      req.on('error', (err) => { logger.warn({ err, path }, 'slack: Web API request failed'); resolve(null); });
      req.write(body);
      req.end();
    } catch (err) {
      logger.warn({ err, path }, 'slack: failed to post via Web API');
      resolve(null);
    }
  });
}

/** Post a message via Slack Web API (chat.postMessage). Returns { ts } or null. */
async function _postWebApi(
  channel: string,
  payload: Record<string, unknown>,
  threadTs?: string,
): Promise<{ ts: string } | null> {
  const result = await _slackApi('/api/chat.postMessage', { channel, thread_ts: threadTs, ...payload });
  return result?.ok && result.ts ? { ts: result.ts } : null;
}

/** Open a Slack modal for capturing shadow-mode override reasons. */
async function _openOverrideModal(triggerId: string, pid: string): Promise<void> {
  const view = {
    type: 'modal',
    callback_id: 'override_modal',
    private_metadata: pid,
    title: { type: 'plain_text', text: 'Override Mergen' },
    submit: { type: 'plain_text', text: 'Submit Override' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: 'reason_block',
        element: {
          type: 'static_select',
          action_id: 'reason_select',
          placeholder: { type: 'plain_text', text: 'Select a reason...' },
          options: [
            { text: { type: 'plain_text', text: 'Too risky for production' }, value: 'too_risky' },
            { text: { type: 'plain_text', text: 'Fix is incorrect' }, value: 'fix_incorrect' },
            { text: { type: 'plain_text', text: 'False positive diagnosis' }, value: 'false_positive' },
            { text: { type: 'plain_text', text: 'Other / Need manual review' }, value: 'other' }
          ]
        },
        label: { type: 'plain_text', text: 'Why are you overriding this action?' }
      }
    ]
  };
  await _slackApi('/api/views.open', { trigger_id: triggerId, view });
}

/**
 * Post a reply to an existing Slack thread. Used by the autonomous triage loop
 * to add progress updates to the original incident thread.
 */
export async function postThreadReply(pid: string, text: string): Promise<void> {
  const thread = _threadByPid.get(pid);
  if (!thread) {
    logger.debug({ pid }, 'slack: no thread found for pid — cannot reply');
    return;
  }
  await _postWebApi(thread.channel, { text }, thread.ts);
}

/**
 * Post a blocks-based message to an existing incident thread.
 * Used by the execution gate to surface Approve/Deny buttons.
 */
export async function postThreadBlocks(pid: string, blocks: unknown[]): Promise<void> {
  const thread = _threadByPid.get(pid);
  if (!thread) {
    logger.debug({ pid }, 'slack: no thread for blocks post');
    return;
  }
  await _postWebApi(thread.channel, { blocks }, thread.ts);
}

/**
 * Post a Slack approval request block for a pending fix execution.
 * Called by incident-autopilot before storing the request in execution-gate.
 */
export async function postApprovalRequest(
  pid: string,
  command: string,
  tier: string,
  remediationConfidence: number,
  blastRadius?: import('./blast-radius.js').BlastRadius,
): Promise<void> {
  const pct = Math.round(remediationConfidence * 100);
  const tierBadge = tier === 'restart' ? '🔄 restart' : tier === 'deploy' ? '🚀 deploy' : '⚡ full';

  const blastLines: string[] = [];
  if (blastRadius) {
    const dt = blastRadius.estimatedDowntimeMs !== null
      ? `~${Math.round(blastRadius.estimatedDowntimeMs / 1000)}s`
      : 'unknown';
    const rev = blastRadius.reversible ? '✅ Yes' : '❌ No';
    const data = blastRadius.dataAtRisk ? '⚠️ Yes' : '❌ No';
    blastLines.push(
      ``,
      `*Blast Radius* _(${blastRadius.modelConfidence} model confidence)_`,
      `• Scope: \`${blastRadius.scope}\`${blastRadius.affectedResources.length > 0 ? ` · Resource: \`${blastRadius.affectedResources[0]}\`` : ''}`,
      `• Downtime: ${dt} · Recoverable: ${rev}`,
      blastRadius.rollbackCommand
        ? `• Rollback: \`${blastRadius.rollbackCommand}\`${blastRadius.rollbackLatencyMs ? ` (~${Math.round(blastRadius.rollbackLatencyMs / 1000)}s)` : ''}`
        : `• Rollback: _not available_`,
      `• Data at risk: ${data}`,
    );
  }

  await postThreadBlocks(pid, [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          `🔐 *Mergen Autopilot — Approval Required*`,
          `Risk tier: *${tierBadge}* · Remediation confidence: *${pct}%*`,
          ``,
          `*Command to execute:*`,
          `\`\`\`${command}\`\`\``,
          ...blastLines,
          ``,
          `_Approval window: 15 min. No action = auto-expire._`,
        ].join('\n'),
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          action_id: `execute_fix_${pid}`,
          text: { type: 'plain_text', text: '✅ Execute', emoji: true },
          value: JSON.stringify({ pid, command }),
          style: 'primary',
        },
        {
          type: 'button',
          action_id: `deny_fix_${pid}`,
          text: { type: 'plain_text', text: '❌ Deny', emoji: true },
          value: JSON.stringify({ pid }),
          style: 'danger',
        },
      ],
    },
  ]);
}

const SIGNING_SECRET = process.env.MERGEN_SLACK_SIGNING_SECRET ?? '';
const COOLDOWN       = 5 * 60 * 1_000;
const MIN_CONFIDENCE = 0.75;

export const isInteractive = !!BOT_TOKEN && !!SIGNING_SECRET;

const _lastAlertAt = new Map<string, number>();

/** Returns the effective webhook URL for a given service (routing rule > global env). */
function _webhookForService(service?: string): string {
  if (service) {
    const rule = getRoutingForService(service);
    if (rule?.webhook) return rule.webhook;
  }
  return WEBHOOK;
}

/** Returns the effective min-confidence for a service (routing rule > global default). */
function _minConfidenceForService(service?: string): number {
  if (service) {
    const rule = getRoutingForService(service);
    if (typeof rule?.minConfidence === 'number') return rule.minConfidence;
  }
  return MIN_CONFIDENCE;
}

export function shouldAlert(hyp: Hypothesis, service?: string): boolean {
  const webhook = _webhookForService(service);
  if (!webhook) return false;
  if ((hyp.confidenceScore ?? 0) < _minConfidenceForService(service)) return false;
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
    service?: string;
  } = {},
): Promise<void> {
  const webhook = _webhookForService(context.service);
  if (!webhook || !shouldAlert(hyp, context.service)) return;
  _lastAlertAt.set(hyp.tag, Date.now());

  const routingRule = context.service ? getRoutingForService(context.service) : null;
  const escalate = routingRule?.escalateAt != null && routingRule.oncallMention
    && (hyp.confidenceScore ?? 0) >= routingRule.escalateAt;

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
    ...(escalate && routingRule?.oncallMention ? [{
      type: 'section',
      text: { type: 'mrkdwn', text: `🚨 *Escalation:* ${routingRule.oncallMention} — confidence above threshold` },
    }] : []),
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `Detector: \`${hyp.tag}\`${context.service ? ` · ${context.service}` : ''} · Mergen` }],
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
            action_id: `shadow_approve_${hyp.pid}`,
            text: { type: 'plain_text', text: '✅ Approve Fix', emoji: true },
            value: JSON.stringify({ pid: hyp.pid, verdict: 'would-approve' }),
            style: 'primary',
          },
          {
            type: 'button',
            action_id: `shadow_override_${hyp.pid}`,
            text: { type: 'plain_text', text: '✋ Override', emoji: true },
            value: JSON.stringify({ pid: hyp.pid, verdict: 'would-override' }),
            style: 'danger',
          },
        ] : context.dashboardUrl ? [
          {
            type: 'button',
            text: { type: 'plain_text', text: '✅ Approve Fix', emoji: true },
            url: `${context.dashboardUrl}/feedback?pid=${encodeURIComponent(hyp.pid)}&verdict=would-approve`,
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: '✋ Override', emoji: true },
            url: `${context.dashboardUrl}/feedback?pid=${encodeURIComponent(hyp.pid)}&verdict=would-override`,
          },
        ] : []) : []),
      ],
    },
  ];

  const payload = JSON.stringify({ attachments: [{ color, blocks }] });
  return _postWebhook(payload, webhook);
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
  pid?: string | null;
  pdUrl?: string | null;
  blame: BlameAttribution | null;
  blastRadius?: BlastRadiusReport | null;
  dashboardUrl?: string;
}): Promise<void> {
  const webhook = _webhookForService(opts.service);
  const channel = getRoutingForService(opts.service)?.channel ?? SLACK_CHANNEL;
  if (!webhook && !(BOT_TOKEN && channel)) return;
  const routingRule = getRoutingForService(opts.service);

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

  // Escalation mention for high-confidence incidents
  if (routingRule?.escalateAt != null && routingRule.oncallMention) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `🚨 ${routingRule.oncallMention} — production incident requires attention` },
    });
  }

  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `Mergen · ${service} · <${dashboardUrl ?? 'http://127.0.0.1:3000'}/dashboard|Dashboard>` }],
  });

  const color = blame?.confidenceLabel === 'HIGH' ? '#d32f2f' :
                blame?.confidenceLabel === 'MEDIUM' ? '#f57c00' : '#64748b';

  // Prefer Web API (chat.postMessage) when BOT_TOKEN is configured so we own
  // the thread and can post autonomous triage progress as replies.
  if (BOT_TOKEN && channel) {
    const result = await _postWebApi(channel, { attachments: [{ color, blocks }] });
    if (result?.ts && opts.pid) {
      _threadByPid.set(opts.pid, { channel, ts: result.ts });
      logger.info({ pid: opts.pid, ts: result.ts, channel }, 'slack: thread registered for autonomous replies');
    }
    return;
  }

  return _postWebhook(JSON.stringify({ attachments: [{ color, blocks }] }), webhook);
}

function _fmtDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

function _postWebhook(payload: string, webhookUrl: string = WEBHOOK): Promise<void> {
  return new Promise((resolve) => {
    try {
      const url = new URL(webhookUrl);
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
      type?: string;
      trigger_id?: string;
      view?: { callback_id: string; private_metadata: string; state: { values: any } };
      actions?: Array<{ action_id: string; value: string }>;
    };

    if (payload.type === 'view_submission' && payload.view?.callback_id === 'override_modal') {
      const pid = payload.view.private_metadata;
      const values = payload.view.state.values;
      const reasonBlock = values['reason_block'];
      const reasonSelect = reasonBlock ? reasonBlock['reason_select'] : null;
      const selectedReason = reasonSelect?.selected_option?.value ?? 'other';

      // Map modal option values to OverrideReason enum
      const REASON_MAP: Record<string, OverrideReason> = {
        too_risky:      'on-call-discretion',
        fix_incorrect:  'wrong-fix',
        false_positive: 'wrong-diagnosis',
        other:          'other',
      };
      const corpusReason: OverrideReason = REASON_MAP[selectedReason] ?? 'other';

      // Persist to override corpus — was previously just logging
      recordOverride({
        incidentTag:     pid,
        proposedCommand: 'unknown',
        overrideReason:  corpusReason,
        service:         'unknown',
        environment:     process.env.NODE_ENV ?? 'production',
        actor:           'slack-user',
      });
      // Also record as calibration 'wrong' so detector accuracy stays honest
      recordVerdict(pid, 'wrong', selectedReason);
      logger.info({ pid, reason: corpusReason }, 'slack: override persisted to corpus');

      res.status(200).send(''); // ACK within 3s
      return;
    }

    for (const action of payload.actions ?? []) {
      // Shadow mode approval
      if (action.action_id.startsWith('shadow_approve_')) {
        try {
          const { pid, verdict } = JSON.parse(action.value) as { pid: string; verdict: string };
          // Record the 'would-approve' verdict in our calibration store
          recordVerdict(pid, 'correct'); // map shadow to calibration
          logger.info({ pid, verdict }, 'slack: shadow approval submitted');
        } catch (err) {
          logger.warn({ err, action }, 'slack: failed to parse action value');
        }
      }

      // Shadow mode override - trigger modal
      if (action.action_id.startsWith('shadow_override_') && payload.trigger_id) {
        try {
          const { pid } = JSON.parse(action.value) as { pid: string };
          await _openOverrideModal(payload.trigger_id, pid);
        } catch (err) {
          logger.warn({ err, action }, 'slack: failed to open override modal');
        }
      }

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

      // Execution gate — approve
      if (action.action_id.startsWith('execute_fix_')) {
        try {
          const { pid, command } = JSON.parse(action.value) as { pid: string; command: string };
          const userId = (payload as Record<string, unknown> & { user?: { id?: string } }).user?.id ?? 'slack-user';
          const record = approveExecution(pid);
          if (record) {
            logger.info({ pid, command, userId }, 'slack: fix execution approved');
            void postThreadReply(pid, `⚙️ _Fix approved by <@${userId}> — executing…_\n\`${command}\``);
            void executeRemediation(command, { cwd: record.cwd, actor: userId }).then((result) => {
              if (result.blocked) {
                void postThreadReply(pid, `🚫 *Fix blocked by safety filter:* ${result.blockReason}`);
              } else if (!result.ok) {
                void postThreadReply(pid, `❌ *Fix command failed* (exit ${result.exitCode})\n${result.stderr.slice(0, 500)}`);
              } else {
                void postThreadReply(pid, `✅ *Fix executed* (${result.durationMs}ms)`);
              }
            });
          }
        } catch (err) {
          logger.warn({ err, action }, 'slack: failed to handle execute_fix action');
        }
      }

      // Execution gate — deny
      if (action.action_id.startsWith('deny_fix_')) {
        try {
          const { pid } = JSON.parse(action.value) as { pid: string };
          const userId = (payload as Record<string, unknown> & { user?: { id?: string } }).user?.id ?? 'slack-user';
          if (denyExecution(pid)) {
            recordVerdict(pid, 'wrong', 'denied via Slack');
            void postThreadReply(pid, `🚫 _Fix execution denied by <@${userId}>._`);
            logger.info({ pid, userId }, 'slack: fix execution denied');
          }
        } catch (err) {
          logger.warn({ err, action }, 'slack: failed to handle deny_fix action');
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

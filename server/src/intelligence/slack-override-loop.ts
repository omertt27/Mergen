/**
 * slack-override-loop.ts — Automatic Slack-to-Override Memory Loop.
 *
 * Polls MERGEN_SLACK_CHANNEL every 6 hours for messages that look like
 * postmortem summaries or incident resolutions. When found, fetches the
 * full thread and passes it to compileOverrideFromSlackThread() to extract
 * machine-readable override patterns automatically.
 *
 * This makes the Override Corpus self-building: as your team discusses and
 * resolves incidents in Slack, Mergen learns the patterns without any
 * manual API calls.
 *
 * Activation: set MERGEN_SLACK_OVERRIDE_LOOP=true (or just set BOT_TOKEN +
 * CHANNEL — the loop is cheap and runs silently).
 * State file: ~/.mergen/slack-override-loop.json (tracks processed threads)
 */

import fs from 'fs';
import path from 'path';
import { DATA_DIR } from '../sensor/paths.js';
import logger from '../sensor/logger.js';
import { compileOverrideFromSlackThread } from './override-corpus.js';
import { synthesizeRulesFromCorpus } from './corpus-to-policy.js';

const BOT_TOKEN    = process.env.MERGEN_SLACK_BOT_TOKEN ?? '';
const SLACK_CHANNEL = process.env.MERGEN_SLACK_CHANNEL ?? '';
const POLL_INTERVAL_MS = 6 * 60 * 60 * 1_000; // 6 hours
const STATE_FILE = path.join(DATA_DIR, 'slack-override-loop.json');

// Signal phrases that indicate a postmortem or incident resolution thread
const POSTMORTEM_SIGNALS = [
  'postmortem', 'post-mortem', 'post mortem',
  'root cause', 'rca', 'fixed by', 'incident resolved',
  'outage resolved', 'mitigation', 'this was caused by',
  'we resolved', 'issue resolved', 'marked resolved',
  'runbook', 'we decided', 'going forward',
];

// ── State persistence ────────────────────────────────────────────────────────

interface LoopState {
  processedTs: string[];  // Slack message timestamps already ingested
  lastPollAt: number;
}

function loadState(): LoopState {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as LoopState;
    }
  } catch { /* start fresh */ }
  return { processedTs: [], lastPollAt: 0 };
}

function saveState(state: LoopState): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${STATE_FILE}.tmp`;
    // Keep last 5000 processed timestamps (avoid unbounded growth)
    state.processedTs = state.processedTs.slice(-5000);
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, STATE_FILE);
  } catch (err) {
    logger.warn({ err }, 'slack-override-loop: failed to persist state');
  }
}

// ── Slack API helpers ────────────────────────────────────────────────────────

async function _get(path: string): Promise<Record<string, unknown> | null> {
  if (!BOT_TOKEN) return null;
  try {
    const resp = await fetch(`https://slack.com${path}`, {
      headers: { 'Authorization': `Bearer ${BOT_TOKEN}` },
    });
    return await resp.json() as Record<string, unknown>;
  } catch { return null; }
}

async function _resolveChannel(nameOrId: string): Promise<string | null> {
  if (/^[CG][A-Z0-9]{6,}$/i.test(nameOrId)) return nameOrId;
  const clean = nameOrId.replace(/^#/, '').toLowerCase();
  let cursor: string | undefined;
  for (let page = 0; page < 3; page++) {
    const qs = new URLSearchParams({
      limit: '200', types: 'public_channel,private_channel', exclude_archived: 'true',
      ...(cursor ? { cursor } : {}),
    });
    const r = await _get(`/api/conversations.list?${qs}`) as { ok?: boolean; channels?: Array<{ id?: string; name?: string }>; response_metadata?: { next_cursor?: string } } | null;
    if (!r?.ok || !Array.isArray(r.channels)) break;
    const match = r.channels.find((c) => c.name?.toLowerCase() === clean);
    if (match?.id) return match.id;
    if (!r.response_metadata?.next_cursor) break;
    cursor = r.response_metadata.next_cursor;
  }
  return null;
}

async function _fetchHistory(channelId: string, oldest: string): Promise<Array<{ ts: string; text?: string; thread_ts?: string }>> {
  const qs = new URLSearchParams({ channel: channelId, oldest, limit: '100' });
  const r = await _get(`/api/conversations.history?${qs}`) as { ok?: boolean; messages?: Array<{ ts: string; text?: string; thread_ts?: string }> } | null;
  if (!r?.ok || !Array.isArray(r.messages)) return [];
  return r.messages;
}

async function _fetchThread(channelId: string, threadTs: string): Promise<string | null> {
  const messages: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 5; page++) {
    const qs = new URLSearchParams({
      channel: channelId, ts: threadTs, limit: '100',
      ...(cursor ? { cursor } : {}),
    });
    const r = await _get(`/api/conversations.replies?${qs}`) as { ok?: boolean; messages?: Array<{ ts: string; text?: string; username?: string; user?: string }>; response_metadata?: { next_cursor?: string } } | null;
    if (!r?.ok || !Array.isArray(r.messages)) break;
    for (const msg of r.messages) {
      if (msg.text) {
        const d = new Date(parseFloat(msg.ts) * 1000);
        const time = `${d.getUTCHours().toString().padStart(2, '0')}:${d.getUTCMinutes().toString().padStart(2, '0')}`;
        messages.push(`[${time}] ${msg.text.slice(0, 500)}`);
      }
    }
    if (!r.response_metadata?.next_cursor) break;
    cursor = r.response_metadata.next_cursor;
  }
  return messages.length > 0 ? messages.join('\n') : null;
}

// ── Feature 7: Post synthesized rules back to the Slack thread ────────────────

async function _postSynthesizedRules(channelId: string, threadTs: string): Promise<void> {
  if (!BOT_TOKEN) return;
  const newRules = synthesizeRulesFromCorpus();
  if (newRules.length === 0) return;

  const lines = newRules.slice(0, 3).map(
    (s) => `• *${s.rule.name}* (${s.sourceOccurrences} overrides, action: \`${s.rule.action}\`)`,
  );

  const payload = {
    channel: channelId,
    thread_ts: threadTs,
    text: `📋 Mergen detected ${newRules.length} new policy pattern${newRules.length !== 1 ? 's' : ''} from this thread.`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: [
            `📋 *Mergen detected ${newRules.length} new policy pattern${newRules.length !== 1 ? 's' : ''} from this postmortem.*`,
            ``,
            lines.join('\n'),
            ``,
            `Review and activate: \`GET /policy-suggestions\` → \`POST /policies/rules\``,
          ].join('\n'),
        },
      },
    ],
  };

  try {
    await fetch('https://slack.com/api/chat.postMessage', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${BOT_TOKEN}` },
      body:    JSON.stringify(payload),
      signal:  AbortSignal.timeout(8_000),
    });
  } catch (err) {
    logger.warn({ err }, 'slack-override-loop: failed to post synthesized rules notification');
  }
}

// ── Main poll ────────────────────────────────────────────────────────────────

async function poll(): Promise<void> {
  if (!BOT_TOKEN || !SLACK_CHANNEL) return;

  const state = loadState();
  const channelId = await _resolveChannel(SLACK_CHANNEL);
  if (!channelId) {
    logger.warn({ channel: SLACK_CHANNEL }, 'slack-override-loop: could not resolve channel ID');
    return;
  }

  // Look back 7 hours (slightly more than the 6h poll interval to avoid gaps)
  const oldestTs = String((Date.now() - 7 * 60 * 60 * 1_000) / 1000);
  const messages = await _fetchHistory(channelId, oldestTs);

  let newOverrides = 0;
  const processedSet = new Set(state.processedTs);

  for (const msg of messages) {
    const ts = msg.thread_ts ?? msg.ts;
    if (processedSet.has(ts)) continue;

    const text = (msg.text ?? '').toLowerCase();
    const isPostmortem = POSTMORTEM_SIGNALS.some((s) => text.includes(s));
    if (!isPostmortem) continue;

    // Fetch the full thread
    const threadText = await _fetchThread(channelId, ts);
    if (!threadText) {
      processedSet.add(ts);
      continue;
    }

    // Attempt to extract an override pattern
    const override = compileOverrideFromSlackThread(threadText, 'unknown');
    if (override) {
      newOverrides++;
      logger.info(
        { tag: override.incidentTag, reason: override.overrideReason, ts },
        'slack-override-loop: extracted override pattern from Slack thread',
      );
      // Feature 7: synthesize new policy rules from the updated corpus and notify Slack
      void _postSynthesizedRules(channelId, ts);
    }

    processedSet.add(ts);
  }

  state.processedTs = [...processedSet];
  state.lastPollAt = Date.now();
  saveState(state);

  if (newOverrides > 0) {
    logger.info({ newOverrides }, 'slack-override-loop: poll complete — new patterns added to corpus');
  } else {
    logger.debug('slack-override-loop: poll complete — no new patterns found');
  }
}

// ── Scheduler ────────────────────────────────────────────────────────────────

export function startSlackOverrideLoop(): void {
  if (!BOT_TOKEN || !SLACK_CHANNEL) {
    logger.warn('slack-override-loop: MERGEN_SLACK_BOT_TOKEN or MERGEN_SLACK_CHANNEL not set — loop disabled');
    return;
  }

  // Run once at startup (catches anything missed since last restart), then every 6h
  void poll();
  setInterval(() => { void poll(); }, POLL_INTERVAL_MS).unref();
  logger.info({ intervalHours: 6, channel: SLACK_CHANNEL }, 'slack-override-loop: scheduled — scanning for postmortem patterns every 6h');
}

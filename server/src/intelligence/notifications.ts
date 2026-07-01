/**
 * notifications.ts — Multi-channel notification router.
 *
 * Dispatches incident messages to all configured channels concurrently:
 *   - Slack   (via postThreadReply — requires MERGEN_SLACK_BOT_TOKEN)
 *   - Discord (via webhook — requires MERGEN_DISCORD_WEBHOOK_URL)
 *   - ntfy    (via push   — requires MERGEN_NTFY_URL + MERGEN_NTFY_TOPIC)
 *
 * All channels are optional. At least one should be configured.
 * Failures in one channel never block delivery to others.
 *
 * Usage:
 *   import { notify } from './notifications.js';
 *   await notify(pid, '✅ Incident resolved', { priority: 'high' });
 */

import { postThreadReply } from './slack.js';
import logger from '../sensor/logger.js';

export interface NotifyOptions {
  /** Maps to ntfy priority and Discord message formatting. */
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  /** ntfy tags (emoji shortcuts like 'warning', 'rotating_light'). */
  tags?: string[];
  /** If true, skip Slack — used for channels where a thread hasn't been seeded yet. */
  slackPid?: string;
}

// ── Discord ───────────────────────────────────────────────────────────────────

const DISCORD_WEBHOOK_URL = process.env.MERGEN_DISCORD_WEBHOOK_URL;

function stripSlackMarkdown(text: string): string {
  return text
    .replace(/\*([^*]+)\*/g, '**$1**') // *bold* → **bold** (Discord uses **)
    .replace(/_([^_]+)_/g, '_$1_')     // _ already Discord italic
    .replace(/`([^`]+)`/g, '`$1`');    // backticks compatible
}

async function notifyDiscord(message: string, opts?: NotifyOptions): Promise<void> {
  if (!DISCORD_WEBHOOK_URL) return;
  const content = stripSlackMarkdown(message).slice(0, 2000);
  const color = opts?.priority === 'urgent' || opts?.priority === 'high' ? 0xed4245 : 0x5865f2;
  const res = await fetch(DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      embeds: [{ description: content, color }],
    }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) logger.debug({ status: res.status }, 'notifications: Discord non-2xx');
}

// ── ntfy ──────────────────────────────────────────────────────────────────────

const NTFY_BASE_URL = process.env.MERGEN_NTFY_URL ?? 'https://ntfy.sh';
const NTFY_TOPIC    = process.env.MERGEN_NTFY_TOPIC ?? '';

const NTFY_PRIORITY_MAP: Record<NonNullable<NotifyOptions['priority']>, string> = {
  low:    '2',
  normal: '3',
  high:   '4',
  urgent: '5',
};

async function notifyNtfy(message: string, opts?: NotifyOptions): Promise<void> {
  if (!NTFY_TOPIC) return;
  const priority = NTFY_PRIORITY_MAP[opts?.priority ?? 'normal'];
  const plainText = message.replace(/[*_`]/g, '').slice(0, 4096);
  const headers: Record<string, string> = {
    'Content-Type': 'text/plain; charset=utf-8',
    'Priority': priority,
    'Title': 'Mergen',
  };
  if (opts?.tags?.length) headers['Tags'] = opts.tags.join(',');
  const ntfyToken = process.env.MERGEN_NTFY_TOKEN;
  if (ntfyToken) headers['Authorization'] = `Bearer ${ntfyToken}`;

  const res = await fetch(`${NTFY_BASE_URL}/${NTFY_TOPIC}`, {
    method: 'POST',
    headers,
    body: plainText,
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) logger.debug({ status: res.status }, 'notifications: ntfy non-2xx');
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Send a notification to all configured channels (Slack, Discord, ntfy).
 *
 * @param pid   — Incident id used for Slack thread lookup. Pass '' to skip Slack.
 * @param message — Slack-formatted markdown (Slack bold *text*, backtick code).
 * @param opts  — Optional routing hints.
 */
export async function notify(pid: string, message: string, opts?: NotifyOptions): Promise<void> {
  const tasks: Promise<unknown>[] = [];

  if (pid) {
    tasks.push(
      postThreadReply(pid, message).catch((err: unknown) => {
        logger.debug({ err }, 'notifications: Slack delivery failed');
      }),
    );
  }

  if (DISCORD_WEBHOOK_URL) {
    tasks.push(
      notifyDiscord(message, opts).catch((err: unknown) => {
        logger.debug({ err }, 'notifications: Discord delivery failed');
      }),
    );
  }

  if (NTFY_TOPIC) {
    tasks.push(
      notifyNtfy(message, opts).catch((err: unknown) => {
        logger.debug({ err }, 'notifications: ntfy delivery failed');
      }),
    );
  }

  if (tasks.length === 0) {
    logger.debug({ pid }, 'notifications: no channels configured — message dropped');
  }

  await Promise.all(tasks);
}

/** True when at least one notification channel is configured. */
export function hasNotificationChannel(): boolean {
  return !!(process.env.MERGEN_SLACK_BOT_TOKEN || DISCORD_WEBHOOK_URL || NTFY_TOPIC);
}

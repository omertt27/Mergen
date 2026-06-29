/**
 * shadow-digest-cron.ts — Weekly automated Slack digest of shadow mode track record.
 *
 * Fires every Monday at 09:00 UTC. Posts a summary of the past week's shadow
 * recommendations to MERGEN_SLACK_DIGEST_CHANNEL (defaults to MERGEN_SLACK_CHANNEL).
 *
 * Only active when MERGEN_SHADOW_MODE=true or MERGEN_AUTOPILOT=true AND a
 * Slack bot token is configured. Silent no-op otherwise — no error, no log.
 *
 * The digest answers: "How many incidents did Mergen see? How many would it
 * have resolved? What would that have saved in MTTR?" — the weekly number
 * that keeps the design partner feedback loop alive.
 */

import { getStores } from '../storage/store-registry.js';
import logger from '../sensor/logger.js';

const SYSTEM_TENANT = process.env.MERGEN_SYSTEM_TENANT_ID;

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/** Returns milliseconds until the next Monday at 09:00 UTC. */
function msUntilNextMonday0900Utc(): number {
  const now = new Date();
  const day = now.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const daysUntilMonday = day === 1 ? 7 : (8 - day) % 7 || 7;
  const next = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + daysUntilMonday,
    9, 0, 0, 0,
  ));
  return Math.max(next.getTime() - Date.now(), 0);
}

async function postDigest(): Promise<void> {
  const token   = process.env.MERGEN_SLACK_BOT_TOKEN;
  const channel = process.env.MERGEN_SLACK_DIGEST_CHANNEL ?? process.env.MERGEN_SLACK_CHANNEL;

  if (!token || !channel) {
    logger.debug('shadow-digest-cron: no Slack token or channel — skipping digest');
    return;
  }

  const blocks = await getStores().shadowLog.getShadowSlackDigest(7, SYSTEM_TENANT);

  try {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ channel, blocks }),
    });

    if (!res.ok) {
      logger.warn({ status: res.status }, 'shadow-digest-cron: HTTP error posting to Slack');
      return;
    }

    const json = await res.json() as { ok: boolean; error?: string };
    if (!json.ok) {
      logger.warn({ slackError: json.error }, 'shadow-digest-cron: Slack API error');
      return;
    }

    logger.info({ channel }, 'shadow-digest-cron: weekly digest posted');
  } catch (err) {
    logger.warn({ err }, 'shadow-digest-cron: failed to post digest');
  }
}

/**
 * Start the weekly digest cron. Call once at boot.
 *
 * Returns a cleanup function that cancels both the initial timeout and the
 * weekly interval — pass to your shutdown handler if you want clean shutdown.
 */
export function startShadowDigestCron(): () => void {
  const isShadowMode  = process.env.MERGEN_SHADOW_MODE === 'true';
  const isAutopilot   = process.env.MERGEN_AUTOPILOT   === 'true';
  const hasSlackToken = !!process.env.MERGEN_SLACK_BOT_TOKEN;
  const hasChannel    = !!(process.env.MERGEN_SLACK_DIGEST_CHANNEL ?? process.env.MERGEN_SLACK_CHANNEL);

  if ((!isShadowMode && !isAutopilot) || !hasSlackToken || !hasChannel) {
    return () => { /* no-op */ };
  }

  const delay = msUntilNextMonday0900Utc();
  logger.info(
    { nextFireInHours: Math.round(delay / 3_600_000) },
    'shadow-digest-cron: scheduled (Monday 09:00 UTC)',
  );

  let intervalHandle: ReturnType<typeof setInterval> | null = null;

  const timeoutHandle = setTimeout(() => {
    void postDigest();
    intervalHandle = setInterval(() => { void postDigest(); }, SEVEN_DAYS_MS);
    intervalHandle.unref();
  }, delay);
  timeoutHandle.unref();

  return () => {
    clearTimeout(timeoutHandle);
    if (intervalHandle) clearInterval(intervalHandle);
  };
}

/**
 * slack-digest.ts — Daily operational digest posted to Slack at 09:00 UTC.
 *
 * Surfaces the key operational metrics from the last 24h without requiring
 * the SRE to open a dashboard or run an MCP tool. Engineers who don't use
 * an AI IDE still get passive awareness of system health.
 *
 * Activated by MERGEN_SLACK_DIGEST=true + MERGEN_SLACK_BOT_TOKEN.
 * Test immediately: POST /slack/digest/test
 */
import fs from 'fs';
import path from 'path';
import { DATA_DIR } from '../sensor/paths.js';
import logger from '../sensor/logger.js';
import { incidentStore } from '../sensor/incident-store.js';
import { getStats, getRealVerdictCount, isCorpusSeeded } from './calibration.js';
import { getOverrideSummary, getStaleOverrides } from './override-corpus.js';
import type { Runbook } from '../routes/runbooks.js';

const BOT_TOKEN    = process.env.MERGEN_SLACK_BOT_TOKEN ?? '';
const SLACK_CHANNEL = process.env.MERGEN_SLACK_CHANNEL ?? '';

// ── Slack API helper (minimal — reuse same pattern as slack.ts) ──────────────

async function _post(payload: Record<string, unknown>): Promise<void> {
  if (!BOT_TOKEN || !SLACK_CHANNEL) return;
  try {
    const resp = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${BOT_TOKEN}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ channel: SLACK_CHANNEL, ...payload }),
    });
    const json = await resp.json() as { ok: boolean; error?: string };
    if (!json.ok) logger.warn({ error: json.error }, 'slack-digest: postMessage failed');
  } catch (err) {
    logger.warn({ err }, 'slack-digest: fetch error');
  }
}

// ── Digest builder ───────────────────────────────────────────────────────────

export async function postDailyDigest(): Promise<void> {
  if (!BOT_TOKEN || !SLACK_CHANNEL) {
    logger.warn('slack-digest: MERGEN_SLACK_BOT_TOKEN or MERGEN_SLACK_CHANNEL not set — skipping digest');
    return;
  }

  const now = Date.now();
  const since24h = now - 24 * 60 * 60 * 1_000;

  // Incidents in last 24h
  const allIncidents = incidentStore.list();
  const recent = allIncidents.filter((i) => i.createdAt >= since24h);
  const resolved = recent.filter((i) => i.status === 'resolved');
  const autonomous = resolved.filter((i) => i.resolvedAutonomously);
  const avgMttrMin = resolved.length > 0
    ? Math.round(
        resolved.reduce((sum, i) => sum + ((i.resolvedAt ?? now) - i.createdAt), 0)
        / resolved.length / 60_000,
      )
    : null;

  // Calibration state
  const stats = getStats();
  const driftingTags = stats.filter(
    (s) => s.trusted && s.trendDelta != null && s.trendDelta < -0.05,
  );
  const realVerdicts = getRealVerdictCount();
  const seeded = isCorpusSeeded();

  // Override patterns (top 3 most recent) + staleness check
  const overrideSummary = getOverrideSummary().slice(0, 3);
  const staleOverrides  = getStaleOverrides(60);

  // Stale override corpus entries (not reviewed in >60 days)
  if (staleOverrides.length > 0) {
    const topStale = staleOverrides.slice(0, 3);
    const staleLines = [
      `*⚠️ Override Corpus — ${staleOverrides.length} Stale ${staleOverrides.length === 1 ? 'Entry' : 'Entries'} (>60 days without review)*`,
      ...topStale.map((e) => {
        const age = Math.floor((Date.now() - (e.reviewedAt ?? e.recordedAt)) / 86_400_000);
        return `• \`${e.incidentTag}\` · ${e.service} · ${e.overrideReason} — _${age}d since last review_`;
      }),
      staleOverrides.length > 3 ? `_…and ${staleOverrides.length - 3} more. Review at_ \`GET /override-corpus/stale\`` : '',
      `_Re-affirm: \`POST /overrides/{id}/review\`  ·  Remove: \`DELETE /overrides/{id}\`_`,
    ].filter(Boolean);
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: staleLines.join('\n') } });
  }

  // Pending runbook approvals — runbooks created but not yet approved
  const pendingRunbooks: Runbook[] = [];
  try {
    const libraryFile = path.join(DATA_DIR, 'runbooks', 'library.json');
    if (fs.existsSync(libraryFile)) {
      const all = JSON.parse(fs.readFileSync(libraryFile, 'utf8')) as Runbook[];
      pendingRunbooks.push(...all.filter((r) => !r.approved));
    }
  } catch { /* non-fatal */ }

  const blocks: unknown[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: '📋 Mergen Daily Digest', emoji: true },
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `Last 24h · ${new Date().toUTCString()}` }],
    },
    { type: 'divider' },
  ];

  // Incident summary section
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: [
        `*Incidents (last 24h)*`,
        `• Total fired: *${recent.length}*`,
        resolved.length > 0 ? `• Resolved: *${resolved.length}*` : '',
        autonomous.length > 0 ? `• Autonomous resolution: *${autonomous.length}/${resolved.length}* (${Math.round((autonomous.length / resolved.length) * 100)}%)` : '',
        avgMttrMin != null ? `• Avg MTTR: *${avgMttrMin} min*` : '',
        recent.length === 0 ? '_No incidents in last 24h_ ✅' : '',
      ].filter(Boolean).join('\n'),
    },
  });

  // Calibration health
  const calibLines = [
    `*Calibration*`,
    seeded
      ? `• ⚠️ Warm-up phase — ${realVerdicts}/10 real verdicts recorded`
      : `• ${realVerdicts} real verdicts — confidence is environment-calibrated`,
    driftingTags.length > 0
      ? `• ⚠️ Accuracy regression on: ${driftingTags.map((t) => `\`${t.tag}\``).join(', ')}`
      : '• All detectors stable',
  ];
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: calibLines.join('\n') } });

  // Override patterns
  if (overrideSummary.length > 0) {
    const overrideLines = [
      `*Recent Override Patterns*`,
      ...overrideSummary.map(
        (o) => `• \`${o.tag}\` — ${o.dominantReason ?? 'on-call-discretion'} (${o.total}×)`,
      ),
    ];
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: overrideLines.join('\n') } });
  }

  // Pending runbook approvals
  if (pendingRunbooks.length > 0) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          `*Runbooks Awaiting Approval*`,
          ...pendingRunbooks.map(
            (r) => r ? `• \`${r.name}\` (\`${r.incidentTag}\`) — ${r.approvals.length}/${r.requiredApprovers} approvals` : '',
          ),
        ].filter(Boolean).join('\n'),
      },
    });
  }

  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: 'Mergen Operational Digest · <http://127.0.0.1:3000/dashboard|Dashboard> · <http://127.0.0.1:3000/incidents/impact-report|Impact Report>' }],
  });

  await _post({ blocks });
  logger.info({ incidents: recent.length, resolved: resolved.length }, 'slack-digest: posted daily digest');
}

// ── Scheduler ────────────────────────────────────────────────────────────────

function msUntilNext9amUtc(): number {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 9, 0, 0, 0));
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

export function startSlackDailyDigest(): void {
  const delay = msUntilNext9amUtc();
  logger.info({ nextDigestIn: `${Math.round(delay / 60_000)}min` }, 'slack-digest: scheduled daily digest at 09:00 UTC');

  setTimeout(() => {
    void postDailyDigest();
    // After the first fire, repeat every 24h
    setInterval(() => { void postDailyDigest(); }, 24 * 60 * 60 * 1_000).unref();
  }, delay).unref();
}

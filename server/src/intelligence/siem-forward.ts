/**
 * siem-forward.ts — Outbound SIEM forwarding for the Agent Blunder Log.
 *
 * There was previously no SIEM integration anywhere in this codebase despite
 * being mentioned in the security-comparison docs. Two delivery modes, both
 * opt-in via env var (unset = no-op, no behavior change for existing
 * deployments):
 *
 *   1. Generic webhook — MERGEN_SIEM_WEBHOOK_URL (+ optional bearer token
 *      MERGEN_SIEM_WEBHOOK_TOKEN). POSTs the raw blunder event as JSON.
 *   2. Splunk HTTP Event Collector — MERGEN_SPLUNK_HEC_URL +
 *      MERGEN_SPLUNK_HEC_TOKEN. Wraps the event in HEC's {event: {...}}
 *      envelope with `Authorization: Splunk <token>`, the most likely SIEM
 *      target for this product's mid-market ICP.
 *
 * Modeled on datadog/client.ts's ddPost — fetch + AbortSignal.timeout +
 * custom auth headers is the cleanest existing "authenticated POST with a
 * timeout" template in this codebase; reused rather than inventing a new one.
 *
 * Called fire-and-forget from agent-blunder-store.ts's recordBlunder(), same
 * non-blocking pattern already used there for policy-history recording — a
 * SIEM endpoint being slow or down must never add latency to the gate path.
 */
import logger from '../sensor/logger.js';
import type { BlunderEvent } from '../sensor/agent-blunder-store.js';

function webhookConfigured(): boolean {
  return !!process.env.MERGEN_SIEM_WEBHOOK_URL;
}

function splunkHecConfigured(): boolean {
  return !!(process.env.MERGEN_SPLUNK_HEC_URL && process.env.MERGEN_SPLUNK_HEC_TOKEN);
}

export function siemForwardingConfigured(): boolean {
  return webhookConfigured() || splunkHecConfigured();
}

async function postWebhook(entry: BlunderEvent): Promise<void> {
  const url = process.env.MERGEN_SIEM_WEBHOOK_URL!;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (process.env.MERGEN_SIEM_WEBHOOK_TOKEN) {
    headers.Authorization = `Bearer ${process.env.MERGEN_SIEM_WEBHOOK_TOKEN}`;
  }
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ source: 'mergen_agent_blunder_log', ...entry }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) {
    throw new Error(`SIEM webhook POST failed: HTTP ${res.status}`);
  }
}

async function postSplunkHec(entry: BlunderEvent): Promise<void> {
  const url = process.env.MERGEN_SPLUNK_HEC_URL!;
  const token = process.env.MERGEN_SPLUNK_HEC_TOKEN!;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Splunk ${token}`,
    },
    body: JSON.stringify({
      time: Math.floor(entry.recordedAt / 1000),
      sourcetype: 'mergen:agent_blunder',
      event: entry,
    }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) {
    throw new Error(`Splunk HEC POST failed: HTTP ${res.status}`);
  }
}

/**
 * Fire-and-forget forward of a single blunder entry to every configured SIEM
 * sink. Never throws — logs and swallows delivery failures so a down/slow
 * SIEM endpoint can never affect the gate path that produced this entry.
 */
export function forwardToSiem(entry: BlunderEvent): void {
  if (webhookConfigured()) {
    postWebhook(entry).catch((err) => {
      logger.warn({ err, id: entry.id }, 'siem-forward: webhook delivery failed');
    });
  }
  if (splunkHecConfigured()) {
    postSplunkHec(entry).catch((err) => {
      logger.warn({ err, id: entry.id }, 'siem-forward: Splunk HEC delivery failed');
    });
  }
}

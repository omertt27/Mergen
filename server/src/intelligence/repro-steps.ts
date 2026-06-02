/**
 * repro-steps.ts — Generate draft reproduction steps from the event timeline.
 *
 * Takes the sequence of context snapshots, network calls, and console errors
 * and reconstructs the user journey that led to the bug.
 *
 * Output format (human-readable, ready to paste into a Jira/Linear ticket):
 *
 *   Steps to reproduce:
 *   1. Navigate to /login
 *   2. [Form state] Active element: input#email
 *   3. Network: POST /api/auth/login → 500 Internal Server Error (342ms)
 *   4. Error: "Token refresh failed: null pointer"
 *   5. [State change] localStorage.token cleared
 *
 * Quality gate: requires ≥2 context snapshots for a reliable sequence.
 * With fewer, we still return what we have but mark confidence as LOW.
 */

import type { ConsoleEvent, NetworkEvent, ContextSnapshot } from '../sensor/buffer.js';

export type ReproConfidence = 'HIGH' | 'MEDIUM' | 'LOW';

export interface ReproSteps {
  steps: string[];
  confidence: ReproConfidence;
  preconditions: string[];
  /** ISO timestamp of the error that these steps lead to. */
  errorAt: string | null;
  /** Plain-text blob ready to paste into a ticket description. */
  markdown: string;
}

function describeUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + (u.search ? u.search.slice(0, 40) : '');
  } catch {
    return url.slice(0, 80);
  }
}

function describeLocalStorageChange(
  prev: Record<string, string>,
  curr: Record<string, string>,
): string[] {
  const changes: string[] = [];
  for (const key of Object.keys(curr)) {
    if (prev[key] !== curr[key]) {
      const v = curr[key];
      const display = v?.length > 30 ? v.slice(0, 30) + '…' : v;
      if (key in prev) {
        changes.push(`localStorage.${key} changed → "${display}"`);
      } else {
        changes.push(`localStorage.${key} set → "${display}"`);
      }
    }
  }
  for (const key of Object.keys(prev)) {
    if (!(key in curr)) changes.push(`localStorage.${key} removed`);
  }
  return changes;
}

export function generateReproSteps(
  logs: ConsoleEvent[],
  network: NetworkEvent[],
  contexts: ContextSnapshot[],
): ReproSteps {
  if (contexts.length === 0 && logs.filter((l) => l.level === 'error').length === 0) {
    return {
      steps: ['No events captured yet — open your app with the Mergen extension active and reproduce the bug.'],
      confidence: 'LOW',
      preconditions: [],
      errorAt: null,
      markdown: '',
    };
  }

  const sorted = [...contexts].sort((a, b) => a.timestamp - b.timestamp);
  const errors = logs.filter((l) => l.level === 'error').sort((a, b) => a.timestamp - b.timestamp);
  const firstError = errors[0] ?? null;
  const errorTs = firstError?.timestamp ?? null;

  // Only include events before (and slightly after) the first error
  const cutoff = errorTs ? errorTs + 2000 : Infinity;

  const relevantNetwork = network
    .filter((n) => n.timestamp <= cutoff)
    .sort((a, b) => a.timestamp - b.timestamp);

  const steps: string[] = [];
  const preconditions: string[] = [];

  // ── Preconditions from first context snapshot ─────────────────────────────
  if (sorted[0]) {
    const c = sorted[0];
    preconditions.push(`App is open at: ${describeUrl(c.url)}`);
    if (c.title && c.title !== c.url) preconditions.push(`Page title: "${c.title}"`);

    const authKeys = ['token', 'userToken', 'accessToken', 'authToken', 'jwt'];
    const hasAuth = authKeys.some((k) => k in c.localStorage && c.localStorage[k]);
    if (hasAuth) preconditions.push('User is authenticated (auth token present in localStorage)');
  }

  // ── Build timeline of steps ───────────────────────────────────────────────
  type TimedStep = { ts: number; text: string };
  const timedSteps: TimedStep[] = [];

  // Context snapshot transitions
  for (let i = 0; i < sorted.length; i++) {
    const c = sorted[i];
    if (c.timestamp > cutoff) break;

    if (i === 0) {
      timedSteps.push({ ts: c.timestamp, text: `Navigate to ${describeUrl(c.url)}` });
    } else {
      const prev = sorted[i - 1];
      if (prev.url !== c.url) {
        timedSteps.push({ ts: c.timestamp, text: `Navigate to ${describeUrl(c.url)}` });
      }
      // localStorage state changes
      const changes = describeLocalStorageChange(prev.localStorage, c.localStorage);
      for (const change of changes.slice(0, 3)) {
        timedSteps.push({ ts: c.timestamp, text: `[State] ${change}` });
      }
    }
    if (c.activeElement && c.activeElement !== 'body') {
      timedSteps.push({ ts: c.timestamp, text: `[Interaction] Focus on ${c.activeElement}` });
    }
    if (c.component) {
      timedSteps.push({ ts: c.timestamp, text: `[Component] ${c.component} rendered` });
    }
  }

  // Network calls
  for (const n of relevantNetwork) {
    const status = n.status === 0 ? 'network error' : `${n.status} ${n.statusText}`;
    const fail   = n.status >= 400 || n.status === 0 || n.error;
    const body   = n.requestBody && typeof n.requestBody === 'object'
      ? ` (body: ${JSON.stringify(n.requestBody).slice(0, 80)})`
      : '';
    const flag   = fail ? ' ⚠' : '';
    timedSteps.push({
      ts: n.timestamp,
      text: `Network: ${n.method} ${describeUrl(n.url)} → ${status} (${n.duration}ms)${body}${flag}`,
    });
  }

  // Warnings before the error
  for (const w of logs.filter((l) => l.level === 'warn' && l.timestamp <= cutoff)) {
    const msg = w.args.map((a) => typeof a === 'string' ? a : JSON.stringify(a)).join(' ').slice(0, 150);
    timedSteps.push({ ts: w.timestamp, text: `Warning: "${msg}"` });
  }

  // The error itself
  if (firstError) {
    const msg = firstError.args
      .map((a) => typeof a === 'string' ? a : JSON.stringify(a))
      .join(' ').slice(0, 200);
    timedSteps.push({ ts: firstError.timestamp, text: `❌ Error: "${msg}"` });
    if (firstError.stack) {
      const frame = firstError.stack.split('\n').slice(1, 3).join(' ← ').trim();
      if (frame) timedSteps.push({ ts: firstError.timestamp, text: `   at ${frame.slice(0, 150)}` });
    }
  }

  // Sort and deduplicate consecutive identical steps
  timedSteps.sort((a, b) => a.ts - b.ts);
  let prev = '';
  for (const s of timedSteps) {
    if (s.text !== prev) { steps.push(s.text); prev = s.text; }
  }

  // ── Confidence ───────────────────────────────────────────────────────────
  const confidence: ReproConfidence =
    sorted.length >= 3 && firstError ? 'HIGH'
    : sorted.length >= 2 || (firstError && relevantNetwork.length > 0) ? 'MEDIUM'
    : 'LOW';

  // ── Markdown ─────────────────────────────────────────────────────────────
  const lines: string[] = [];
  if (preconditions.length) {
    lines.push('**Preconditions:**');
    for (const p of preconditions) lines.push(`- ${p}`);
    lines.push('');
  }
  lines.push('**Steps to reproduce:**');
  steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
  lines.push('');
  lines.push(`*Confidence: ${confidence} · Generated by Mergen*`);

  return {
    steps,
    confidence,
    preconditions,
    errorAt: errorTs ? new Date(errorTs).toISOString() : null,
    markdown: lines.join('\n'),
  };
}

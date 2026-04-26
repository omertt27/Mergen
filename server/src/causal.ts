/**
 * causal.ts — Causal chain reconstruction engine.
 *
 * Core idea:
 *   Don't give the LLM raw telemetry and ask it to figure out causality.
 *   Do the correlation work here, then give the LLM a structured story:
 *     "User did X → State was Y → Network did Z → This broke → Here's the line"
 *
 * Output format is a self-contained "Context Pack" string — dense, structured,
 * and minimal. The LLM spends its tokens on diagnosis, not on parsing noise.
 */

import type { ConsoleEvent, NetworkEvent, ContextSnapshot } from './buffer.js';
import { resolveFirstFrame, resolveStackTrace, resolveFrameAndStack } from './sourcemap.js';
import logger from './logger.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CausalEvent {
  ts: number;
  isoTs: string;
  kind: 'nav' | 'network_ok' | 'network_fail' | 'warn' | 'error' | 'state';
  summary: string;
  detail?: string;
}

export interface SourceFrame {
  fn: string;
  file: string;
  line: number;
  column: number;
  snippet: string;      // pre-formatted code block with pointer line
  rawResolved: string;  // full resolved stack line
}

export interface ErrorBlock {
  message: string;
  timestamp: number;
  isoTs: string;
  primaryFrame: SourceFrame | null;
  resolvedStack: string;
}

export interface StateBlock {
  url: string;
  pageTitle: string;
  focusedElement: string | null;
  component: string | null;
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
  timestamp: number;
  isoTs: string;
}

export interface CorrelatedNetworkCall {
  method: string;
  url: string;
  status: number;
  statusText: string;
  durationMs: number;
  requestBody: unknown;
  requestHeaders: Record<string, string>;
  responseBody: unknown;
  responseHeaders: Record<string, string>;
  error: string | null;
  msBeforeError: number | null;
  isoTs: string;
}

// ── Hypothesis Engine ────────────────────────────────────────────────────────
// A structured pre-diagnosis generated from correlated signals.
// Each detector fires independently; all that meet the threshold are returned
// as competing hypotheses, ranked by confidenceScore. The LLM chooses.
//
// ⚠️  These are heuristic scores, not learned weights. They will mis-fire on
// edge cases (race conditions, state overwrites, etc.). The system is designed
// to be honest about this: it never suppresses a lower-ranked hypothesis, and
// it explicitly reports "insufficient data" when no detector passes the minimum
// threshold. A wrong confident answer is worse than no answer.

export type ConfidenceLevel = 'HIGH' | 'MEDIUM' | 'LOW' | 'INSUFFICIENT';

/** Minimum score a hypothesis must reach to be included in output. Below this,
 *  the system reports "insufficient data" for that detector rather than guess. */
const MIN_HYPOTHESIS_SCORE = 0.25;

export interface Hypothesis {
  /** Machine-readable label — stable identifier for tests and tooling */
  tag: string;
  /** One sentence root cause: what broke and why. */
  summary: string;
  confidence: ConfidenceLevel;
  /** 0.0 – 1.0, sum of corroborating signal weights for this specific pattern */
  confidenceScore: number;
  /** Supporting facts from the telemetry that justify the hypothesis */
  evidence: string[];
  /** Ordered steps showing how one event caused the next: A → B → C → crash */
  causalPath: string[];
  /** Minimal concrete fix suggestion, or null if not enough signal */
  fixHint: string | null;
}

export interface CausalChain {
  capturedAt: string;
  totalEvents: number;
  errors: ErrorBlock[];
  chain: CausalEvent[];           // chronological, all event types
  stateAtError: StateBlock | null;
  correlatedNetwork: CorrelatedNetworkCall[];
  /** All hypotheses that met MIN_HYPOTHESIS_SCORE, ranked by confidenceScore descending.
   *  Empty array = insufficient signal — the system explicitly has no theory. */
  hypotheses: Hypothesis[];
  contextPack: string;            // the full formatted string for the LLM
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** How far back (ms) from the first error to look for correlated network events */
const CORRELATION_WINDOW_MS = 30_000;

/** How far back (ms) from the error to look for a state snapshot */
const STATE_WINDOW_MS = 5_000;

// ── Helpers ───────────────────────────────────────────────────────────────────

function isoTs(ts: number): string {
  return new Date(ts).toISOString().replace('T', ' ').replace('Z', '');
}

function truncate(value: unknown, maxLen = 300): string {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return s.length > maxLen ? s.slice(0, maxLen) + ' …' : s;
}

function errorMessage(e: ConsoleEvent): string {
  return e.args
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ')
    .split('\n')[0]   // first line only — stack trace comes separately
    .slice(0, 300);
}

// ── Source resolution ─────────────────────────────────────────────────────────

async function buildErrorBlock(e: ConsoleEvent): Promise<ErrorBlock> {
  const message = errorMessage(e);
  let primaryFrame: SourceFrame | null = null;
  let resolvedStack = '';

  if (e.stack) {
    try {
      // P5.3: single-pass — one getMapIndex() call, two results
      ({ primaryFrame, resolvedStack } = await resolveFrameAndStack(e.stack));
    } catch (err) {
      logger.warn({ err }, 'sourcemap resolution failed');
      resolvedStack = e.stack;
    }
  }

  return {
    message,
    timestamp: e.timestamp,
    isoTs: isoTs(e.timestamp),
    primaryFrame,
    resolvedStack,
  };
}

// ── Causal chain builder ──────────────────────────────────────────────────────

export async function buildCausalChain(
  logs: ConsoleEvent[],
  network: NetworkEvent[],
  contexts: ContextSnapshot[],
  since?: number,
): Promise<CausalChain> {
  const capturedAt = new Date().toISOString();
  const totalEvents = logs.length + network.length;

  const errors = logs.filter((e) => e.level === 'error');
  const warns  = logs.filter((e) => e.level === 'warn');
  const firstErrorTs = errors[0]?.timestamp ?? Date.now();

  // ── Resolve all error blocks (sourcemap) ────────────────────────────────────
  const errorBlocks: ErrorBlock[] = await Promise.all(errors.map(buildErrorBlock));

  // ── Find state snapshot closest to (and before) the first error ─────────────
  const relevantContexts = contexts
    .filter((c) => c.timestamp <= firstErrorTs && c.timestamp >= firstErrorTs - STATE_WINDOW_MS)
    .sort((a, b) => b.timestamp - a.timestamp); // most recent first

  const stateSnap = relevantContexts[0] ?? null;
  const stateAtError: StateBlock | null = stateSnap
    ? {
        url: stateSnap.url,
        pageTitle: stateSnap.title,
        focusedElement: stateSnap.activeElement ?? null,
        component: stateSnap.component ?? null,
        localStorage: stateSnap.localStorage,
        sessionStorage: stateSnap.sessionStorage,
        timestamp: stateSnap.timestamp,
        isoTs: isoTs(stateSnap.timestamp),
      }
    : null;

  // ── Correlate network calls within the window before the first error ─────────
  const windowStart = firstErrorTs - CORRELATION_WINDOW_MS;
  const correlatedNetwork: CorrelatedNetworkCall[] = network
    .filter((n) => n.timestamp >= windowStart)
    .map((n) => ({
      method: n.method,
      url: n.url,
      status: n.status,
      statusText: n.statusText,
      durationMs: n.duration,
      requestBody: n.requestBody,
      requestHeaders: n.requestHeaders ?? {},
      responseBody: n.responseBody,
      responseHeaders: n.responseHeaders ?? {},
      error: n.error ?? null,
      msBeforeError: errors.length ? Math.max(0, firstErrorTs - n.timestamp) : null,
      isoTs: isoTs(n.timestamp),
    }))
    .sort((a, b) => {
      // P1.4: msBeforeError is null when there are no errors — sort nulls last
      if (a.msBeforeError === null && b.msBeforeError === null) return 0;
      if (a.msBeforeError === null) return 1;
      if (b.msBeforeError === null) return -1;
      return a.msBeforeError - b.msBeforeError;
    });   // closest to error first

  // ── Build chronological event chain ─────────────────────────────────────────
  const chain: CausalEvent[] = [];

  // Detect navigation — URL changes in context snapshots
  const urls = [...new Set(contexts.map((c) => c.url))];
  for (const ctx of contexts.sort((a, b) => a.timestamp - b.timestamp)) {
    chain.push({
      ts: ctx.timestamp, isoTs: isoTs(ctx.timestamp),
      kind: 'state',
      summary: `State snapshot captured on ${ctx.url}`,
      detail: `Page: "${ctx.title}"` +
        (ctx.activeElement ? ` | focused: ${ctx.activeElement}` : '') +
        (ctx.component ? ` | component: <${ctx.component}>` : ''),
    });
  }

  for (const n of network.filter((n) => n.timestamp >= windowStart).sort((a, b) => a.timestamp - b.timestamp)) {
    const ok = n.status > 0 && n.status < 400;
    chain.push({
      ts: n.timestamp, isoTs: isoTs(n.timestamp),
      kind: ok ? 'network_ok' : 'network_fail',
      summary: `${n.method} ${n.url} → ${n.status || 'ERR'} (${n.duration}ms)`,
      detail: n.error
        ? `Error: ${n.error}`
        : n.responseBody
          ? `Response: ${truncate(n.responseBody, 200)}`
          : undefined,
    });
  }

  for (const w of warns.sort((a, b) => a.timestamp - b.timestamp)) {
    chain.push({
      ts: w.timestamp, isoTs: isoTs(w.timestamp),
      kind: 'warn',
      summary: errorMessage(w),
    });
  }

  for (const e of errors.sort((a, b) => a.timestamp - b.timestamp)) {
    chain.push({
      ts: e.timestamp, isoTs: isoTs(e.timestamp),
      kind: 'error',
      summary: `❌ ${errorMessage(e)}`,
    });
  }

  chain.sort((a, b) => a.ts - b.ts);

  // ── Hypothesis Engine ────────────────────────────────────────────────────────
  // Each detector function runs independently on the same telemetry and returns
  // a Hypothesis if it fires, or null if it doesn't see its pattern.
  // All hypotheses that score >= MIN_HYPOTHESIS_SCORE are kept and ranked.
  // If none pass the threshold the system says "insufficient data" — it never
  // invents a confident answer from weak signal.

  type DetectorInput = {
    primaryErr: ErrorBlock;
    stateAtError: StateBlock | null;
    correlatedNetwork: CorrelatedNetworkCall[];
    chain: CausalEvent[];
  };

  function scoreToConfidence(score: number): ConfidenceLevel {
    if (score >= 0.65) return 'HIGH';
    if (score >= 0.40) return 'MEDIUM';
    if (score >= MIN_HYPOTHESIS_SCORE) return 'LOW';
    return 'INSUFFICIENT';
  }

  // ── Detector A: auth token not persisted after successful login ───────────
  // Pattern: POST /auth → 200 OK  →  token key absent/null in localStorage  →  crash
  function detectAuthTokenNotPersisted(d: DetectorInput): Hypothesis | null {
    if (!d.stateAtError) return null;
    const authCalls = d.correlatedNetwork.filter(
      (n) => /login|auth|signin|token/i.test(n.url) && n.status === 200,
    );
    if (authCalls.length === 0) return null;

    const ls = d.stateAtError.localStorage;
    const AUTH_KEYS = ['token', 'userToken', 'accessToken', 'authToken', 'jwt', 'user', 'session'];
    const missingKeys = AUTH_KEYS.filter(
      (k) => !(k in ls) || ls[k] === 'null' || ls[k] === '' || ls[k] === 'undefined',
    );
    if (missingKeys.length === 0) return null;

    const authCall = authCalls[authCalls.length - 1];
    const key = missingKeys[0];
    let score = 0.55; // auth call 200 + token missing is strong
    if (d.primaryErr.primaryFrame) score += 0.15; // source frame adds certainty
    const confidence = scoreToConfidence(score);
    if (confidence === 'INSUFFICIENT') return null;

    return {
      tag: 'auth_token_not_persisted',
      summary: `Auth token from \`${authCall.url}\` was not persisted — code reads \`${key}\` from localStorage and gets null.`,
      confidence,
      confidenceScore: score,
      evidence: [
        `\`${authCall.method} ${authCall.url}\` returned HTTP 200.`,
        `\`localStorage.${key}\` is null/absent at crash time.`,
        ...(d.primaryErr.primaryFrame
          ? [`Crash at \`${d.primaryErr.primaryFrame.file}:${d.primaryErr.primaryFrame.line}\`.`]
          : []),
      ],
      causalPath: [
        `${authCall.method} ${authCall.url} → 200 OK`,
        `Expected: response token written to localStorage.${key}`,
        `Actual: localStorage.${key} = null/missing (write never happened or was overwritten)`,
        `Crash: downstream code reads ${key}, receives null`,
      ],
      fixHint: `After \`${authCall.url}\` resolves, call \`localStorage.setItem('${key}', response.token)\` before navigating away.`,
    };
  }

  // ── Detector B: token overwrite / race condition ──────────────────────────
  // Pattern: multiple auth/state calls in quick succession  →  later one wins
  //          with null/empty  →  overwrites the good value  →  crash
  // This is the "competing" hypothesis to Detector A: the token WAS stored, but
  // something wiped it afterwards. We look for 2+ auth calls within 3 s.
  function detectTokenOverwrite(d: DetectorInput): Hypothesis | null {
    if (!d.stateAtError) return null;
    const authCalls = d.correlatedNetwork.filter(
      (n) => /login|auth|signin|token|session/i.test(n.url),
    );
    if (authCalls.length < 2) return null;

    const ls = d.stateAtError.localStorage;
    const AUTH_KEYS = ['token', 'userToken', 'accessToken', 'authToken', 'jwt', 'user', 'session'];
    const nullKeys = AUTH_KEYS.filter(
      (k) => k in ls && (ls[k] === 'null' || ls[k] === '' || ls[k] === 'undefined'),
    );
    if (nullKeys.length === 0) return null;

    // Check temporal proximity: did two auth calls happen within 3 s?
    const sorted = [...authCalls].sort((a, b) => (a.msBeforeError ?? 0) - (b.msBeforeError ?? 0));
    const first = sorted[0];
    const last  = sorted[sorted.length - 1];
    const spanMs = Math.abs((first.msBeforeError ?? 0) - (last.msBeforeError ?? 0));
    if (spanMs > 5000) return null; // too far apart, not a race

    const key = nullKeys[0];
    const score = 0.35 + (spanMs < 1000 ? 0.15 : 0.05); // tighter race = more confidence
    const confidence = scoreToConfidence(score);
    if (confidence === 'INSUFFICIENT') return null;

    return {
      tag: 'token_overwrite_race',
      summary: `\`${key}\` may have been overwritten to null by a concurrent auth request — ${authCalls.length} auth calls fired within ${spanMs}ms.`,
      confidence,
      confidenceScore: score,
      evidence: [
        `${authCalls.length} auth-related requests fired within ${spanMs}ms of each other.`,
        `\`localStorage.${key}\` is null at crash time despite at least one 200 response.`,
        `Race window: ${first.isoTs} → ${last.isoTs}.`,
      ],
      causalPath: [
        `Multiple concurrent auth calls: ${authCalls.map((n) => `${n.method} ${n.url}`).join(', ')}`,
        `Later response (or error handler) writes null to localStorage.${key}`,
        `Overwrites the valid token from the earlier successful response`,
        `Crash: code reads ${key}, receives null`,
      ],
      fixHint: `Deduplicate auth calls (abort the earlier request when a new one starts) and avoid writing null to \`${key}\` in error handlers.`,
    };
  }

  // ── Detector C: failed network call → uninitialised state → crash ─────────
  // Pattern: HTTP 4xx/5xx/net-err  →  response data never parsed  →  crash
  function detectFailedRequestCausedCrash(d: DetectorInput): Hypothesis | null {
    const failedCalls = d.correlatedNetwork.filter(
      (n) => n.status >= 400 || n.status === 0 || !!n.error,
    );
    if (failedCalls.length === 0) return null;

    const worst = failedCalls.reduce((a, b) =>
      (a.status === 0 || a.status >= 500) ? a : (b.status === 0 || b.status >= 500) ? b : a,
    );
    const label = worst.status === 0
      ? `network error (${worst.error ?? 'no response'})`
      : `HTTP ${worst.status}`;

    let score = 0.30;
    if (worst.status === 0 || worst.status >= 500) score += 0.15; // 5xx/net errors are more causal
    if (worst.msBeforeError !== null && worst.msBeforeError < 500) score += 0.15; // tight timing
    if (d.primaryErr.primaryFrame) score += 0.10;
    const confidence = scoreToConfidence(score);
    if (confidence === 'INSUFFICIENT') return null;

    return {
      tag: 'failed_request_uninitialised_state',
      summary: `\`${worst.method} ${worst.url}\` failed with ${label} — dependent state was never populated, leading to the crash.`,
      confidence,
      confidenceScore: score,
      evidence: [
        `\`${worst.method} ${worst.url}\` → ${label}${worst.msBeforeError != null ? `, ${worst.msBeforeError}ms before crash` : ''}.`,
        ...(failedCalls.length > 1 ? [`${failedCalls.length - 1} other failing call(s) in the same window.`] : []),
        ...(d.primaryErr.primaryFrame ? [`Crash at \`${d.primaryErr.primaryFrame.file}:${d.primaryErr.primaryFrame.line}\`.`] : []),
      ],
      causalPath: [
        `${worst.method} ${worst.url} → ${label}`,
        `Response data was never parsed/stored`,
        `State variable that depended on the response remained uninitialised (undefined/null)`,
        `Crash: code tried to access a property of the uninitialised value`,
      ],
      fixHint: `Guard the code that reads the response: check \`response.ok\` (or catch the thrown error) and handle the failure case before accessing response data.`,
    };
  }

  // ── Detector D: null/empty localStorage key (no auth context) ────────────
  // Pattern: key exists but is null/empty, no clear network cause
  // Lower-confidence fallback — something didn't get set, but we don't know why.
  function detectNullStorageKey(d: DetectorInput): Hypothesis | null {
    if (!d.stateAtError) return null;
    const ls = d.stateAtError.localStorage;
    const nullKeys = Object.entries(ls)
      .filter(([, v]) => v === 'null' || v === '' || v === 'undefined')
      .map(([k]) => k);
    if (nullKeys.length === 0) return null;

    // Skip if another detector already provides a richer explanation via auth keys
    const AUTH_KEYS = new Set(['token', 'userToken', 'accessToken', 'authToken', 'jwt', 'user', 'session']);
    const nonAuthNullKeys = nullKeys.filter((k) => !AUTH_KEYS.has(k));
    const relevantKeys = nonAuthNullKeys.length > 0 ? nonAuthNullKeys : nullKeys;

    const key = relevantKeys[0];
    let score = 0.25;
    if (d.primaryErr.primaryFrame) score += 0.10;
    const confidence = scoreToConfidence(score);
    if (confidence === 'INSUFFICIENT') return null;

    return {
      tag: 'null_storage_key',
      summary: `\`localStorage.${key}\` was null/empty at crash time — code that reads it received null.`,
      confidence,
      confidenceScore: score,
      evidence: [
        `\`localStorage.${key}\` = null/empty/undefined at crash time.`,
        ...(relevantKeys.length > 1 ? [`Other empty keys: ${relevantKeys.slice(1).map(k => `\`${k}\``).join(', ')}.`] : []),
      ],
      causalPath: [
        `localStorage.${key} was null/empty before the crash`,
        `Unknown cause: key was never set, was cleared, or was set to null explicitly`,
        `Crash: code read ${key} and received null`,
      ],
      fixHint: `Add a null-check before reading \`localStorage.${key}\`, and trace back where this key should be written.`,
    };
  }

  // ── Detector E: warning immediately before error ──────────────────────────
  // Pattern: console.warn fired as a last signal before console.error
  // Very low confidence alone — useful only as a supporting signal.
  function detectWarningBeforeError(d: DetectorInput): Hypothesis | null {
    const warnsBeforeError = d.chain
      .filter((ev) => ev.kind === 'warn' && ev.ts < d.primaryErr.timestamp)
      .slice(-1);
    if (warnsBeforeError.length === 0) return null;

    const w = warnsBeforeError[0];
    const score = 0.25; // Never HIGH on its own; it's supporting context
    const confidence = scoreToConfidence(score);
    if (confidence === 'INSUFFICIENT') return null;

    return {
      tag: 'warning_preceded_error',
      summary: `A warning fired immediately before the crash: "${w.summary}" — this may indicate the code path that led to the error.`,
      confidence,
      confidenceScore: score,
      evidence: [
        `Warning at ${w.isoTs}: "${w.summary}".`,
        `Crash fired ${d.primaryErr.timestamp - w.ts}ms later.`,
      ],
      causalPath: [
        `⚠️ Warning: "${w.summary}"`,
        `Code continued past the warning rather than bailing out`,
        `Crash: the condition the warning flagged caused the error`,
      ],
      fixHint: `Investigate the warning — it may be a guard that should throw instead of warn.`,
    };
  }

  // ── Run all detectors, collect results ────────────────────────────────────
  const hypotheses: Hypothesis[] = [];

  if (errorBlocks.length > 0) {
    const input: DetectorInput = {
      primaryErr: errorBlocks[0],
      stateAtError,
      correlatedNetwork,
      chain,
    };

    for (const detector of [
      detectAuthTokenNotPersisted,
      detectTokenOverwrite,
      detectFailedRequestCausedCrash,
      detectNullStorageKey,
      detectWarningBeforeError,
    ]) {
      try {
        const result = detector(input);
        if (result) hypotheses.push(result);
      } catch (err) {
        logger.warn({ err, detector: detector.name }, 'hypothesis detector threw');
      }
    }

    // Rank by confidenceScore descending; remove dominated hypotheses that
    // share the same causal explanation but score lower.
    hypotheses.sort((a, b) => b.confidenceScore - a.confidenceScore);

    // If the top hypothesis is HIGH confidence auth-related, suppress the
    // generic null-storage detector for the same key to avoid repetition.
    const topTag = hypotheses[0]?.tag;
    if (topTag === 'auth_token_not_persisted' || topTag === 'token_overwrite_race') {
      const idx = hypotheses.findIndex((h) => h.tag === 'null_storage_key');
      if (idx > 0) hypotheses.splice(idx, 1);
    }
  }

  // ── Format the Context Pack string ───────────────────────────────────────────
  // §1 Source · §2 Diagnosis · §3 State · §4 Network · §5 DOM · §6 Timeline · §7 Task
  const partialChain = {
    capturedAt,
    totalEvents,
    errors: errorBlocks,
    chain,
    stateAtError,
    correlatedNetwork,
    hypotheses,
  };
  const contextPack = formatContextPack(partialChain);

  return {
    ...partialChain,
    contextPack,
  };
}

// ── Context Pack formatter ────────────────────────────────────────────────────
//
// Layout — diagnosis-first: interpretation before raw data.
//
//   §1  Source Snippet    — exact crash line in original source + ±5-line window
//   §2  Mergen Diagnosis  — pre-computed hypothesis (moved before raw evidence)
//   §3  Invisible State   — localStorage / sessionStorage at moment of crash
//   §4  Network Pulse     — last 3 API calls with full Req/Res headers + bodies
//   §5  DOM Trace         — focused element, component, current URL
//   §6  Causal Timeline   — all events with delta timestamps
//   §7  Task Prompt       — concise 3-point output contract for the LLM

function formatContextPack(c: Omit<CausalChain, 'contextPack'>): string {
  const lines: string[] = [];
  const primaryErr = c.errors[0] ?? null;

  // ── Shared empty-state renderer ───────────────────────────────────────────
  const emptyState = (msg: string) => `> ℹ️ *${msg}*`;

  // ── Header ────────────────────────────────────────────────────────────────
  lines.push('### 🚨 Mergen Context Pack');
  lines.push(`*Captured ${c.capturedAt} · ${c.totalEvents} events in buffer*`);
  lines.push('');

  // ══════════════════════════════════════════════════════════════════════════
  // TL;DR  ONE-LINE DIAGNOSIS
  //     Lead with the answer. A developer scanning this in Cursor should know
  //     the root cause before reading anything else.
  // ══════════════════════════════════════════════════════════════════════════
  const topHypothesis = c.hypotheses[0] ?? null;
  if (topHypothesis) {
    const confidenceEmoji = topHypothesis.confidence === 'HIGH' ? '🟢' : topHypothesis.confidence === 'MEDIUM' ? '🟡' : '🔴';
    lines.push(`> ${confidenceEmoji} **${topHypothesis.confidence}:** ${topHypothesis.summary}`);
    if (c.hypotheses.length > 1) {
      lines.push(`> ⚠️ *${c.hypotheses.length - 1} competing hypothesis(es) — see §2.*`);
    }
    lines.push('');
  } else if (c.errors.length > 0) {
    lines.push(`> 🔴 **${c.errors[0].message}** — insufficient signal for automatic diagnosis. See §3–§4 below.`);
    lines.push('');
  }

  // ══════════════════════════════════════════════════════════════════════════
  // §1  SOURCE SNIPPET
  // ══════════════════════════════════════════════════════════════════════════
  lines.push('---');
  lines.push('#### 💻 §1 · Source Snippet');
  lines.push('');

  if (!primaryErr) {
    lines.push(emptyState('No console errors detected. Buffer is clean.'));
  } else {
    lines.push(`**Error:** \`${primaryErr.message}\``);
    lines.push(`**When:**  ${primaryErr.isoTs}`);

    if (primaryErr.primaryFrame) {
      const f = primaryErr.primaryFrame;
      lines.push(`**File:**  \`${f.file}:${f.line}:${f.column}\``);
      lines.push(`**In:**    \`${f.fn || '<anonymous>'}\``);

      if (f.snippet) {
        lines.push('');
        lines.push('```typescript');
        lines.push(f.snippet);
        lines.push('```');
      } else {
        lines.push('');
        lines.push('> ⚠️ Source snippet unavailable — sourcemap does not embed `sourceContent`.');
        lines.push('> Enable `inlineSources: true` in your bundler/tsconfig for full snippets.');
      }
    } else {
      lines.push('');
      lines.push('> ⚠️ No sourcemap-resolvable frame. Enable sourcemaps in your bundler.');
      if (primaryErr.resolvedStack) {
        lines.push('');
        lines.push('```');
        lines.push(primaryErr.resolvedStack.slice(0, 1500));
        lines.push('```');
      }
    }

    // Additional errors — collapsed
    if (c.errors.length > 1) {
      lines.push('');
      lines.push(`<details><summary>📋 +${c.errors.length - 1} more error(s)</summary>`);
      lines.push('');
      for (const err of c.errors.slice(1)) {
        lines.push(`- \`[${err.isoTs}]\` **${err.message}**`);
        if (err.primaryFrame) {
          const f = err.primaryFrame;
          lines.push(`  ↳ \`${f.file}:${f.line}\` in \`${f.fn || '<anonymous>'}\``);
        }
      }
      lines.push('</details>');
    }

    // Full resolved stack — collapsed
    if (primaryErr.resolvedStack) {
      lines.push('');
      lines.push('<details><summary>📋 Full resolved stack trace</summary>');
      lines.push('');
      lines.push('```');
      lines.push(primaryErr.resolvedStack.slice(0, 3000));
      lines.push('```');
      lines.push('</details>');
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // §2  MERGEN DIAGNOSIS  ← moved before raw evidence
  //     All hypotheses that met the minimum threshold, ranked by confidence.
  //     Top hypothesis is visually dominant. Fix hint is the last thing read.
  //     Multiple hypotheses shown explicitly — the LLM must adjudicate.
  // ══════════════════════════════════════════════════════════════════════════
  lines.push('');
  lines.push('---');
  lines.push('#### 🔬 §2 · Mergen Diagnosis');
  lines.push('');

  if (c.hypotheses.length === 0) {
    if (c.errors.length > 0) {
      lines.push('> 🔴 **INSUFFICIENT DATA** — no detector reached the minimum confidence threshold.');
      lines.push('> The system will not guess. Investigate §3 (storage) and §4 (network) manually.');
    } else {
      lines.push(emptyState('No errors detected — nothing to diagnose.'));
    }
  } else {
    if (c.hypotheses.length > 1) {
      lines.push(`> ⚠️ **${c.hypotheses.length} competing hypotheses** — heuristic scores, not learned weights. The system may be wrong.`);
      lines.push('');
    }

    for (let hi = 0; hi < c.hypotheses.length; hi++) {
      const h = c.hypotheses[hi];
      const confidenceEmoji = h.confidence === 'HIGH' ? '🟢' : h.confidence === 'MEDIUM' ? '🟡' : '🔴';
      const isTop = hi === 0;

      // Top hypothesis gets a visual separator to dominate the section
      if (isTop && c.hypotheses.length > 1) {
        lines.push(`**#1 — Primary hypothesis**`);
        lines.push('');
      } else if (hi > 0) {
        lines.push(`**#${hi + 1} — Alternative hypothesis**`);
        lines.push('');
      }

      // Confidence label without score percentage — qualitative only
      lines.push(`${confidenceEmoji} **${h.confidence}** · \`${h.tag}\``);
      lines.push('');
      lines.push(`> ${h.summary}`);
      lines.push('');

      if (h.causalPath.length > 0) {
        lines.push('**Causal path:**');
        lines.push('');
        for (let si = 0; si < h.causalPath.length; si++) {
          lines.push(`${si + 1}. ${h.causalPath[si]}`);
        }
      }

      if (h.evidence.length > 0) {
        lines.push('');
        lines.push('**Supporting evidence:**');
        lines.push('');
        for (const ev of h.evidence) lines.push(`- ${ev}`);
      }

      // Fix hint last — most actionable item, final word on each hypothesis
      if (h.fixHint) {
        lines.push('');
        lines.push('---');
        lines.push(`> 💡 **Fix:** ${h.fixHint}`);
      }

      if (hi < c.hypotheses.length - 1) {
        lines.push('');
        lines.push('');
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // §3  INVISIBLE STATE
  //     localStorage + sessionStorage at moment of crash.
  // ══════════════════════════════════════════════════════════════════════════
  lines.push('');
  lines.push('---');
  lines.push('#### 📦 §3 · Invisible State');
  lines.push('');
  lines.push('*Storage snapshot at moment of crash. Keys flagged ⚠️ are null/empty — common root cause.*');
  lines.push('');

  if (c.stateAtError) {
    const s = c.stateAtError;
    const lsEntries = Object.entries(s.localStorage);
    const ssEntries = Object.entries(s.sessionStorage);

    if (lsEntries.length > 0) {
      lines.push('**localStorage**');
      lines.push('');
      for (const [k, v] of lsEntries) {
        const isEmpty = v === 'null' || v === '' || v === 'undefined';
        const flag = isEmpty ? '  ⚠️ *NULL/EMPTY*' : '';
        lines.push(`- \`localStorage.${k}\`: \`${truncate(v, 100)}\`${flag}`);
      }
    } else {
      lines.push(emptyState('localStorage was empty at crash time — no keys were set.'));
    }

    if (ssEntries.length > 0) {
      lines.push('');
      lines.push('**sessionStorage**');
      lines.push('');
      for (const [k, v] of ssEntries) {
        const isEmpty = v === 'null' || v === '' || v === 'undefined';
        const flag = isEmpty ? '  ⚠️ *NULL/EMPTY*' : '';
        lines.push(`- \`sessionStorage.${k}\`: \`${truncate(v, 100)}\`${flag}`);
      }
    }
  } else {
    lines.push(emptyState('No storage snapshot captured. Snapshots are taken automatically on `console.error` by the browser extension.'));
  }

  // ══════════════════════════════════════════════════════════════════════════
  // §4  NETWORK PULSE
  //     Last 3 API calls (failed first), full Req/Res headers + bodies.
  // ══════════════════════════════════════════════════════════════════════════
  lines.push('');
  lines.push('---');
  lines.push('#### 🌐 §4 · Network Pulse');
  lines.push('');
  lines.push('*Failed calls first, then most-recent successful. Up to 3 shown.*');

  // Show up to 3, failed first, then most-recent successful
  const netFails = c.correlatedNetwork.filter((n) => n.status >= 400 || n.status === 0 || n.error);
  const netOk    = c.correlatedNetwork.filter((n) => n.status > 0 && n.status < 400 && !n.error);
  const pulse    = [...netFails, ...netOk].slice(0, 3);

  if (pulse.length === 0) {
    lines.push('');
    lines.push(emptyState('No network calls intercepted in the 30-second window before crash.'));
  } else {
    for (const n of pulse) {
      const isFail = n.status >= 400 || n.status === 0 || !!n.error;
      const badge  = isFail ? '❌' : '✅';
      lines.push('');
      lines.push(`${badge} **${n.method} \`${n.url}\`** → \`${n.status || 'NET_ERR'} ${n.statusText}\``);
      lines.push(`*${n.isoTs} · ${n.durationMs}ms${n.msBeforeError !== null ? ` · ${n.msBeforeError}ms before crash` : ''}*`);

      // Request headers
      const reqHeaders = Object.entries(n.requestHeaders);
      if (reqHeaders.length > 0) {
        lines.push('- **Request headers:**');
        for (const [k, v] of reqHeaders) {
          const display = /authorization|cookie|x-api-key/i.test(k)
            ? redactHeader(v)
            : truncate(v, 120);
          lines.push(`  - \`${k}: ${display}\``);
        }
      }

      // Request body
      if (n.requestBody !== undefined && n.requestBody !== null) {
        lines.push('- **Request body:**');
        lines.push('  ```json');
        lines.push('  ' + truncate(n.requestBody, 500).replace(/\n/g, '\n  '));
        lines.push('  ```');
      }

      // Response headers
      const resHeaders = Object.entries(n.responseHeaders);
      if (resHeaders.length > 0) {
        lines.push('- **Response headers:**');
        for (const [k, v] of resHeaders) {
          lines.push(`  - \`${k}: ${truncate(v, 120)}\``);
        }
      }

      // Response body
      if (n.responseBody !== undefined && n.responseBody !== null) {
        lines.push('- **Response body:**');
        lines.push('  ```json');
        lines.push('  ' + truncate(n.responseBody, 500).replace(/\n/g, '\n  '));
        lines.push('  ```');
      }

      if (n.error) lines.push(`- **Network error:** \`${n.error}\``);
    }

    if (c.correlatedNetwork.length > 3) {
      lines.push('');
      lines.push(`<details><summary>📋 +${c.correlatedNetwork.length - 3} more call(s) in window</summary>`);
      lines.push('');
      for (const n of c.correlatedNetwork.slice(3)) {
        const badge = (n.status >= 400 || n.status === 0) ? '❌' : '✅';
        lines.push(`- ${badge} \`[${n.isoTs.split(' ')[1]}]\` ${n.method} \`${n.url}\` → \`${n.status}\` (${n.durationMs}ms)`);
      }
      lines.push('</details>');
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // §5  DOM TRACE
  // ══════════════════════════════════════════════════════════════════════════
  lines.push('');
  lines.push('---');
  lines.push('#### 🖱️ §5 · DOM Trace');
  lines.push('');
  lines.push('*What the user was doing at the moment of crash.*');
  lines.push('');

  if (c.stateAtError) {
    const s = c.stateAtError;
    lines.push(`- **URL:**              \`${s.url}\``);
    lines.push(`- **Page title:**       ${s.pageTitle}`);
    if (s.focusedElement) lines.push(`- **Focused element:** \`${s.focusedElement}\``);
    if (s.component)      lines.push(`- **Active component:** \`<${s.component}>\``);
    lines.push(`- **Snapshot time:**   ${s.isoTs}`);
  } else {
    lines.push(emptyState('No DOM snapshot available.'));
  }

  // ══════════════════════════════════════════════════════════════════════════
  // §6  CAUSAL TIMELINE
  //     Delta timestamps (+Xms from previous event) reduce noise.
  //     Absolute timestamp shown only for the crash event.
  // ══════════════════════════════════════════════════════════════════════════
  lines.push('');
  lines.push('---');
  lines.push('#### ⏱️ §6 · Causal Timeline');
  lines.push('');
  lines.push('*Delta from previous event shown. Crash timestamp is absolute.*');
  lines.push('');

  if (c.chain.length === 0) {
    lines.push(emptyState('No events recorded.'));
  } else {
    const ICON: Record<CausalEvent['kind'], string> = {
      nav: '🌐', network_ok: '✅', network_fail: '❌', warn: '⚠️', error: '�', state: '📸',
    };
    let prevTs: number | null = null;
    for (let i = 0; i < c.chain.length; i++) {
      const ev   = c.chain[i];
      const icon = ICON[ev.kind] ?? '•';

      // Errors show absolute time; everything else shows delta from previous event
      let timeLabel: string;
      if (ev.kind === 'error') {
        timeLabel = ev.isoTs.split(' ')[1] ?? ev.isoTs;
      } else if (prevTs !== null) {
        const deltaMs = ev.ts - prevTs;
        timeLabel = `+${deltaMs}ms`;
      } else {
        timeLabel = ev.isoTs.split(' ')[1] ?? ev.isoTs;
      }
      prevTs = ev.ts;

      const row = ev.kind === 'error'
        ? `${i + 1}. \`${timeLabel}\` ${icon} **${ev.summary}**`
        : `${i + 1}. \`${timeLabel}\` ${icon} ${ev.summary}`;
      lines.push(row);
      if (ev.detail) lines.push(`   ↳ *${ev.detail}*`);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // §7  TASK PROMPT  — concise 3-point contract
  // ══════════════════════════════════════════════════════════════════════════
  lines.push('');
  lines.push('---');
  lines.push('#### 🎯 §7 · Your Task');
  lines.push('');
  lines.push('1. **Root cause** — one sentence: what broke and exactly why.');
  lines.push('2. **Fix** — minimal before/after diff. Prioritise §3 (storage) and §4 (network) as the cause of §1 (the crash).');
  lines.push('3. **Confidence** — `HIGH` / `MEDIUM` / `LOW` and what signal is missing.');
  lines.push('');
  lines.push('> Diagnose. Do not summarise. Be brief.');

  // ── Explicit machine-readable output contract for experiment automation ──
  lines.push('');
  lines.push('---');
  lines.push('#### 🧭 §8 · LLM OUTPUT CONTRACT (MUST-FOLLOW)');
  lines.push('');
  lines.push('Respond with a single JSON object only (no surrounding prose). The object MUST have these fields:');
  lines.push('- `root_cause` (string): one-sentence diagnosis describing what broke and why.');
  lines.push('- `fix` (string): a minimal, actionable fix or code change suggestion.');
  lines.push('- `confidence` (string): one of `HIGH`, `MEDIUM`, or `LOW`.');
  lines.push('- `missing_signals` (string|null): what additional telemetry would make this diagnosis HIGH confidence, or null if none.');
  lines.push('');
  lines.push('Example reply (single-line JSON):');
  lines.push('`{"root_cause":"Auth token not persisted after login","fix":"Call localStorage.setItem(\"token\", resp.token) before navigation","confidence":"HIGH","missing_signals":null}`');

  return lines.join('\n');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Partially redact sensitive header values (keep type visible, hide secret). */
function redactHeader(value: string): string {
  if (value.length <= 12) return '***';
  const type = value.split(' ')[0]; // e.g. "Bearer", "Basic"
  if (type && value.includes(' ')) {
    return `${type} ${'*'.repeat(8)}…${value.slice(-4)}`;
  }
  return `${'*'.repeat(8)}…${value.slice(-4)}`;
}

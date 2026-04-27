/**
 * detectors.ts — Hypothesis detectors for the causal engine.
 *
 * Each detector fires independently on the same telemetry and returns
 * a Hypothesis if it sees its pattern, or null if it doesn't.
 */

import { AUTH_KEYS, AUTH_URL_RE } from './buffer.js';
import type {
  ErrorBlock,
  StateBlock,
  CorrelatedNetworkCall,
  CausalEvent,
  Hypothesis,
  ConfidenceLevel,
} from './causal.js';

/** Minimum score a hypothesis must reach to be included in output. */
export const MIN_HYPOTHESIS_SCORE = 0.25;

export interface DetectorInput {
  /** The primary error block, if there is one. Baseline runs (pageload,
   *  periodic, burst) pass `null` here — only detectors that explicitly
   *  handle the no-error case (e.g. detectSlowApiSilent) should fire. */
  primaryErr: ErrorBlock | null;
  stateAtError: StateBlock | null;
  correlatedNetwork: CorrelatedNetworkCall[];
  chain: CausalEvent[];
}

export function scoreToConfidence(score: number): ConfidenceLevel {
  if (score >= 0.65) return 'HIGH';
  if (score >= 0.40) return 'MEDIUM';
  if (score >= MIN_HYPOTHESIS_SCORE) return 'LOW';
  return 'INSUFFICIENT';
}

// ── Detector A: auth token not persisted after successful login ─────────────
export function detectAuthTokenNotPersisted(d: DetectorInput): Hypothesis | null {
  if (!d.primaryErr) return null;
  if (!d.stateAtError) return null;
  const authCalls = d.correlatedNetwork.filter(
    (n) => AUTH_URL_RE.test(n.url) && n.status === 200,
  );
  if (authCalls.length === 0) return null;

  const ls = d.stateAtError.localStorage;
  const missingKeys = AUTH_KEYS.filter(
    (k) => !(k in ls) || ls[k] === 'null' || ls[k] === '' || ls[k] === 'undefined',
  );
  if (missingKeys.length === 0) return null;

  const authCall = authCalls[authCalls.length - 1];
  const key = missingKeys[0];
  let score = 0.55;
  if (d.primaryErr.primaryFrame) score += 0.15;
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

// ── Detector B: token overwrite / race condition ────────────────────────────
export function detectTokenOverwrite(d: DetectorInput): Hypothesis | null {
  if (!d.primaryErr) return null;
  if (!d.stateAtError) return null;
  const authCalls = d.correlatedNetwork.filter(
    (n) => AUTH_URL_RE.test(n.url),
  );
  if (authCalls.length < 2) return null;

  const ls = d.stateAtError.localStorage;
  const nullKeys = AUTH_KEYS.filter(
    (k) => k in ls && (ls[k] === 'null' || ls[k] === '' || ls[k] === 'undefined'),
  );
  if (nullKeys.length === 0) return null;

  const sorted = [...authCalls].sort((a, b) => (a.msBeforeError ?? 0) - (b.msBeforeError ?? 0));
  const first = sorted[0];
  const last  = sorted[sorted.length - 1];
  const spanMs = Math.abs((first.msBeforeError ?? 0) - (last.msBeforeError ?? 0));
  if (spanMs > 5000) return null;

  const key = nullKeys[0];
  const score = 0.35 + (spanMs < 1000 ? 0.15 : 0.05);
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

// ── Detector C: failed network call -> uninitialised state -> crash ──────────
export function detectFailedRequestCausedCrash(d: DetectorInput): Hypothesis | null {
  if (!d.primaryErr) return null;
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
  if (worst.status === 0 || worst.status >= 500) score += 0.15;
  if (worst.msBeforeError !== null && worst.msBeforeError < 500) score += 0.15;
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

// ── Detector D: null/empty localStorage key (no auth context) ───────────────
export function detectNullStorageKey(d: DetectorInput): Hypothesis | null {
  if (!d.primaryErr) return null;
  if (!d.stateAtError) return null;
  const ls = d.stateAtError.localStorage;
  const nullKeys = Object.entries(ls)
    .filter(([, v]) => v === 'null' || v === '' || v === 'undefined')
    .map(([k]) => k);
  if (nullKeys.length === 0) return null;

  const authKeySet = new Set(AUTH_KEYS);
  const nonAuthNullKeys = nullKeys.filter((k) => !authKeySet.has(k));
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

// ── Detector E: warning immediately before error ────────────────────────────
export function detectWarningBeforeError(d: DetectorInput): Hypothesis | null {
  if (!d.primaryErr) return null;
  const primaryErr = d.primaryErr;
  const warnsBeforeError = d.chain
    .filter((ev) => ev.kind === 'warn' && ev.ts < primaryErr.timestamp)
    .slice(-1);
  if (warnsBeforeError.length === 0) return null;

  const w = warnsBeforeError[0];
  const score = 0.25;
  const confidence = scoreToConfidence(score);
  if (confidence === 'INSUFFICIENT') return null;

  return {
    tag: 'warning_preceded_error',
    summary: `A warning fired immediately before the crash: "${w.summary}" — this may indicate the code path that led to the error.`,
    confidence,
    confidenceScore: score,
    evidence: [
      `Warning at ${w.isoTs}: "${w.summary}".`,
      `Crash fired ${primaryErr.timestamp - w.ts}ms later.`,
    ],
    causalPath: [
      `Warning: "${w.summary}"`,
      `Code continued past the warning rather than bailing out`,
      `Crash: the condition the warning flagged caused the error`,
    ],
    fixHint: `Investigate the warning — it may be a guard that should throw instead of warn.`,
  };
}

/** All detectors in execution order. */
export const ALL_DETECTORS = [
  detectAuthTokenNotPersisted,
  detectTokenOverwrite,
  detectFailedRequestCausedCrash,
  detectNullStorageKey,
  detectWarningBeforeError,
  detectSlowApiSilent,
  detectEmptyResponseSilent,
] as const;

// ── Detector F: slow API endpoint (silent failure — no error fired) ─────────
// Fires when one or more 2xx requests took > 500 ms but nothing crashed.
// This is the "I tell you something is wrong before you notice" detector —
// it lets the watcher surface a hypothesis even when the page didn't error.
export function detectSlowApiSilent(d: DetectorInput): Hypothesis | null {
  const slow = d.correlatedNetwork
    .filter((n) => n.status >= 200 && n.status < 400 && n.durationMs > 500)
    .sort((a, b) => b.durationMs - a.durationMs);
  if (slow.length === 0) return null;

  const worst = slow[0];
  // Confidence is intentionally moderate — a slow request is suggestive,
  // not damning. Multiple slow calls bump the score.
  let score = 0.30 + Math.min(0.20, (slow.length - 1) * 0.05);
  if (worst.durationMs > 1500) score += 0.10;
  const confidence = scoreToConfidence(score);
  if (confidence === 'INSUFFICIENT') return null;

  return {
    tag: 'slow_api_silent',
    summary: `\`${worst.method} ${worst.url}\` took ${worst.durationMs}ms — UI may feel stuck even though no error fired.`,
    confidence,
    confidenceScore: score,
    evidence: [
      `${slow.length} slow 2xx request(s) detected (> 500ms).`,
      `Slowest: \`${worst.method} ${worst.url}\` at ${worst.durationMs}ms.`,
    ],
    causalPath: [
      `${worst.method} ${worst.url} succeeded but took ${worst.durationMs}ms`,
      `User-perceived latency exceeds the 500ms "feels-instant" threshold`,
      `Likely cascade: blocking await, sequential fetches, or unindexed query`,
    ],
    fixHint: `Profile \`${worst.url}\` server-side; if it depends on prior fetches, parallelise with \`Promise.all\` or move the work to a streaming endpoint.`,
  };
}

// ── Detector G: empty/null 2xx response (silent failure) ────────────────────
// 2xx responses whose body is null, "", "[]", "{}", or `null` — the API
// "succeeded" but returned no data. Common cause of blank UI with no error.
export function detectEmptyResponseSilent(d: DetectorInput): Hypothesis | null {
  function isEmpty(body: unknown): boolean {
    if (body == null) return true;
    if (typeof body === 'string') {
      const t = body.trim();
      return t === '' || t === 'null' || t === '[]' || t === '{}';
    }
    if (Array.isArray(body)) return body.length === 0;
    if (typeof body === 'object') return Object.keys(body as object).length === 0;
    return false;
  }

  const empties = d.correlatedNetwork.filter(
    (n) => n.status >= 200 && n.status < 300 && isEmpty(n.responseBody),
  );
  if (empties.length === 0) return null;

  const call = empties[empties.length - 1];
  let score = 0.30;
  if (empties.length > 1) score += 0.10;
  // Higher confidence if any error or warning followed within 5s — the empty
  // response is the most likely upstream cause.
  const followed = d.chain.some(
    (ev) => (ev.kind === 'error' || ev.kind === 'warn') && ev.ts > call.msBeforeError!
  );
  if (followed) score += 0.20;
  const confidence = scoreToConfidence(score);
  if (confidence === 'INSUFFICIENT') return null;

  return {
    tag: 'empty_response_silent',
    summary: `\`${call.method} ${call.url}\` returned 2xx but the response body was empty — UI rendering depends on data that doesn't exist.`,
    confidence,
    confidenceScore: score,
    evidence: [
      `\`${call.method} ${call.url}\` → ${call.status} ${call.statusText} with empty body.`,
      ...(empties.length > 1 ? [`${empties.length - 1} other empty 2xx response(s) in window.`] : []),
      ...(followed ? [`A warning or error fired *after* this response — likely the symptom.`] : []),
    ],
    causalPath: [
      `${call.method} ${call.url} → ${call.status} (empty body)`,
      `Component renders against an empty array / null object`,
      `User sees blank UI; no JS error is thrown so DevTools is silent`,
    ],
    fixHint: `Add an empty-state branch to the component consuming \`${call.url}\`; on the server, verify the query returns rows and the serializer isn't dropping them.`,
  };
}

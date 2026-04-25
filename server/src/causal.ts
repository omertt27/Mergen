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

export interface CausalChain {
  capturedAt: string;
  totalEvents: number;
  errors: ErrorBlock[];
  chain: CausalEvent[];           // chronological, all event types
  stateAtError: StateBlock | null;
  correlatedNetwork: CorrelatedNetworkCall[];
  hypothesis: string | null;      // pre-computed hypothesis string for the LLM
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

  // ── Hypothesis generation ────────────────────────────────────────────────────
  // We pre-compute a hypothesis hint so the LLM starts from structured signal
  // rather than blank-slate reasoning.
  let hypothesis: string | null = null;

  if (errorBlocks.length > 0) {
    const primaryErr = errorBlocks[0];
    const parts: string[] = [];

    // Frame-level signal
    if (primaryErr.primaryFrame) {
      const f = primaryErr.primaryFrame;
      parts.push(`The crash originated at ${f.file}:${f.line} in ${f.fn || '<anonymous>'}.`);
    }

    // State signal — look for null / undefined tokens / auth state
    if (stateAtError) {
      const ls = stateAtError.localStorage;
      const nullKeys = Object.entries(ls)
        .filter(([, v]) => v === 'null' || v === '' || v === 'undefined')
        .map(([k]) => k);

      if (nullKeys.length > 0) {
        parts.push(`At error time, localStorage.${nullKeys.join(', ')} was null/empty.`);
      }

      const missingAuthKeys = ['token', 'userToken', 'accessToken', 'authToken', 'user']
        .filter((k) => !(k in ls));
      if (missingAuthKeys.length > 0 && correlatedNetwork.some((n) => /login|auth|signin/i.test(n.url) && n.status === 200)) {
        parts.push(`A successful auth network call was made but ${missingAuthKeys.join('/')} is absent from localStorage — the token may not have been persisted.`);
      }
    }

    // Network correlation signal
    const failedCalls = correlatedNetwork.filter((n) => n.status >= 400 || n.status === 0);
    if (failedCalls.length > 0) {
      const f = failedCalls[0];
      parts.push(`The most recent failing network call was ${f.method} ${f.url} → ${f.status} (${f.msBeforeError}ms before the error).`);
    }

    hypothesis = parts.length > 0 ? parts.join(' ') : null;
  }

  // ── Format the Context Pack string ───────────────────────────────────────────
  const partialChain = {
    capturedAt,
    totalEvents,
    errors: errorBlocks,
    chain,
    stateAtError,
    correlatedNetwork,
    hypothesis,
  };
  const contextPack = formatContextPack(partialChain);

  return {
    ...partialChain,
    contextPack,
  };
}

// ── Context Pack formatter ────────────────────────────────────────────────────
//
// Layout (mirrors the mental model of a developer investigating a crash):
//
//   §1  Source Snippet    — exact crash line in original source + ±5-line window
//   §2  Invisible State   — localStorage / sessionStorage at moment of crash
//   §3  Network Pulse     — last 3 API calls with full Req/Res headers + bodies
//   §4  DOM Trace         — focused element, component, current URL
//   §5  Mergen Diagnosis  — pre-computed hypothesis
//   §6  Causal Timeline   — all events in chronological order
//   §7  Task Prompt       — explicit 4-point output contract for the LLM

function formatContextPack(c: Omit<CausalChain, 'contextPack'>): string {
  const lines: string[] = [];
  const primaryErr = c.errors[0] ?? null;

  // ── Header ────────────────────────────────────────────────────────────────
  lines.push('### 🚨 Mergen Context Pack');
  lines.push(`*Captured ${c.capturedAt} · ${c.totalEvents} events in buffer*`);
  lines.push('');

  // ══════════════════════════════════════════════════════════════════════════
  // §1  SOURCE SNIPPET
  //     The broken line in original source, ±5 lines, ▶ pointer, [ROOT CAUSE]
  //     annotation. First thing Claude sees = first thing a developer looks at.
  // ══════════════════════════════════════════════════════════════════════════
  lines.push('---');
  lines.push('#### 💻 §1 · Source Snippet');
  lines.push('');

  if (!primaryErr) {
    lines.push('✅ No console errors detected. Buffer is clean.');
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
      lines.push(`<details><summary>+${c.errors.length - 1} more error(s)</summary>`);
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
      lines.push('<details><summary>Full resolved stack trace</summary>');
      lines.push('');
      lines.push('```');
      lines.push(primaryErr.resolvedStack.slice(0, 3000));
      lines.push('```');
      lines.push('</details>');
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // §2  INVISIBLE STATE
  //     localStorage + sessionStorage at moment of crash.
  //     Keys that are null/empty/undefined are flagged — these are often the
  //     root cause the code above is missing (token not persisted, etc.).
  // ══════════════════════════════════════════════════════════════════════════
  lines.push('');
  lines.push('---');
  lines.push('#### 📦 §2 · Invisible State  *(storage at moment of crash)*');
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
      lines.push('- **localStorage:** *(empty — no keys were set at crash time)*');
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
    lines.push('*No storage snapshot captured.*');
    lines.push('Snapshots are taken automatically on `console.error` by the browser extension.');
  }

  // ══════════════════════════════════════════════════════════════════════════
  // §3  NETWORK PULSE
  //     Last 3 API calls (most recent first), with full request + response
  //     headers and bodies. Identifies auth failures, expired tokens, 5xx
  //     errors that the UI thought had succeeded.
  // ══════════════════════════════════════════════════════════════════════════
  lines.push('');
  lines.push('---');
  lines.push('#### 🌐 §3 · Network Pulse  *(last 3 API calls before crash)*');

  // Show up to 3, failed first, then most-recent successful
  const netFails = c.correlatedNetwork.filter((n) => n.status >= 400 || n.status === 0 || n.error);
  const netOk    = c.correlatedNetwork.filter((n) => n.status > 0 && n.status < 400 && !n.error);
  const pulse    = [...netFails, ...netOk].slice(0, 3);

  if (pulse.length === 0) {
    lines.push('');
    lines.push('*No network calls intercepted in the 30-second window before crash.*');
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
          // Redact credentials partially
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

      // Response headers (most diagnostic ones first)
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
      lines.push(`<details><summary>+${c.correlatedNetwork.length - 3} more call(s) in window</summary>`);
      lines.push('');
      for (const n of c.correlatedNetwork.slice(3)) {
        const badge = (n.status >= 400 || n.status === 0) ? '❌' : '✅';
        lines.push(`- ${badge} \`[${n.isoTs.split(' ')[1]}]\` ${n.method} \`${n.url}\` → \`${n.status}\` (${n.durationMs}ms)`);
      }
      lines.push('</details>');
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // §4  DOM TRACE
  //     The focused element (what the user was clicking), the active React/Vue
  //     component, and the current URL path. Answers "what was the user doing?"
  // ══════════════════════════════════════════════════════════════════════════
  lines.push('');
  lines.push('---');
  lines.push('#### 🖱️ §4 · DOM Trace  *(user context at crash)*');
  lines.push('');

  if (c.stateAtError) {
    const s = c.stateAtError;
    lines.push(`- **URL:**              \`${s.url}\``);
    lines.push(`- **Page title:**       ${s.pageTitle}`);
    if (s.focusedElement) lines.push(`- **Focused element:** \`${s.focusedElement}\``);
    if (s.component)      lines.push(`- **Active component:** \`<${s.component}>\``);
    lines.push(`- **Snapshot time:**   ${s.isoTs}`);
  } else {
    lines.push('*No DOM snapshot available.*');
  }

  // ══════════════════════════════════════════════════════════════════════════
  // §5  MERGEN DIAGNOSIS
  //     Pre-computed hypothesis from correlated signals. Gives Claude a
  //     structured starting theory so it diagnoses rather than explores.
  // ══════════════════════════════════════════════════════════════════════════
  lines.push('');
  lines.push('---');
  lines.push('#### 🔬 §5 · Mergen Diagnosis  *(pre-computed signal)*');
  lines.push('');

  if (c.hypothesis) {
    lines.push('> *Machine-generated — use as a starting point, not a conclusion.*');
    lines.push('>');
    for (const sentence of c.hypothesis.split('. ').filter(Boolean)) {
      lines.push(`> ${sentence.endsWith('.') ? sentence : sentence + '.'}`);
    }
  } else if (c.errors.length > 0) {
    lines.push('> No enriched hypothesis could be computed — insufficient correlated signals.');
  } else {
    lines.push('> ✅ No errors detected.');
  }

  // ══════════════════════════════════════════════════════════════════════════
  // §6  CAUSAL TIMELINE
  //     All events chronological. Crash line is bolded — everything before is
  //     cause, everything after is consequence.
  // ══════════════════════════════════════════════════════════════════════════
  lines.push('');
  lines.push('---');
  lines.push('#### ⏱️ §6 · Causal Timeline  *(chronological)*');
  lines.push('');

  if (c.chain.length === 0) {
    lines.push('*No events recorded.*');
  } else {
    const ICON: Record<CausalEvent['kind'], string> = {
      nav: '🌐', network_ok: '✅', network_fail: '❌', warn: '⚠️', error: '💥', state: '📸',
    };
    for (let i = 0; i < c.chain.length; i++) {
      const ev   = c.chain[i];
      const icon = ICON[ev.kind] ?? '•';
      const time = ev.isoTs.split(' ')[1] ?? ev.isoTs;
      const row  = ev.kind === 'error'
        ? `${i + 1}. \`${time}\` ${icon} **${ev.summary}**`
        : `${i + 1}. \`${time}\` ${icon} ${ev.summary}`;
      lines.push(row);
      if (ev.detail) lines.push(`   ↳ *${ev.detail}*`);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // §7  TASK PROMPT
  // ══════════════════════════════════════════════════════════════════════════
  lines.push('');
  lines.push('---');
  lines.push('#### 🎯 §7 · Your Task');
  lines.push('');
  lines.push('Using **only** the evidence above, provide:');
  lines.push('');
  lines.push('1. **Root cause** — one sentence: *what* broke and *exactly why*.');
  lines.push('2. **Causal path** — trace the chain step by step: which event caused which consequence.');
  lines.push('3. **Fix** — the minimal code change. Show a before/after diff.');
  lines.push('4. **Confidence** — `HIGH` / `MEDIUM` / `LOW` and what evidence is missing.');
  lines.push('');
  lines.push('> **Prioritise §2 (storage) and §3 (network) when diagnosing why §1 (the code) failed.**');
  lines.push('> Do **not** summarise the data above — diagnose it. Be precise. Be brief.');

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

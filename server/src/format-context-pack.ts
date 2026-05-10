/**
 * format-context-pack.ts — Renders a CausalChain into the structured
 * "Context Pack" string consumed by LLMs.
 *
 * Layout — diagnosis-first: interpretation before raw data.
 *   S1  Source Snippet   S2  Mergen Diagnosis   S3  Invisible State
 *   S4  Network Pulse    S5  DOM Trace          S6  Causal Timeline
 *   S7  Task Prompt      S8  LLM Output Contract
 */

import type { CausalChain, CausalEvent } from './causal.js';

function truncate(value: unknown, maxLen = 300): string {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return s.length > maxLen ? s.slice(0, maxLen) + ' …' : s;
}

/** Partially redact sensitive header values (keep type visible, hide secret). */
function redactHeader(value: string): string {
  if (value.length <= 12) return '***';
  const type = value.split(' ')[0];
  if (type && value.includes(' ')) {
    return `${type} ${'*'.repeat(8)}…${value.slice(-4)}`;
  }
  return `${'*'.repeat(8)}…${value.slice(-4)}`;
}

export function formatContextPack(c: Omit<CausalChain, 'contextPack'>): string {
  const lines: string[] = [];
  const primaryErr = c.errors[0] ?? null;

  const emptyState = (msg: string) => `> *${msg}*`;

  // ── Header
  lines.push('### Mergen Context Pack');
  lines.push(`*Captured ${c.capturedAt} · ${c.totalEvents} events in buffer*`);
  lines.push('');

  // ── TL;DR
  const topHypothesis = c.hypotheses[0] ?? null;
  if (topHypothesis) {
    const confidenceEmoji = topHypothesis.confidence === 'HIGH' ? '🟢' : topHypothesis.confidence === 'MEDIUM' ? '🟡' : '🔴';
    lines.push(`> ${confidenceEmoji} **${topHypothesis.confidence}:** ${topHypothesis.summary}`);
    if (c.hypotheses.length > 1) {
      lines.push(`> *${c.hypotheses.length - 1} competing hypothesis(es) — see S2.*`);
    }
    lines.push('');
  } else if (c.errors.length > 0) {
    lines.push(`> 🔴 **${c.errors[0].message}** — insufficient signal for automatic diagnosis. See S3-S4 below.`);
    lines.push('');
  }

  // ── S1 SOURCE SNIPPET
  lines.push('---');
  lines.push('#### S1 · Source Snippet');
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
        lines.push('> Source snippet unavailable — sourcemap does not embed `sourceContent`.');
        lines.push('> Enable `inlineSources: true` in your bundler/tsconfig for full snippets.');
      }
    } else {
      lines.push('');
      lines.push('> No sourcemap-resolvable frame. Enable sourcemaps in your bundler.');
      if (primaryErr.resolvedStack) {
        lines.push('');
        lines.push('```');
        lines.push(primaryErr.resolvedStack.slice(0, 1500));
        lines.push('```');
      }
    }

    if (c.errors.length > 1) {
      lines.push('');
      lines.push(`<details><summary>+${c.errors.length - 1} more error(s)</summary>`);
      lines.push('');
      for (const err of c.errors.slice(1)) {
        lines.push(`- \`[${err.isoTs}]\` **${err.message}**`);
        if (err.primaryFrame) {
          const f = err.primaryFrame;
          lines.push(`  -> \`${f.file}:${f.line}\` in \`${f.fn || '<anonymous>'}\``);
        }
      }
      lines.push('</details>');
    }

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

  // ── S2 MERGEN DIAGNOSIS
  lines.push('');
  lines.push('---');
  lines.push('#### S2 · Mergen Diagnosis');
  lines.push('');

  if (c.hypotheses.length === 0) {
    if (c.errors.length > 0) {
      lines.push('> 🔴 **INSUFFICIENT DATA** — no detector reached the minimum confidence threshold.');
      lines.push('> The system will not guess. Investigate S3 (storage) and S4 (network) manually.');
    } else {
      lines.push(emptyState('No errors detected — nothing to diagnose.'));
    }
  } else {
    if (c.hypotheses.length > 1) {
      lines.push(`> **${c.hypotheses.length} competing hypotheses** — heuristic scores, not learned weights. The system may be wrong.`);
      lines.push('');
    }

    for (let hi = 0; hi < c.hypotheses.length; hi++) {
      const h = c.hypotheses[hi];
      const confidenceEmoji = h.confidence === 'HIGH' ? '🟢' : h.confidence === 'MEDIUM' ? '🟡' : '🔴';
      const isTop = hi === 0;

      if (isTop && c.hypotheses.length > 1) {
        lines.push(`**#1 — Primary hypothesis**`);
        lines.push('');
      } else if (hi > 0) {
        lines.push(`**#${hi + 1} — Alternative hypothesis**`);
        lines.push('');
      }

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

      if (h.fixHint) {
        lines.push('');
        lines.push('---');
        lines.push(`> **Fix:** ${h.fixHint}`);
      }

      if (hi < c.hypotheses.length - 1) {
        lines.push('');
        lines.push('');
      }
    }
  }

  // ── S3 INVISIBLE STATE
  lines.push('');
  lines.push('---');
  lines.push('#### S3 · Invisible State');
  lines.push('');
  lines.push('*Storage snapshot at moment of crash. Keys flagged are null/empty — common root cause.*');
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
        const flag = isEmpty ? '  *NULL/EMPTY*' : '';
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
        const flag = isEmpty ? '  *NULL/EMPTY*' : '';
        lines.push(`- \`sessionStorage.${k}\`: \`${truncate(v, 100)}\`${flag}`);
      }
    }
  } else {
    lines.push(emptyState('No storage snapshot captured. Snapshots are taken automatically on `console.error` by the browser extension.'));
  }

  // ── S4 NETWORK PULSE
  lines.push('');
  lines.push('---');
  lines.push('#### S4 · Network Pulse');
  lines.push('');
  lines.push('*Failed calls first, then most-recent successful. Up to 3 shown.*');

  const netFails = c.correlatedNetwork.filter((n) => n.status >= 400 || n.status === 0 || n.error);
  const netOk    = c.correlatedNetwork.filter((n) => n.status > 0 && n.status < 400 && !n.error);
  const pulse    = [...netFails, ...netOk].slice(0, 3);

  if (pulse.length === 0) {
    lines.push('');
    lines.push(emptyState('No network calls intercepted in the 30-second window before crash.'));
  } else {
    for (const n of pulse) {
      const isFail = n.status >= 400 || n.status === 0 || !!n.error;
      const badge  = isFail ? 'FAIL' : 'OK';
      lines.push('');
      lines.push(`${badge} **${n.method} \`${n.url}\`** -> \`${n.status || 'NET_ERR'} ${n.statusText}\``);
      lines.push(`*${n.isoTs} · ${n.durationMs}ms${n.msBeforeError !== null ? ` · ${n.msBeforeError}ms before crash` : ''}*`);

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

      if (n.requestBody !== undefined && n.requestBody !== null) {
        lines.push('- **Request body:**');
        lines.push('  ```json');
        lines.push('  ' + truncate(n.requestBody, 500).replace(/\n/g, '\n  '));
        lines.push('  ```');
      }

      const resHeaders = Object.entries(n.responseHeaders);
      if (resHeaders.length > 0) {
        lines.push('- **Response headers:**');
        for (const [k, v] of resHeaders) {
          lines.push(`  - \`${k}: ${truncate(v, 120)}\``);
        }
      }

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
        const badge = (n.status >= 400 || n.status === 0) ? 'FAIL' : 'OK';
        lines.push(`- ${badge} \`[${n.isoTs.split(' ')[1]}]\` ${n.method} \`${n.url}\` -> \`${n.status}\` (${n.durationMs}ms)`);
      }
      lines.push('</details>');
    }
  }

  // ── S5 DOM TRACE
  lines.push('');
  lines.push('---');
  lines.push('#### S5 · DOM Trace');
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

  // ── S6 CAUSAL TIMELINE
  lines.push('');
  lines.push('---');
  lines.push('#### S6 · Causal Timeline');
  lines.push('');
  lines.push('*Delta from previous event shown. Crash timestamp is absolute.*');
  lines.push('');

  if (c.chain.length === 0) {
    lines.push(emptyState('No events recorded.'));
  } else {
    const ICON: Record<CausalEvent['kind'], string> = {
      nav: 'NAV', network_ok: 'OK', network_fail: 'FAIL', warn: 'WARN', error: 'ERR', state: 'STATE',
    };
    let prevTs: number | null = null;
    for (let i = 0; i < c.chain.length; i++) {
      const ev   = c.chain[i];
      const icon = ICON[ev.kind] ?? '-';

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
        ? `${i + 1}. \`${timeLabel}\` [${icon}] **${ev.summary}**`
        : `${i + 1}. \`${timeLabel}\` [${icon}] ${ev.summary}`;
      lines.push(row);
      if (ev.detail) lines.push(`   -> *${ev.detail}*`);
    }
  }

  // ── S7 TASK PROMPT
  lines.push('');
  lines.push('---');
  lines.push('#### S7 · Your Task');
  lines.push('');
  lines.push('1. **Root cause** — one sentence: what broke and exactly why.');
  lines.push('2. **Fix** — minimal before/after diff. Prioritise S3 (storage) and S4 (network) as the cause of S1 (the crash).');
  lines.push('3. **Confidence** — `HIGH` / `MEDIUM` / `LOW` and what signal is missing.');
  lines.push('');
  lines.push('> Diagnose. Do not summarise. Be brief.');

  // ── S8 LLM OUTPUT CONTRACT
  lines.push('');
  lines.push('---');
  lines.push('#### S8 · LLM OUTPUT CONTRACT (MUST-FOLLOW)');
  lines.push('');
  lines.push('Respond with a single JSON object only (no surrounding prose). The object MUST have these fields:');
  lines.push('- `root_cause` (string): one-sentence diagnosis describing what broke and why.');
  lines.push('- `fix` (string): a minimal, actionable fix or code change suggestion.');
  lines.push('- `confidence` (string): one of `HIGH`, `MEDIUM`, or `LOW`.');
  lines.push('- `missing_signals` (string|null): what additional telemetry would make this diagnosis HIGH confidence, or null if none.');
  lines.push('');
  lines.push('Example reply (single-line JSON):');
  lines.push('`{"root_cause":"Auth token not persisted after login","fix":"Call localStorage.setItem(\\"token\\", resp.token) before navigation","confidence":"HIGH","missing_signals":null}`');

  return lines.join('\n');
}

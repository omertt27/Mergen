/**
 * causal.ts — Causal chain reconstruction engine (orchestrator).
 *
 * Delegates to:
 *   detectors.ts          — hypothesis detector functions
 *   format-context-pack.ts — Context Pack string renderer
 */

import type { ConsoleEvent, NetworkEvent, ContextSnapshot } from './buffer.js';
import { resolveFrameAndStack } from './sourcemap.js';
import { formatContextPack } from './format-context-pack.js';
import {
  ALL_DETECTORS,
  type DetectorInput,
} from './detectors.js';
import logger from './logger.js';

// ── Types (re-exported so existing imports keep working) ─────────────────────

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
  snippet: string;
  rawResolved: string;
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

export type ConfidenceLevel = 'HIGH' | 'MEDIUM' | 'LOW' | 'INSUFFICIENT';

export interface Hypothesis {
  tag: string;
  summary: string;
  confidence: ConfidenceLevel;
  confidenceScore: number;
  evidence: string[];
  causalPath: string[];
  fixHint: string | null;
}

export interface CausalChain {
  capturedAt: string;
  totalEvents: number;
  errors: ErrorBlock[];
  chain: CausalEvent[];
  stateAtError: StateBlock | null;
  correlatedNetwork: CorrelatedNetworkCall[];
  hypotheses: Hypothesis[];
  contextPack: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const CORRELATION_WINDOW_MS = 30_000;
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
    .split('\n')[0]
    .slice(0, 300);
}

// ── Source resolution ─────────────────────────────────────────────────────────

async function buildErrorBlock(e: ConsoleEvent): Promise<ErrorBlock> {
  const message = errorMessage(e);
  let primaryFrame: SourceFrame | null = null;
  let resolvedStack = '';

  if (e.stack) {
    try {
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

  const errorBlocks: ErrorBlock[] = await Promise.all(errors.map(buildErrorBlock));

  // Find state snapshot closest to (and before) the first error
  const relevantContexts = contexts
    .filter((c) => c.timestamp <= firstErrorTs && c.timestamp >= firstErrorTs - STATE_WINDOW_MS)
    .sort((a, b) => b.timestamp - a.timestamp);

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

  // Correlate network calls within the window before the first error
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
      if (a.msBeforeError === null && b.msBeforeError === null) return 0;
      if (a.msBeforeError === null) return 1;
      if (b.msBeforeError === null) return -1;
      return a.msBeforeError - b.msBeforeError;
    });

  // Build chronological event chain
  const chain: CausalEvent[] = [];

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
      summary: `${errorMessage(e)}`,
    });
  }

  chain.sort((a, b) => a.ts - b.ts);

  // ── Run hypothesis detectors ──────────────────────────────────────────────
  // We always run detectors — even when no error has fired. Error-required
  // detectors return null on baselines; silent-failure detectors (slow API,
  // empty response) fire only on baselines or when an error is also present.
  // This is what makes the watcher loop continuously useful.
  const hypotheses: Hypothesis[] = [];

  const input: DetectorInput = {
    primaryErr: errorBlocks[0] ?? null,
    stateAtError,
    correlatedNetwork,
    chain,
  };

  for (const detector of ALL_DETECTORS) {
    try {
      const result = detector(input);
      if (result) hypotheses.push(result);
    } catch (err) {
      logger.warn({ err, detector: detector.name }, 'hypothesis detector threw');
    }
  }

  hypotheses.sort((a, b) => b.confidenceScore - a.confidenceScore);

  if (errorBlocks.length > 0) {
    const topTag = hypotheses[0]?.tag;
    if (topTag === 'auth_token_not_persisted' || topTag === 'token_overwrite_race') {
      const idx = hypotheses.findIndex((h) => h.tag === 'null_storage_key');
      if (idx > 0) hypotheses.splice(idx, 1);
    }
  }

  // ── Format the Context Pack string ────────────────────────────────────────
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

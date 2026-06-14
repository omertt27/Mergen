/**
 * Open-source stub for the closed-source causal analysis module.
 */

import type { ConsoleEvent, NetworkEvent, ContextSnapshot } from '../sensor/buffer.js';
import { recordPrediction, applyCalibration } from './calibration.js';

export interface Hypothesis {
  tag:                   string;
  summary:               string;
  confidence:            'HIGH' | 'MEDIUM' | 'LOW';
  confidenceScore:       number;
  causalPath:            string[];
  evidence:              string[];
  fixHint:               string | null;
  fixAction?:            string | null;
  remediationConfidence?: number;
  pid?:                  string;
  calibrationAction?:    string;
}

export interface ErrorBlock {
  message:      string;
  stack?:       string;
  primaryFrame: { file: string; line: number; col: number } | null;
  ts:           number;
}

export interface ChainEvent {
  kind:    'error' | 'warn' | 'network_fail' | 'network_ok' | 'state';
  ts:      number;
  message: string;
}

export interface CorrelatedNetwork {
  url:              string;
  method:           string;
  status:           number;
  duration:         number;
  error?:           string | null;
  requestBody?:     unknown;
  responseBody?:    unknown;
  requestHeaders?:  Record<string, string>;
  responseHeaders?: Record<string, string>;
  msBeforeError:    number | null;
  ts:               number;
}

export interface CausalChain {
  hypotheses:        Hypothesis[];
  errors:            ErrorBlock[];
  chain:             ChainEvent[];
  contextPack:       string;
  correlatedNetwork: CorrelatedNetwork[];
  stateAtError:      ContextSnapshot | null;
}

const SENSITIVE_HEADERS = new Set([
  'authorization', 'cookie', 'set-cookie', 'x-auth-token', 'x-api-key',
]);
const NETWORK_WINDOW_MS = 30_000;
const STATE_WINDOW_MS   = 5_000;
const SLOW_THRESHOLD_MS = 1_000;

function parseFrame(stack: string): { file: string; line: number; col: number } | null {
  const m = stack.match(/at\s+\S+\s+\((.+):(\d+):(\d+)\)/);
  return m ? { file: m[1], line: Number(m[2]), col: Number(m[3]) } : null;
}

function redactHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    out[k] = SENSITIVE_HEADERS.has(k.toLowerCase()) ? '[REDACTED]' : v;
  }
  return out;
}

function isEmptyBody(body: unknown): boolean {
  if (body == null) return false;
  if (Array.isArray(body)) return body.length === 0;
  if (typeof body === 'object') return Object.keys(body as Record<string, unknown>).length === 0;
  if (typeof body === 'string') return body === '' || body === '[]' || body === '{}';
  return false;
}

function buildContextPack(
  errors: ErrorBlock[],
  correlated: CorrelatedNetwork[],
  state: ContextSnapshot | null,
): string {
  const lines: string[] = [];

  if (errors.length === 0) {
    lines.push('No console errors');
  } else {
    lines.push('## Console Errors');
    for (const e of errors) lines.push(`- ${e.message}`);
  }

  const failed = correlated.filter((n) => n.status >= 400 || n.status === 0 || n.error);
  if (failed.length > 0) {
    lines.push('\n## Network Failures');
    for (const n of failed) {
      let errPart = '';
      if (n.error) {
        const isNet = n.error.includes('NET_ERR') || n.error.includes('net::');
        errPart = ` (${isNet ? 'NET_ERR: ' + n.error : n.error})`;
      }
      lines.push(`- ${n.method} ${n.url} → ${n.status}${errPart}`);
      if (n.requestBody != null) lines.push(`  Request: ${JSON.stringify(n.requestBody)}`);
      if (n.responseBody != null) {
        const rb = typeof n.responseBody === 'string' ? n.responseBody : JSON.stringify(n.responseBody);
        lines.push(`  Response: ${rb}`);
      }
      if (n.requestHeaders && Object.keys(n.requestHeaders).length > 0) {
        lines.push(`  Request-Headers: ${JSON.stringify(redactHeaders(n.requestHeaders))}`);
      }
      if (n.responseHeaders && Object.keys(n.responseHeaders).length > 0) {
        lines.push(`  Response-Headers: ${JSON.stringify(n.responseHeaders)}`);
      }
    }
  }

  lines.push('\n## Invisible State');
  if (!state) {
    lines.push('No storage snapshot');
  } else {
    const ls = state.localStorage ?? {};
    if (Object.keys(ls).length === 0) {
      lines.push('localStorage: (empty)');
    } else {
      lines.push('localStorage:');
      for (const [k, v] of Object.entries(ls)) {
        const flag = (v === 'null' || v === '') ? ' *NULL/EMPTY*' : '';
        lines.push(`  ${k}: ${v}${flag}`);
      }
    }
  }

  return lines.join('\n');
}

function detectHypotheses(
  errors: ErrorBlock[],
  allNetwork: NetworkEvent[],
  correlated: CorrelatedNetwork[],
  state: ContextSnapshot | null,
): Hypothesis[] {
  const hyps: Hypothesis[] = [];
  const ls = state?.localStorage ?? {};
  const errorText = errors.map((e) => e.message).join(' ').toLowerCase();

  if (errors.length > 0) {
    const hasNullToken = Object.entries(ls).some(
      ([k, v]) => /token|session/i.test(k) && (v === 'null' || v === ''),
    );
    const hasLoginSuccess = correlated.some(
      (n) => /login|auth/i.test(n.url) && n.status >= 200 && n.status < 300,
    );
    if (hasNullToken && hasLoginSuccess && /token|null|read|undefined/i.test(errorText)) {
      hyps.push({
        tag: 'auth_token_not_persisted',
        summary: 'Token not persisted to localStorage after successful login — reads null on next access',
        confidence: 'HIGH',
        confidenceScore: 0.88,
        causalPath: ['login request succeeded', 'token not written to localStorage', 'next read returns null'],
        evidence: ['token: null in localStorage', 'successful login request', errorText.slice(0, 80)],
        fixHint: 'Ensure the token is written to localStorage immediately after the login response.',
        fixAction: null,
        remediationConfidence: 0.7,
      });
    }
  }

  // Silent detectors — fire even without console errors
  for (const n of allNetwork) {
    if (n.status >= 200 && n.status < 300 && n.duration > SLOW_THRESHOLD_MS
        && !hyps.find((h) => h.tag === 'slow_api_silent')) {
      hyps.push({
        tag: 'slow_api_silent',
        summary: `${n.url} took ${n.duration}ms with no error — silent performance regression`,
        confidence: 'MEDIUM',
        confidenceScore: 0.65,
        causalPath: ['slow 2xx', 'no error thrown', 'UI blocked silently'],
        evidence: [`${n.method} ${n.url} duration=${n.duration}ms status=${n.status}`],
        fixHint: 'Check server-side query performance or add a timeout with user feedback.',
        fixAction: null,
        remediationConfidence: 0.5,
      });
    }

    if (n.status >= 200 && n.status < 300 && isEmptyBody(n.responseBody)
        && !hyps.find((h) => h.tag === 'empty_response_silent')) {
      hyps.push({
        tag: 'empty_response_silent',
        summary: `${n.url} returned 200 with empty body — possible silent data loss`,
        confidence: 'MEDIUM',
        confidenceScore: 0.60,
        causalPath: ['200 with empty body', 'component renders nothing', 'blank UI'],
        evidence: [`${n.method} ${n.url} status=200 responseBody=empty`],
        fixHint: 'Verify the API query conditions are not overly restrictive.',
        fixAction: null,
        remediationConfidence: 0.4,
      });
    }
  }

  return hyps;
}

export async function buildCausalChain(
  logs: ConsoleEvent[],
  network: NetworkEvent[],
  contexts: ContextSnapshot[],
  _firedAt?: number,
): Promise<CausalChain> {
  const errors   = logs.filter((e) => e.level === 'error');
  const warnings = logs.filter((e) => e.level === 'warn');
  const firstErrorTs = errors[0]?.timestamp ?? null;

  const errorBlocks: ErrorBlock[] = errors.map((e) => ({
    message:      (e.args?.[0] as string | undefined) ?? '',
    stack:        e.stack,
    primaryFrame: e.stack ? parseFrame(e.stack) : null,
    ts:           e.timestamp,
  }));

  const correlated: CorrelatedNetwork[] = network.map((n) => ({
    url:             n.url,
    method:          n.method,
    status:          n.status,
    duration:        n.duration,
    error:           n.error ?? null,
    requestBody:     n.requestBody,
    responseBody:    n.responseBody,
    requestHeaders:  n.requestHeaders,
    responseHeaders: n.responseHeaders,
    msBeforeError:   firstErrorTs !== null ? firstErrorTs - n.timestamp : null,
    ts:              n.timestamp,
  })).filter((n) => {
    if (firstErrorTs === null) return true;
    const diff = firstErrorTs - n.ts;
    return diff >= 0 && diff <= NETWORK_WINDOW_MS;
  });

  let stateAtError: ContextSnapshot | null = null;
  if (firstErrorTs !== null) {
    const eligible = contexts.filter((c) => {
      const diff = firstErrorTs - c.timestamp;
      return diff >= 0 && diff <= STATE_WINDOW_MS;
    });
    if (eligible.length > 0) {
      stateAtError = eligible.reduce((a, b) => (a.timestamp > b.timestamp ? a : b));
    }
  }

  const chain: ChainEvent[] = [
    ...contexts.map((c): ChainEvent => ({ kind: 'state', ts: c.timestamp, message: `${c.component ?? 'unknown'} state captured` })),
    ...errors.map((e): ChainEvent => ({ kind: 'error', ts: e.timestamp, message: (e.args?.[0] as string) ?? '' })),
    ...warnings.map((w): ChainEvent => ({ kind: 'warn', ts: w.timestamp, message: (w.args?.[0] as string) ?? '' })),
    ...network.map((n): ChainEvent => ({
      kind: (n.status >= 400 || n.status === 0 || !!n.error) ? 'network_fail' : 'network_ok',
      ts: n.timestamp,
      message: `${n.method} ${n.url} → ${n.status}`,
    })),
  ].sort((a, b) => a.ts - b.ts);

  const contextPack = buildContextPack(errorBlocks, correlated, stateAtError);
  const rawHyps = detectHypotheses(errorBlocks, network, correlated, stateAtError);

  const tagged = recordPrediction(rawHyps) as Hypothesis[];
  const { active } = applyCalibration(tagged) as { active: Hypothesis[]; suppressed: Hypothesis[] };

  return { errors: errorBlocks, chain, contextPack, correlatedNetwork: correlated, stateAtError, hypotheses: active };
}

export function fixActionToCommand(_action: string | null): string | null {
  return null;
}

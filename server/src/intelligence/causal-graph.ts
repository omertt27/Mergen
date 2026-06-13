/**
 * causal-graph.ts — Structural representation of the causal chain.
 *
 * Produces a typed graph (nodes + edges) from a CausalChain.
 * No LLM formatting — any consumer can traverse or render this data
 * without relying on natural language summaries.
 *
 * Edge kinds (ordered by determinism):
 *   TRACE_JOINED    — exact W3C traceparent match (confidence: 1.0)
 *   CAUSED_BY       — hypothesis-backed causal link (confidence: hypothesis score)
 *   STATE_AT        — storage/DOM snapshot active when error fired (confidence: 0.9)
 *   CORRELATED_WITH — temporal proximity only, non-deterministic (confidence: 0.3–1.0)
 *   PRECEDED_BY     — chronological sequence, no causal claim (confidence: 1.0)
 */

import { createHash } from 'crypto';
import type { CausalChain, CausalEvent, Hypothesis } from './causal.js';

// ── Node types ─────────────────────────────────────────────────────────────────

export type NodeKind =
  | 'error'
  | 'warn'
  | 'network_fail'
  | 'network_ok'
  | 'state'
  | 'process_log'
  | 'process_exit';

// ── Edge types (ordered from most to least deterministic) ──────────────────────

export type EdgeKind =
  | 'TRACE_JOINED'    // exact W3C traceparent match — deterministic
  | 'CAUSED_BY'       // hypothesis-backed — detector-validated
  | 'STATE_AT'        // storage/DOM was in this state when error fired
  | 'CORRELATED_WITH' // temporal proximity — probabilistic
  | 'PRECEDED_BY';    // chronological only — no causal claim

export interface GraphNode {
  id: string;
  kind: NodeKind;
  ts: number;
  isoTs: string;
  label: string;
  metadata: Record<string, unknown>;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  /** 0.0–1.0. TRACE_JOINED and PRECEDED_BY are always 1.0. */
  confidence: number;
  metadata?: Record<string, unknown>;
}

export interface CausalGraph {
  capturedAt: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Node ids with no incoming causal edges (CAUSED_BY / CORRELATED_WITH / TRACE_JOINED). */
  rootNodes: string[];
  /** Node ids of errors and process exits — the observable failures. */
  terminalNodes: string[];
  hypotheses: Array<Pick<Hypothesis, 'tag' | 'summary' | 'confidence' | 'confidenceScore' | 'causalPath' | 'fixHint' | 'evidence' | 'pid'>>;
  errorFingerprint?: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function stableId(kind: string, ts: number, label: string): string {
  const h = createHash('sha256').update(`${kind}:${ts}:${label}`).digest('hex').slice(0, 8);
  return `${kind}:${ts}:${h}`;
}

function toNodeKind(kind: CausalEvent['kind']): NodeKind {
  switch (kind) {
    case 'error':        return 'error';
    case 'warn':         return 'warn';
    case 'network_fail': return 'network_fail';
    case 'network_ok':   return 'network_ok';
    case 'process_exit': return 'process_exit';
    case 'process_log':  return 'process_log';
    default:             return 'state'; // nav, state
  }
}

// Detector tags whose primary mechanism is a network call causing a crash.
const NETWORK_CAUSE_TAGS = new Set([
  'auth_token_not_persisted',
  'token_overwrite_race',
  'failed_request_caused_crash',
  'null_storage_key',
  'empty_network_response',
]);

// ── Main builder ───────────────────────────────────────────────────────────────

export function buildCausalGraph(chain: Omit<CausalChain, 'contextPack'>): CausalGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  // ── 1. Build nodes from flat timeline ──────────────────────────────────────
  for (const ev of chain.chain) {
    const kind = toNodeKind(ev.kind);
    const id   = stableId(kind, ev.ts, ev.summary);
    const meta: Record<string, unknown> = {};

    if (ev.detail) meta.detail = ev.detail;
    if (ev.source) meta.source = ev.source;

    // Enrich error nodes with resolved stack frame data
    if (kind === 'error') {
      const errBlock = chain.errors.find(e => e.timestamp === ev.ts);
      if (errBlock?.primaryFrame) meta.primaryFrame = errBlock.primaryFrame;
      if (errBlock?.resolvedStack) meta.resolvedStack = errBlock.resolvedStack.slice(0, 600);
    }

    nodes.push({ id, kind, ts: ev.ts, isoTs: ev.isoTs, label: ev.summary.slice(0, 120), metadata: meta });
  }

  if (nodes.length === 0) {
    return { capturedAt: chain.capturedAt, nodes, edges, rootNodes: [], terminalNodes: [], hypotheses: [] };
  }

  // ── 2. Chronological backbone (PRECEDED_BY) ────────────────────────────────
  for (let i = 1; i < nodes.length; i++) {
    edges.push({ from: nodes[i - 1].id, to: nodes[i].id, kind: 'PRECEDED_BY', confidence: 1.0 });
  }

  const errorNodes      = nodes.filter(n => n.kind === 'error');
  const networkFailNodes = nodes.filter(n => n.kind === 'network_fail');
  const stateNodes      = nodes.filter(n => n.kind === 'state');

  // ── 3. CORRELATED_WITH: network failures within 30 s before each error ─────
  for (const err of errorNodes) {
    for (const net of networkFailNodes) {
      const msBefore = err.ts - net.ts;
      if (msBefore < 0 || msBefore > 30_000) continue;
      edges.push({
        from: net.id,
        to: err.id,
        kind: 'CORRELATED_WITH',
        confidence: parseFloat((Math.max(0.3, 1 - msBefore / 30_000)).toFixed(2)),
        metadata: { msBefore },
      });
    }
  }

  // ── 4. TRACE_JOINED: upgrade CORRELATED_WITH when traceId is present ───────
  // correlatedNetwork entries carry traceId; match to network_fail nodes by URL.
  for (const netCall of chain.correlatedNetwork) {
    if (!netCall.traceId) continue;
    const urlSlug = netCall.url.slice(0, 70);
    const matchNode = networkFailNodes.find(n => n.label.includes(urlSlug));
    if (!matchNode) continue;

    for (const err of errorNodes) {
      const edge = edges.find(e => e.from === matchNode.id && e.to === err.id && e.kind === 'CORRELATED_WITH');
      if (edge) {
        edge.kind = 'TRACE_JOINED';
        edge.confidence = 1.0;
        edge.metadata = { ...edge.metadata, traceId: netCall.traceId };
      }
    }
  }

  // ── 5. STATE_AT: storage/DOM snapshot active within 5 s of an error ────────
  for (const err of errorNodes) {
    for (const state of stateNodes) {
      if (Math.abs(err.ts - state.ts) <= 5_000) {
        edges.push({ from: state.id, to: err.id, kind: 'STATE_AT', confidence: 0.9 });
      }
    }
  }

  // ── 6. CAUSED_BY: elevate best CORRELATED_WITH backed by a hypothesis ──────
  for (const h of chain.hypotheses) {
    if (!NETWORK_CAUSE_TAGS.has(h.tag)) continue;
    if (h.confidenceScore < 0.55) continue;

    const best = edges
      .filter(e => e.kind === 'CORRELATED_WITH' && nodes.find(n => n.id === e.from)?.kind === 'network_fail')
      .sort((a, b) => b.confidence - a.confidence)[0];

    if (best) {
      best.kind = 'CAUSED_BY';
      best.confidence = parseFloat(h.confidenceScore.toFixed(2));
      best.metadata = { ...best.metadata, hypothesis: h.tag, fixHint: h.fixHint ?? undefined };
    }
  }

  // ── 7. Compute root / terminal node sets ───────────────────────────────────
  const hasIncomingCausal = new Set(
    edges
      .filter(e => e.kind !== 'PRECEDED_BY')
      .map(e => e.to),
  );
  const rootNodes     = nodes.filter(n => !hasIncomingCausal.has(n.id)).map(n => n.id);
  const terminalNodes = nodes.filter(n => n.kind === 'error' || n.kind === 'process_exit').map(n => n.id);

  return {
    capturedAt: chain.capturedAt,
    nodes,
    edges,
    rootNodes,
    terminalNodes,
    hypotheses: chain.hypotheses.map(h => ({
      tag: h.tag,
      summary: h.summary,
      confidence: h.confidence,
      confidenceScore: h.confidenceScore,
      causalPath: h.causalPath,
      fixHint: h.fixHint,
      evidence: h.evidence,
      pid: h.pid,
    })),
    errorFingerprint: chain.errorFingerprint,
  };
}
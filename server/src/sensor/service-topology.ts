/**
 * service-topology.ts — Persistent service dependency graph.
 *
 * Answers: "What is the structural shape of this system?"
 *
 * Built incrementally from two signal sources:
 *   1. BackendSpanEvents — service name, route, duration, parentSpanId
 *   2. NetworkEvent traceId joins — browser called which backend service
 *
 * Persisted to ~/.mergen/topology.json across server restarts.
 * Queryable via REST (/topology) without any LLM involvement.
 *
 * Architecture note: this is the system-state representation layer.
 * The causal chain builder uses it to name services in edge labels.
 * The LLM reads it as structured context, not as the source of truth.
 */

import fs from 'fs';
import path from 'path';
import { DATA_DIR, TOPOLOGY_FILE } from './paths.js';
import type { BackendSpanEvent, NetworkEvent } from './buffer.js';
import logger from './logger.js';

// ── Types ──────────────────────────────────────────────────────────────────────

export type ServiceType = 'browser' | 'api' | 'database' | 'queue' | 'cache' | 'infra' | 'unknown';

export interface ServiceNode {
  id: string;
  type: ServiceType;
  name: string;
  sdk?: string;
  spanCount: number;
  errorCount: number;
  /** Rolling window of last 100 durations for percentile approximation. */
  recentDurationsMs: number[];
  firstSeenAt: number;
  lastSeenAt: number;
}

export interface ServiceEdge {
  from: string;
  to: string;
  callCount: number;
  errorCount: number;
  totalDurationMs: number;
  lastSeenAt: number;
  /** Up to 5 sample traceIds — lets callers drill into specific traces. */
  sampleTraceIds: string[];
}

export interface ServiceTopologySummary {
  totalServices: number;
  totalEdges: number;
  errorHotspot: string | null;
  slowestEdge: { from: string; to: string; avgDurationMs: number } | null;
  criticalPath: string[];
}

export interface ServiceTopologySnapshot {
  capturedAt: string;
  nodes: (Omit<ServiceNode, 'recentDurationsMs'> & { avgDurationMs: number; p99DurationMs: number })[];
  edges: (Omit<ServiceEdge, 'totalDurationMs'> & { avgDurationMs: number })[];
  summary: ServiceTopologySummary;
}

// ── Persistence ────────────────────────────────────────────────────────────────

const MAX_DURATION_SAMPLES = 100;
const MAX_SAMPLE_TRACE_IDS = 5;

interface PersistedTopology {
  nodes: Record<string, ServiceNode>;
  edges: Record<string, ServiceEdge>;
  updatedAt: number;
}

// ── Service type inference ─────────────────────────────────────────────────────

const DB_PATTERN    = /postgres|mysql|mongo|redis|elastic|cassandra|dynamo|sqlite|cockroach|clickhouse|snowflake|bigquery|db$/i;
const QUEUE_PATTERN = /kafka|rabbit|sqs|pubsub|nats|celery|queue|broker|worker$/i;
const CACHE_PATTERN = /redis|memcache|cache$/i;
const INFRA_PATTERN = /nginx|haproxy|envoy|istio|k8s|kubernetes|docker|gateway|proxy|lb$/i;

function inferServiceType(name: string): ServiceType {
  if (name === 'browser') return 'browser';
  if (CACHE_PATTERN.test(name))  return 'cache';
  if (DB_PATTERN.test(name))     return 'database';
  if (QUEUE_PATTERN.test(name))  return 'queue';
  if (INFRA_PATTERN.test(name))  return 'infra';
  return 'api';
}

// ── Percentile helpers ─────────────────────────────────────────────────────────

function p99(samples: number[]): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.max(0, Math.floor(sorted.length * 0.99) - 1);
  return sorted[idx] ?? 0;
}

function avg(samples: number[]): number {
  if (samples.length === 0) return 0;
  return Math.round(samples.reduce((s, v) => s + v, 0) / samples.length);
}

// ── ServiceTopologyModel ───────────────────────────────────────────────────────

class ServiceTopologyModel {
  private nodes: Map<string, ServiceNode> = new Map();
  private edges: Map<string, ServiceEdge> = new Map();

  constructor() {
    this.load();
  }

  // ── Ingestion ─────────────────────────────────────────────────────────────

  updateFromSpan(span: BackendSpanEvent): void {
    this.upsertNode(span.service, {
      sdk: span.sdk,
      duration: span.durationMs,
      isError: span.statusCode >= 500 || !!span.error,
      ts: span.timestamp,
    });

    // If the span has a parent, we know the caller called this service.
    // The caller identity is resolved in updateFromTraceJoin (which has the
    // full set of spans for a traceId). Here we just record the span itself.
    // For edge inference without parentSpanId, we rely on traceId joins.
  }

  /** Called when a browser NetworkEvent's traceId matches a BackendSpanEvent. */
  updateFromTraceJoin(
    browserUrl: string,
    targetService: string,
    durationMs: number,
    isError: boolean,
    traceId: string,
    ts: number,
  ): void {
    this.upsertNode('browser', { duration: durationMs, isError, ts });
    this.upsertEdge('browser', targetService, { durationMs, isError, traceId, ts });
  }

  /**
   * Resolve service-to-service edges from a set of spans sharing a traceId.
   * Called after grouping all BackendSpanEvents by traceId in the ring buffer.
   */
  updateFromTraceGroup(spans: BackendSpanEvent[]): void {
    if (spans.length < 2) return;

    // Build spanId → service map
    const spanToService = new Map<string, string>();
    for (const s of spans) {
      if (s.spanId) spanToService.set(s.spanId, s.service);
    }

    for (const span of spans) {
      if (!span.parentSpanId) continue;
      const caller = spanToService.get(span.parentSpanId);
      if (!caller || caller === span.service) continue;

      this.upsertEdge(caller, span.service, {
        durationMs: span.durationMs,
        isError: span.statusCode >= 500 || !!span.error,
        traceId: span.traceId,
        ts: span.timestamp,
      });
    }
  }

  // ── Read ──────────────────────────────────────────────────────────────────

  snapshot(): ServiceTopologySnapshot {
    const nodes = Array.from(this.nodes.values()).map(n => ({
      id: n.id,
      type: n.type,
      name: n.name,
      sdk: n.sdk,
      spanCount: n.spanCount,
      errorCount: n.errorCount,
      avgDurationMs: avg(n.recentDurationsMs),
      p99DurationMs: p99(n.recentDurationsMs),
      firstSeenAt: n.firstSeenAt,
      lastSeenAt: n.lastSeenAt,
    }));

    const edges = Array.from(this.edges.values()).map(e => ({
      from: e.from,
      to: e.to,
      callCount: e.callCount,
      errorCount: e.errorCount,
      avgDurationMs: e.callCount > 0 ? Math.round(e.totalDurationMs / e.callCount) : 0,
      lastSeenAt: e.lastSeenAt,
      sampleTraceIds: e.sampleTraceIds,
    }));

    return {
      capturedAt: new Date().toISOString(),
      nodes,
      edges,
      summary: this.buildSummary(nodes, edges),
    };
  }

  size(): { nodes: number; edges: number } {
    return { nodes: this.nodes.size, edges: this.edges.size };
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private upsertNode(
    id: string,
    opts: { sdk?: string; duration?: number; isError?: boolean; ts: number },
  ): void {
    const existing = this.nodes.get(id);
    if (existing) {
      existing.spanCount++;
      if (opts.isError) existing.errorCount++;
      if (opts.sdk && !existing.sdk) existing.sdk = opts.sdk;
      if (opts.duration !== undefined) {
        existing.recentDurationsMs.push(opts.duration);
        if (existing.recentDurationsMs.length > MAX_DURATION_SAMPLES) {
          existing.recentDurationsMs.shift();
        }
      }
      existing.lastSeenAt = Math.max(existing.lastSeenAt, opts.ts);
    } else {
      this.nodes.set(id, {
        id,
        type: inferServiceType(id),
        name: id,
        sdk: opts.sdk,
        spanCount: 1,
        errorCount: opts.isError ? 1 : 0,
        recentDurationsMs: opts.duration !== undefined ? [opts.duration] : [],
        firstSeenAt: opts.ts,
        lastSeenAt: opts.ts,
      });
    }
    this.schedulePersist();
  }

  private upsertEdge(
    from: string,
    to: string,
    opts: { durationMs: number; isError: boolean; traceId: string; ts: number },
  ): void {
    const key = `${from}→${to}`;
    const existing = this.edges.get(key);
    if (existing) {
      existing.callCount++;
      if (opts.isError) existing.errorCount++;
      existing.totalDurationMs += opts.durationMs;
      existing.lastSeenAt = Math.max(existing.lastSeenAt, opts.ts);
      if (!existing.sampleTraceIds.includes(opts.traceId)) {
        existing.sampleTraceIds.push(opts.traceId);
        if (existing.sampleTraceIds.length > MAX_SAMPLE_TRACE_IDS) {
          existing.sampleTraceIds.shift();
        }
      }
    } else {
      this.edges.set(key, {
        from,
        to,
        callCount: 1,
        errorCount: opts.isError ? 1 : 0,
        totalDurationMs: opts.durationMs,
        lastSeenAt: opts.ts,
        sampleTraceIds: [opts.traceId],
      });
      // Ensure both endpoints exist as nodes
      if (!this.nodes.has(from)) {
        this.upsertNode(from, { ts: opts.ts });
      }
      if (!this.nodes.has(to)) {
        this.upsertNode(to, { ts: opts.ts });
      }
    }
  }

  private buildSummary(
    nodes: ServiceTopologySnapshot['nodes'],
    edges: ServiceTopologySnapshot['edges'],
  ): ServiceTopologySummary {
    const errorHotspot = nodes.length > 0
      ? nodes.sort((a, b) => b.errorCount - a.errorCount)[0]?.id ?? null
      : null;

    const slowestEdge = edges.length > 0
      ? edges.sort((a, b) => b.avgDurationMs - a.avgDurationMs)[0] ?? null
      : null;

    // Critical path: start from browser → follow highest-call-count edges
    const criticalPath: string[] = [];
    const browserNode = nodes.find(n => n.id === 'browser');
    if (browserNode) {
      let current = 'browser';
      const visited = new Set<string>();
      while (!visited.has(current)) {
        criticalPath.push(current);
        visited.add(current);
        const outgoing = edges
          .filter(e => e.from === current)
          .sort((a, b) => b.callCount - a.callCount);
        if (outgoing.length === 0) break;
        current = outgoing[0].to;
      }
    }

    return {
      totalServices: nodes.length,
      totalEdges: edges.length,
      errorHotspot: errorHotspot && nodes.find(n => n.id === errorHotspot)?.errorCount ? errorHotspot : null,
      slowestEdge: slowestEdge
        ? { from: slowestEdge.from, to: slowestEdge.to, avgDurationMs: slowestEdge.avgDurationMs }
        : null,
      criticalPath,
    };
  }

  // ── Persistence ───────────────────────────────────────────────────────────

  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persist();
    }, 2_000);
  }

  private persist(): void {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const payload: PersistedTopology = {
        nodes: Object.fromEntries(this.nodes),
        edges: Object.fromEntries(this.edges),
        updatedAt: Date.now(),
      };
      const tmp = TOPOLOGY_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
      fs.renameSync(tmp, TOPOLOGY_FILE);
    } catch (err) {
      logger.warn({ err }, 'service-topology: persist failed');
    }
  }

  private load(): void {
    try {
      if (!fs.existsSync(TOPOLOGY_FILE)) return;
      const raw = fs.readFileSync(TOPOLOGY_FILE, 'utf8');
      const data = JSON.parse(raw) as PersistedTopology;
      for (const [k, v] of Object.entries(data.nodes ?? {})) this.nodes.set(k, v);
      for (const [k, v] of Object.entries(data.edges ?? {})) this.edges.set(k, v);
    } catch (err) {
      logger.warn({ err }, 'service-topology: failed to load persisted data — starting fresh');
    }
  }
}

export const serviceTopology = new ServiceTopologyModel();

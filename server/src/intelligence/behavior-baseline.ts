/**
 * behavior-baseline.ts — Behavioral baseline and anomaly detection for the MCP gate.
 *
 * Every 50 gate events, computes a per-agent deviation profile from the 500-event
 * gate ring in gate-analytics.ts. Anomaly signals:
 *
 *   high   — block rate spike (>5 blocks in last 10 calls for this agent)
 *   medium — call rate spike (current rate > 3× baseline avg calls/min)
 *   low    — tool distribution shift (unseen tool appears >3 times)
 *
 * On a high anomaly, a one-shot GovernanceHook is registered in agent-pipeline.ts
 * that blocks the next autonomous execution until the anomaly clears.
 *
 * Baselines are persisted per-agent in agent-context-store (key: baseline_v1)
 * so they survive server restarts.
 */

import { getGateEvents, type GateEvent } from './gate-analytics.js';
import { registerGovernanceHook, clearGovernanceHooks } from './agent-pipeline.js';
import logger from '../sensor/logger.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AgentBaseline {
  agentId: string;
  avgCallsPerMin: number;
  blockRate: number;
  toolDistribution: Record<string, number>; // fraction of calls per tool name
  sampleCount: number;
  computedAt: number;
}

export interface AnomalyReport {
  anomaly: boolean;
  severity: 'low' | 'medium' | 'high';
  reason: string;
}

// ── In-memory baselines ───────────────────────────────────────────────────────

const _baselines = new Map<string, AgentBaseline>();
let _gateEventCount = 0;
const BASELINE_RECOMPUTE_EVERY = 50; // gate events

// ── Core logic ────────────────────────────────────────────────────────────────

function _buildBaseline(agentId: string, events: GateEvent[]): AgentBaseline {
  const agentEvents = events.filter((e) => e.agentId === agentId);
  if (agentEvents.length < 5) {
    return {
      agentId, avgCallsPerMin: 0, blockRate: 0,
      toolDistribution: {}, sampleCount: agentEvents.length, computedAt: Date.now(),
    };
  }

  const blocks = agentEvents.filter((e) => e.verdict === 'block').length;
  const blockRate = blocks / agentEvents.length;

  const span = agentEvents[agentEvents.length - 1].ts - agentEvents[0].ts;
  const avgCallsPerMin = span > 0 ? (agentEvents.length / (span / 60_000)) : 0;

  const toolCounts: Record<string, number> = {};
  for (const e of agentEvents) {
    toolCounts[e.toolName] = (toolCounts[e.toolName] ?? 0) + 1;
  }
  const toolDistribution: Record<string, number> = {};
  for (const [tool, count] of Object.entries(toolCounts)) {
    toolDistribution[tool] = count / agentEvents.length;
  }

  return { agentId, avgCallsPerMin, blockRate, toolDistribution, sampleCount: agentEvents.length, computedAt: Date.now() };
}

export function detectAnomaly(agentId: string, recentEvents: GateEvent[]): AnomalyReport {
  const agentEvents = recentEvents.filter((e) => e.agentId === agentId);
  if (agentEvents.length < 5) return { anomaly: false, severity: 'low', reason: 'insufficient data' };

  const baseline = _baselines.get(agentId);

  // High: block rate spike — >5 blocks in last 10 calls
  const last10 = agentEvents.slice(-10);
  const recentBlocks = last10.filter((e) => e.verdict === 'block').length;
  if (recentBlocks > 5) {
    return {
      anomaly: true, severity: 'high',
      reason: `Block rate spike: ${recentBlocks}/10 recent calls blocked (baseline: ${baseline ? (baseline.blockRate * 100).toFixed(0) : '?'}%)`,
    };
  }

  if (baseline && baseline.sampleCount >= 10) {
    // Medium: call rate spike — current > 3× baseline
    const last5min = agentEvents.filter((e) => e.ts > Date.now() - 5 * 60_000);
    const currentRate = last5min.length / 5; // calls per min in last 5 min
    if (baseline.avgCallsPerMin > 0 && currentRate > baseline.avgCallsPerMin * 3) {
      return {
        anomaly: true, severity: 'medium',
        reason: `Call rate spike: ${currentRate.toFixed(1)}/min vs baseline ${baseline.avgCallsPerMin.toFixed(1)}/min`,
      };
    }

    // Low: new tool appearing >3 times that wasn't in baseline
    const recentTools: Record<string, number> = {};
    for (const e of agentEvents.slice(-20)) {
      recentTools[e.toolName] = (recentTools[e.toolName] ?? 0) + 1;
    }
    for (const [tool, count] of Object.entries(recentTools)) {
      if (count > 3 && !(tool in baseline.toolDistribution)) {
        return {
          anomaly: true, severity: 'low',
          reason: `Unseen tool \`${tool}\` called ${count} times — not in baseline distribution`,
        };
      }
    }
  }

  return { anomaly: false, severity: 'low', reason: '' };
}

// ── Periodic recompute hook ───────────────────────────────────────────────────

export function onGateEvent(agentId: string | null): void {
  if (!agentId || agentId === 'agent') return;
  _gateEventCount++;
  if (_gateEventCount % BASELINE_RECOMPUTE_EVERY !== 0) return;

  const events = getGateEvents();
  const baseline = _buildBaseline(agentId, events);
  _baselines.set(agentId, baseline);

  const report = detectAnomaly(agentId, events);
  if (!report.anomaly) return;

  logger.warn({ agentId, severity: report.severity, reason: report.reason }, 'behavior-baseline: anomaly detected');

  if (report.severity === 'high') {
    // Register a one-shot governance hook that blocks the next autonomous execution.
    // The hook clears all hooks on first fire (self-removing pattern).
    const capturedReason = report.reason;
    registerGovernanceHook(async (_ctx) => {
      clearGovernanceHooks(); // self-removes; clears any stacked hooks for this agent
      return { verdict: 'block' as const, reason: `Anomaly block: ${capturedReason}` };
    });
    logger.warn({ agentId }, 'behavior-baseline: high-severity anomaly — one-shot governance hook registered');
  }
}

export async function persistBaseline(agentId: string, baseline: AgentBaseline): Promise<void> {
  try {
    const { agentContextStore } = await import('../sensor/agent-context-store.js');
    agentContextStore.store(agentId, 'baseline_v1', JSON.stringify(baseline), 0);
  } catch { /* non-critical */ }
}

export async function hydrateBaseline(agentId: string): Promise<void> {
  if (!agentId || _baselines.has(agentId)) return;
  try {
    const { agentContextStore } = await import('../sensor/agent-context-store.js');
    const entries = agentContextStore.recall(agentId, 'baseline_v1', 1);
    if (entries.length > 0) {
      const b = JSON.parse(entries[0].value) as AgentBaseline;
      _baselines.set(agentId, b);
    }
  } catch { /* non-critical */ }
}

export function getBaseline(agentId: string): AgentBaseline | null {
  return _baselines.get(agentId) ?? null;
}

export function _resetBaselinesForTesting(): void {
  _baselines.clear();
  _gateEventCount = 0;
}

/**
 * planning-gate.ts — Deterministic execution decision layer.
 *
 * LeCun's critique in one sentence: "You're trusting a stochastic parrot to
 * restart your database." The fix: move the execute/skip decision to a
 * deterministic model BEFORE the LLM generates the remediation command.
 *
 * This gate synthesises three independent signals:
 *
 *   1. Classifier confidence   — P(hypothesis is correct) from the trained
 *                                 logistic regression in calibration-classifier.ts
 *
 *   2. Service blast risk      — How many upstream services depend on the
 *                                 failing service (from service-graph.ts).
 *                                 More dependents → higher execution threshold.
 *
 *   3. Historical fix success  — For this (tag, service) pair, how often did
 *                                 past autonomous fixes succeed? Derived from
 *                                 the calibration corpus (tag-level accuracy).
 *
 * The gate returns:
 *   - execute: boolean             — final decision
 *   - reason: string               — human-readable explanation for Slack
 *   - adjustedConfidence: number   — confidence after blast-risk adjustment
 *   - signals: { classifier, blastRisk, histSuccessRate }
 *
 * The autopilot checks this gate BEFORE calling LLM for fix generation,
 * so the LLM is only invoked when the gate has already approved execution.
 * This separates "should we act?" (deterministic) from "how do we describe it?" (LLM).
 */

import { calibrationClassifier } from './calibration-classifier.js';
import { getStatsForTag } from './calibration.js';
import { serviceGraph } from '../sensor/service-graph.js';
import { postmortemStore } from './postmortem-store.js';
import { DEFAULT_EXECUTION_THRESHOLD } from './threshold-optimizer.js';
import type { Hypothesis } from './causal.js';
import logger from '../sensor/logger.js';

export interface PlanningSignals {
  /** Logistic regression P(hypothesis is correct) */
  classifierScore: number;
  /** Number of upstream services that depend on the erroring service */
  upstreamImpact: number;
  /** Blast risk tier derived from upstream impact count */
  blastRisk: 'low' | 'medium' | 'high';
  /** Historical autonomous fix success rate for this tag across all services */
  histSuccessRate: number | null;
  /** Causal-correctness rate of the last ≤5 (tag, service) incidents specifically */
  recentServiceSuccessRate: number | null;
  /** How many corpus samples drove recentServiceSuccessRate (0 = signal absent) */
  recentServiceSamples: number;
}

export interface PlanningDecision {
  execute: boolean;
  reason: string;
  adjustedConfidence: number;
  signals: PlanningSignals;
}

// DEFAULT_EXECUTION_THRESHOLD is imported from threshold-optimizer.ts — single source of truth.

/**
 * The blast-risk multiplier lowers the effective confidence when many services
 * depend on the target service. A HIGH blast risk raises the required threshold
 * by 10 percentage points (e.g. 0.85 → 0.95).
 */
const BLAST_RISK_THRESHOLD_DELTA: Record<'low' | 'medium' | 'high', number> = {
  low:    0.00,
  medium: 0.05,
  high:   0.10,
};

/**
 * Make a deterministic execute/skip decision for an autonomous fix.
 *
 * @param hyp               The top hypothesis from buildCausalChain
 * @param service           The service that fired the incident
 * @param executionThreshold The base threshold from threshold-optimizer (default 0.85)
 */
export function planningGate(
  hyp: Hypothesis,
  service: string,
  executionThreshold: number = DEFAULT_EXECUTION_THRESHOLD,
): PlanningDecision {
  const confidence = hyp.confidenceScore ?? 0;

  // ── Signal 1: classifier ────────────────────────────────────────────────────
  const tagStats = getStatsForTag(hyp.tag);
  const classifierScore = calibrationClassifier.predict(
    confidence,
    tagStats?.accuracy ?? 0.5,
    tagStats?.verdicts ?? 0,
    tagStats?.trusted ?? false,
  );

  // ── Signal 2: blast risk ────────────────────────────────────────────────────
  const blastRisk    = serviceGraph.getBlastRisk(service);
  const upstreamImpact = serviceGraph.getUpstreamImpact(service).length;

  // Warn and apply a +10pp threshold bump when the service has no observed spans.
  // An unobserved service has no blast-risk data — silently defaulting to 'low'
  // could permit execution on a service that is actually critical.
  const serviceUnobserved = upstreamImpact === 0 && blastRisk === 'low';
  if (serviceUnobserved) {
    logger.warn({ service }, 'planning-gate: service has no observed spans — applying +10pp threshold as precaution');
  }

  // ── Signal 3: historical fix success rate ───────────────────────────────────
  const histSuccessRate = tagStats?.trusted ? tagStats.accuracy : null;

  // ── Signal 4: per-(tag, service) recency success rate ───────────────────────
  // Queries the postmortem corpus for the 5 most recent incidents with the exact
  // (tag, service) pair. Fires as a veto when ≥3 samples show <30% causal success,
  // even if the global tag accuracy is high. This operationalises cross-incident
  // linking into the execution decision rather than just the postmortem display.
  const recentPms = postmortemStore
    .getByTag(hyp.tag, 10)
    .filter((pm) => pm.service === service)
    .slice(0, 5);
  const recentServiceSuccessRate = recentPms.length >= 3
    ? recentPms.filter((pm) => pm.causallyCorrect).length / recentPms.length
    : null;
  const recentServiceSamples = recentPms.length;

  // ── Adjusted confidence ─────────────────────────────────────────────────────
  // Blend raw confidence with classifier score (60/40 weighting — raw confidence
  // still dominates so existing tuning isn't disrupted).
  const blended = confidence * 0.6 + classifierScore * 0.4;
  const adjustedConfidence = Math.round(blended * 1000) / 1000;

  // ── Effective threshold (raised for high blast risk or unobserved service) ──
  const unobservedDelta = serviceUnobserved ? 0.10 : 0.00;
  const effectiveThreshold = executionThreshold + BLAST_RISK_THRESHOLD_DELTA[blastRisk] + unobservedDelta;

  const signals: PlanningSignals = {
    classifierScore: Math.round(classifierScore * 1000) / 1000,
    upstreamImpact,
    blastRisk,
    histSuccessRate: histSuccessRate !== null ? Math.round(histSuccessRate * 1000) / 1000 : null,
    recentServiceSuccessRate: recentServiceSuccessRate !== null ? Math.round(recentServiceSuccessRate * 1000) / 1000 : null,
    recentServiceSamples,
  };

  // ── Decision logic ──────────────────────────────────────────────────────────
  // Classifier must be at least 0.50 to proceed regardless of raw confidence
  if (classifierScore < 0.50) {
    return {
      execute: false,
      reason: `classifier gate: P(correct)=${(classifierScore * 100).toFixed(0)}% < 50% — hypothesis pattern does not match historical correct fixes`,
      adjustedConfidence,
      signals,
    };
  }

  if (adjustedConfidence < effectiveThreshold) {
    return {
      execute: false,
      reason: `adjusted confidence ${(adjustedConfidence * 100).toFixed(0)}% < ${(effectiveThreshold * 100).toFixed(0)}% threshold (blast risk: ${blastRisk}, classifier: ${(classifierScore * 100).toFixed(0)}%)`,
      adjustedConfidence,
      signals,
    };
  }

  if (blastRisk === 'high' && (histSuccessRate !== null && histSuccessRate < 0.60)) {
    return {
      execute: false,
      reason: `high blast risk (${upstreamImpact} upstream services) + low historical success rate (${(histSuccessRate * 100).toFixed(0)}%) — requires manual approval`,
      adjustedConfidence,
      signals,
    };
  }

  if (recentServiceSuccessRate !== null && recentServiceSuccessRate < 0.30) {
    return {
      execute: false,
      reason: `service-specific failure: last ${recentServiceSamples} (${hyp.tag}, ${service}) incidents resolved correctly only ${Math.round(recentServiceSuccessRate * 100)}% of the time — requires manual review`,
      adjustedConfidence,
      signals,
    };
  }

  return {
    execute: true,
    reason: `planning gate approved: adjusted confidence ${(adjustedConfidence * 100).toFixed(0)}%, classifier ${(classifierScore * 100).toFixed(0)}%, blast risk ${blastRisk}${recentServiceSuccessRate !== null ? `, service success ${Math.round(recentServiceSuccessRate * 100)}%` : ''}`,
    adjustedConfidence,
    signals,
  };
}

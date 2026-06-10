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
import type { Hypothesis } from './causal.js';

export interface PlanningSignals {
  /** Logistic regression P(hypothesis is correct) */
  classifierScore: number;
  /** Number of upstream services that depend on the erroring service */
  upstreamImpact: number;
  /** Blast risk tier derived from upstream impact count */
  blastRisk: 'low' | 'medium' | 'high';
  /** Historical autonomous fix success rate for this (tag, service) */
  histSuccessRate: number | null;
}

export interface PlanningDecision {
  execute: boolean;
  reason: string;
  adjustedConfidence: number;
  signals: PlanningSignals;
}

/** Minimum adjusted confidence to approve execution (can be overridden by caller). */
const DEFAULT_EXECUTION_THRESHOLD = 0.85;

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

  // ── Signal 3: historical fix success rate ───────────────────────────────────
  const histSuccessRate = tagStats?.trusted ? tagStats.accuracy : null;

  // ── Adjusted confidence ─────────────────────────────────────────────────────
  // Blend raw confidence with classifier score (60/40 weighting — raw confidence
  // still dominates so existing tuning isn't disrupted).
  const blended = confidence * 0.6 + classifierScore * 0.4;
  const adjustedConfidence = Math.round(blended * 1000) / 1000;

  // ── Effective threshold (raised for high blast risk) ────────────────────────
  const effectiveThreshold = executionThreshold + BLAST_RISK_THRESHOLD_DELTA[blastRisk];

  const signals: PlanningSignals = {
    classifierScore: Math.round(classifierScore * 1000) / 1000,
    upstreamImpact,
    blastRisk,
    histSuccessRate: histSuccessRate !== null ? Math.round(histSuccessRate * 1000) / 1000 : null,
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

  return {
    execute: true,
    reason: `planning gate approved: adjusted confidence ${(adjustedConfidence * 100).toFixed(0)}%, classifier ${(classifierScore * 100).toFixed(0)}%, blast risk ${blastRisk}`,
    adjustedConfidence,
    signals,
  };
}

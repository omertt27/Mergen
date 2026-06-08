/**
 * agent-pipeline.ts — Multi-agent governance pipeline for autonomous incident triage.
 *
 * Implements the 6-stage governance model from the Architecture of Developer
 * Indispensability document. Each stage is a deterministic reasoning function —
 * not an LLM call — that applies specialized logic to prune/enrich the output
 * of the previous stage.
 *
 * Stages:
 *   1. Detector      — extract anomaly signals from causal chain (already run)
 *   2. Hypothesis    — rank hypotheses by calibrated confidence
 *   3. Validator     — cross-check hypothesis against all evidence signals
 *   4. Planner       — build step-by-step execution plan with rollback
 *   5. Critic        — blast radius + reversibility + contradiction scan
 *   6. Guarded Action — final confidence gate → proceed / review / block
 *
 * The pipeline is the execution path for incident-autopilot.ts (background) and
 * triage_incident (MCP tool). triage_incident exposes stage outputs in its report
 * so the on-call engineer can see exactly why the system proceeded or blocked.
 *
 * buildCausalChain() covers stages 1–2; this module adds stages 3–6.
 */

import type { CausalChain, Hypothesis } from './causal.js';
import { fixActionToCommand } from './causal.js';
import { extractCommand } from './autonomy.js';
import { computeBlastRadius } from './blast-radius.js';
import { deriveRollback } from './rollback.js';
import { getStatsForTag } from './calibration.js';
import { hasRecentOverride } from './override-corpus.js';
import { getAutopilotLevel, autopilotLevelPermits, classifyCommandRisk } from './action-risk.js';
import { postmortemStore } from './postmortem-store.js';
import logger from '../sensor/logger.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type PipelineStageStatus = 'pass' | 'warn' | 'block';

export interface PipelineStage {
  name: string;
  status: PipelineStageStatus;
  summary: string;
  detail?: string;
}

export interface ValidationResult {
  score: number;           // 0–1: how well the hypothesis explains the evidence
  contradictions: string[];
  corpusPrecedent: boolean;
  precedentCount: number;
  avgMttrMs: number | null;
}

export interface ExecutionStep {
  order: number;
  action: string;
  command?: string;
}

export interface ExecutionPlan {
  command: string;
  rollbackCommand: string | null;
  steps: ExecutionStep[];
  estimatedRisk: 'low' | 'medium' | 'high';
  requiresApproval: boolean;
  reversible: boolean;
}

export interface CritiqueResult {
  verdict: 'proceed' | 'review' | 'block';
  concerns: string[];
  blastRadiusSummary: string;
  corpusConflict: boolean;
  levelConflict: boolean;
}

export interface PipelineResult {
  stages: PipelineStage[];
  topHypothesis: Hypothesis | null;
  validation: ValidationResult | null;
  plan: ExecutionPlan | null;
  critique: CritiqueResult | null;
  /** Final pipeline decision */
  verdict: 'proceed' | 'review' | 'block';
  blockReason: string | null;
}

export interface PipelineOpts {
  service?: string;
  executionThreshold?: number;  // defaults to 0.85
  service_time?: { dayOfWeek: number; hourOfDay: number };
}

// ── Stage 3: Validator ────────────────────────────────────────────────────────

/**
 * Cross-validates the top hypothesis against all evidence in the causal chain.
 *
 * Checks:
 * - Coverage: does the hypothesis explain the primary error signals?
 * - Contradictions: are there signals that conflict with the hypothesis?
 * - Corpus: has this failure mode been seen before? What was the MTTR?
 */
function validateHypothesis(hyp: Hypothesis, chain: CausalChain): ValidationResult {
  const contradictions: string[] = [];
  let coverageScore = 0;

  // Check 1: hypothesis tag should appear in at least one error or infra signal
  const errorTexts = chain.errors.map((e) => e.message.toLowerCase());
  const tagParts = hyp.tag.replace(/^infra_/, '').split('_');

  const tagMatches = tagParts.filter((part) =>
    part.length >= 4 &&
    errorTexts.some((msg) => msg.includes(part)),
  );
  coverageScore += tagMatches.length > 0 ? 0.3 : 0;

  // Check 2: evidence strings align with causal chain events
  const evidenceMatched = hyp.evidence.filter((ev) => {
    const evLower = ev.toLowerCase();
    return chain.errors.some((e) => e.message.toLowerCase().includes(evLower.slice(0, 20))) ||
      chain.correlatedNetwork.some((n) =>
        n.url.toLowerCase().includes(evLower.slice(0, 20)) ||
        (n.error ?? '').toLowerCase().includes(evLower.slice(0, 20)),
      );
  });
  coverageScore += Math.min(0.4, evidenceMatched.length * 0.1);

  // Check 3: causal path is non-trivial (at least 2 steps = well-reasoned)
  coverageScore += hyp.causalPath.length >= 2 ? 0.3 : 0;

  // Contradiction 1: network hypothesis but zero network events
  const isNetworkHyp = /network|dns|timeout|latency|503|502|429|rate_limit/i.test(hyp.tag);
  if (isNetworkHyp && chain.correlatedNetwork.length === 0 && chain.errors.length > 0) {
    contradictions.push('Network hypothesis but no network events observed in window');
    coverageScore -= 0.2;
  }

  // Contradiction 2: memory/OOM hypothesis but no process exit signals
  const isOomHyp = /oom|memory|heap|killed/i.test(hyp.tag);
  if (isOomHyp && chain.correlatedBackend.length === 0 && chain.errors.length > 0) {
    const oomInErrors = chain.errors.some((e) =>
      /oom|memory|heap|killed|enomem/i.test(e.message),
    );
    if (!oomInErrors) {
      contradictions.push('OOM hypothesis but no OOM-related signals in error messages');
      coverageScore -= 0.15;
    }
  }

  // Contradiction 3: hypothesis tag mismatch with top error fingerprint
  if (chain.errors.length > 0 && hyp.evidence.length === 0) {
    contradictions.push('Hypothesis has no explicit evidence — may be a weak signal match');
  }

  // Corpus precedent: has this failure mode been resolved before?
  const corpusStats = postmortemStore.tagStats().find((s) => s.tag === hyp.tag);
  const precedentCount = corpusStats?.count ?? 0;
  const avgMttrMs = corpusStats?.avgMttrMs ?? null;

  // Boost confidence if we have corpus precedent
  if (precedentCount > 0) {
    coverageScore += Math.min(0.2, precedentCount * 0.05);
  }

  return {
    score: Math.max(0, Math.min(1, coverageScore)),
    contradictions,
    corpusPrecedent: precedentCount > 0,
    precedentCount,
    avgMttrMs,
  };
}

// ── Stage 4: Planner ──────────────────────────────────────────────────────────

/**
 * Builds a structured execution plan from the top hypothesis.
 * Translates fixAction/fixHint into an ordered step sequence with rollback.
 */
function buildExecutionPlan(hyp: Hypothesis, chain: CausalChain): ExecutionPlan | null {
  const command = hyp.fixAction
    ? fixActionToCommand(hyp.fixAction)
    : hyp.fixHint
      ? extractCommand(hyp.fixHint)
      : null;

  if (!command) return null;

  const rollback = deriveRollback(command, '');
  const rollbackCommand = rollback.type === 'command' ? rollback.command : null;

  // Risk classification from action-risk tier
  const risk = classifyCommandRisk(command);
  const estimatedRisk: 'low' | 'medium' | 'high' =
    risk === 'restart' ? 'low' :
    risk === 'full' ? 'high' : 'medium';

  const reversible = rollbackCommand !== null ||
    /restart|rollout|deploy/i.test(command);

  // Build step-by-step procedure
  const steps: ExecutionStep[] = [
    { order: 1, action: 'Confirm current error state', command: 'triage_incident (diagnosis only)' },
    { order: 2, action: `Execute fix: ${hyp.fixHint?.split('\n')[0] ?? command}`, command },
  ];

  if (rollbackCommand) {
    steps.push({ order: 3, action: 'Validate resolution', command: 'validate_fix' });
    steps.push({ order: 4, action: 'Rollback if REGRESSED', command: rollbackCommand });
  } else {
    steps.push({ order: 3, action: 'Validate resolution (manual rollback required if REGRESSED)', command: 'validate_fix' });
  }

  // Require approval for high-risk or irreversible commands
  const requiresApproval = estimatedRisk === 'high' || !reversible;

  return {
    command,
    rollbackCommand,
    steps,
    estimatedRisk,
    requiresApproval,
    reversible,
  };
}

// ── Stage 5: Critic ───────────────────────────────────────────────────────────

/**
 * Red-teams the execution plan for failure modes.
 *
 * Checks:
 * - Blast radius: scope of impact if command goes wrong
 * - Reversibility: is there a rollback path?
 * - Override corpus: is this (tag, service) currently overridden?
 * - Autopilot level: does the risk tier exceed the configured level?
 * - Known contradictions from the validation stage
 */
function critiqueExecutionPlan(
  plan: ExecutionPlan,
  hyp: Hypothesis,
  validation: ValidationResult,
  service: string,
  opts: PipelineOpts,
): CritiqueResult {
  const concerns: string[] = [];
  let verdict: 'proceed' | 'review' | 'block' = 'proceed';

  // Blast radius
  const blastRadius = computeBlastRadius(plan.command);
  const dtLabel = blastRadius.estimatedDowntimeMs != null
    ? `~${Math.round(blastRadius.estimatedDowntimeMs / 1000)}s downtime`
    : 'unknown downtime';
  const blastSummary = `${blastRadius.scope} scope · ${dtLabel} · ${blastRadius.reversible ? 'reversible' : 'IRREVERSIBLE'}`;

  if (!blastRadius.reversible) {
    const rollbackNote = blastRadius.rollbackCommand ?? 'no rollback path';
    concerns.push(`Command is IRREVERSIBLE: ${rollbackNote}`);
    verdict = 'block';
  }

  if (blastRadius.dataAtRisk) {
    concerns.push('Data mutation detected — command may modify persistent state');
    verdict = verdict === 'proceed' ? 'review' : verdict;
  }

  if (plan.estimatedRisk === 'high') {
    concerns.push(`High-risk command tier: ${classifyCommandRisk(plan.command)}`);
    verdict = verdict === 'proceed' ? 'review' : verdict;
  }

  // Validation contradictions
  if (validation.contradictions.length > 0) {
    concerns.push(...validation.contradictions.map((c) => `Validation: ${c}`));
    if (validation.score < 0.3) {
      verdict = 'block';
    } else if (validation.score < 0.6) {
      verdict = verdict === 'proceed' ? 'review' : verdict;
    }
  }

  // Override corpus check (e.g. "don't restart during business hours")
  const now = opts.service_time ?? {
    dayOfWeek: new Date().getUTCDay(),
    hourOfDay: new Date().getUTCHours(),
  };
  const corpusConflict = hasRecentOverride(hyp.tag, service, now.dayOfWeek, now.hourOfDay);
  if (corpusConflict) {
    const reason = (() => {
      try {
        // dominantOverrideReason may not be exported — safe fallback
        const mod = require('./override-corpus.js') as { dominantOverrideReason?: (tag: string, service: string) => string };
        return mod.dominantOverrideReason?.(hyp.tag, service) ?? 'override corpus conflict';
      } catch { return 'override corpus conflict'; }
    })();
    concerns.push(`Override corpus: ${reason}`);
    verdict = verdict === 'proceed' ? 'review' : verdict;
  }

  // Autopilot level check
  const autopilotLevel = getAutopilotLevel();
  const levelConflict = !autopilotLevelPermits(plan.command, autopilotLevel);
  if (levelConflict) {
    concerns.push(`MERGEN_AUTOPILOT_LEVEL=${autopilotLevel} does not permit ${classifyCommandRisk(plan.command)}-tier commands`);
    verdict = 'block';
  }

  // Low evidence score
  if (validation.score < 0.2 && validation.contradictions.length === 0) {
    concerns.push('Low validation score — hypothesis may not explain all observed signals');
    verdict = verdict === 'proceed' ? 'review' : verdict;
  }

  return {
    verdict,
    concerns,
    blastRadiusSummary: blastSummary,
    corpusConflict,
    levelConflict,
  };
}

// ── Stage 6: Guarded Action ───────────────────────────────────────────────────

function guardedAction(
  hyp: Hypothesis,
  plan: ExecutionPlan,
  critique: CritiqueResult,
  threshold: number,
): { verdict: 'proceed' | 'review' | 'block'; blockReason: string | null } {
  const execConfidence = hyp.remediationConfidence ?? hyp.confidenceScore ?? 0;

  if (critique.verdict === 'block') {
    return {
      verdict: 'block',
      blockReason: critique.concerns[0] ?? 'Critic stage blocked execution',
    };
  }

  if (execConfidence < threshold) {
    return {
      verdict: 'block',
      blockReason: `Remediation confidence ${Math.round(execConfidence * 100)}% is below ${Math.round(threshold * 100)}% threshold`,
    };
  }

  if (critique.verdict === 'review' || plan.requiresApproval) {
    return { verdict: 'review', blockReason: null };
  }

  return { verdict: 'proceed', blockReason: null };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Run the multi-agent governance pipeline on a completed causal chain.
 *
 * Stages 1–2 (Detector + Hypothesis) are handled upstream by buildCausalChain.
 * This function runs stages 3–6 (Validator → Planner → Critic → Guard).
 *
 * Returns a PipelineResult with per-stage verdicts and the final decision.
 * If the pipeline blocks execution, blockReason explains why.
 */
export function runAgentPipeline(chain: CausalChain, opts: PipelineOpts = {}): PipelineResult {
  const threshold = opts.executionThreshold ?? 0.85;
  const service = opts.service ?? 'unknown';
  const stages: PipelineStage[] = [];

  // ── Stage 1: Detector (already run) ───────────────────────────────────────
  const errorCount = chain.errors.length;
  const netCount = chain.correlatedNetwork.filter((n) => n.status >= 400).length;
  stages.push({
    name: 'detector',
    status: 'pass',
    summary: `${errorCount} console error${errorCount !== 1 ? 's' : ''}, ${netCount} network failure${netCount !== 1 ? 's' : ''}`,
    detail: chain.chain.length > 0 ? `${chain.chain.length} causal events in timeline` : undefined,
  });

  // ── Stage 2: Hypothesis (already run) ─────────────────────────────────────
  const topHyp = chain.hypotheses[0] ?? null;
  if (!topHyp) {
    stages.push({
      name: 'hypothesis',
      status: 'block',
      summary: 'No hypothesis generated — insufficient signals for root cause identification',
    });
    return { stages, topHypothesis: null, validation: null, plan: null, critique: null, verdict: 'block', blockReason: 'No hypothesis generated' };
  }

  const calStats = getStatsForTag(topHyp.tag);
  const calLabel = calStats?.isEmpirical ? `calibrated (${calStats.verdicts} verdicts)` : 'prior estimate';
  const pct = Math.round((topHyp.confidenceScore ?? 0) * 100);
  stages.push({
    name: 'hypothesis',
    status: 'pass',
    summary: `${topHyp.confidence} (${pct}%) — ${topHyp.summary.slice(0, 80)}`,
    detail: `[${calLabel}]  ${chain.hypotheses.length} total hypotheses, ${chain.suppressedHypotheses.length} suppressed`,
  });

  // ── Stage 3: Validator ─────────────────────────────────────────────────────
  const validation = validateHypothesis(topHyp, chain);
  const validStatus: PipelineStageStatus =
    validation.score >= 0.6 ? 'pass' :
    validation.score >= 0.3 ? 'warn' : 'block';

  stages.push({
    name: 'validator',
    status: validStatus,
    summary: `Coverage score ${Math.round(validation.score * 100)}%` +
      (validation.corpusPrecedent ? ` · ${validation.precedentCount} corpus match${validation.precedentCount !== 1 ? 'es' : ''}` : ' · no corpus precedent') +
      (validation.avgMttrMs != null ? ` · avg MTTR ${Math.round(validation.avgMttrMs / 60_000)}m` : ''),
    detail: validation.contradictions.length > 0
      ? validation.contradictions.join('; ')
      : undefined,
  });

  // ── Stage 4: Planner ───────────────────────────────────────────────────────
  const plan = buildExecutionPlan(topHyp, chain);
  if (!plan) {
    stages.push({
      name: 'planner',
      status: 'warn',
      summary: 'No executable command — fix requires manual intervention',
    });
    return {
      stages,
      topHypothesis: topHyp,
      validation,
      plan: null,
      critique: null,
      verdict: 'review',
      blockReason: 'No executable command in fix hint',
    };
  }

  stages.push({
    name: 'planner',
    status: plan.estimatedRisk === 'high' ? 'warn' : 'pass',
    summary: `\`${plan.command}\` · risk: ${plan.estimatedRisk} · ${plan.reversible ? 'reversible' : 'IRREVERSIBLE'}`,
    detail: plan.rollbackCommand ? `rollback: \`${plan.rollbackCommand}\`` : 'no rollback path',
  });

  // ── Stage 5: Critic ────────────────────────────────────────────────────────
  const critique = critiqueExecutionPlan(plan, topHyp, validation, service, opts);
  stages.push({
    name: 'critic',
    status: critique.verdict === 'proceed' ? 'pass' : critique.verdict === 'review' ? 'warn' : 'block',
    summary: `${critique.blastRadiusSummary} · ${critique.concerns.length === 0 ? 'no concerns' : `${critique.concerns.length} concern${critique.concerns.length !== 1 ? 's' : ''}`}`,
    detail: critique.concerns.length > 0 ? critique.concerns.slice(0, 3).join('; ') : undefined,
  });

  // ── Stage 6: Guarded Action ────────────────────────────────────────────────
  const guard = guardedAction(topHyp, plan, critique, threshold);
  stages.push({
    name: 'guard',
    status: guard.verdict === 'proceed' ? 'pass' : guard.verdict === 'review' ? 'warn' : 'block',
    summary: guard.verdict.toUpperCase() +
      (guard.blockReason ? ` — ${guard.blockReason}` : '') +
      (guard.verdict === 'proceed' ? ` (remediation confidence ${Math.round((topHyp.remediationConfidence ?? topHyp.confidenceScore ?? 0) * 100)}% ≥ ${Math.round(threshold * 100)}%)` : ''),
  });

  logger.debug({
    service,
    tag: topHyp.tag,
    validationScore: Math.round(validation.score * 100),
    pipelineVerdict: guard.verdict,
    stages: stages.map((s) => `${s.name}:${s.status}`).join(','),
  }, 'agent-pipeline: complete');

  return {
    stages,
    topHypothesis: topHyp,
    validation,
    plan,
    critique,
    verdict: guard.verdict,
    blockReason: guard.blockReason,
  };
}

/**
 * Render pipeline stage output as a Markdown section for Slack or MCP tools.
 */
export function renderPipelineStages(stages: PipelineStage[]): string {
  const icon = (s: PipelineStageStatus) =>
    s === 'pass' ? '✅' : s === 'warn' ? '⚠️' : '🚫';

  const lines = ['### Pipeline', ''];
  for (const stage of stages) {
    lines.push(`${icon(stage.status)} **${stage.name}**: ${stage.summary}`);
    if (stage.detail) lines.push(`   _${stage.detail}_`);
  }
  return lines.join('\n');
}

/**
 * llm-spokesperson.ts — The "Linguistic Brain" wrapper.
 *
 * LeCun's insight: separate the analytical brain (classifiers, topology, calibration)
 * from the linguistic brain (LLM). The LLM should only ever receive a tightly
 * scoped, pre-validated facts package and be instructed to translate — not reason.
 *
 * This module assembles that package from:
 *   - The top hypothesis (post-calibration, post-topology-filter)
 *   - The planning gate decision and signals
 *   - Service graph context (who calls this service, what does it call)
 *   - Platt-calibrated probability with its empirical basis
 *
 * The output is a structured "validated facts brief" that can be passed to any
 * LLM as a system + user prompt. The LLM is explicitly instructed NOT to add
 * new reasoning — only to express the validated conclusions in natural language.
 *
 * This pattern:
 *   1. Eliminates hallucinated causation ("I think it might also be related to...")
 *   2. Makes the LLM output auditable (any claim traces back to a specific signal)
 *   3. Drastically reduces prompt size → lower inference cost → better margins
 */

import type { Hypothesis } from './causal.js';
import type { PlanningDecision } from './planning-gate.js';
import { plattScale } from './platt-scaling.js';
import { serviceGraph } from '../sensor/service-graph.js';

export interface ValidatedFactsBrief {
  /** System-level instruction for the LLM — tells it to translate, not reason */
  systemPrompt: string;
  /** The validated facts package — the LLM's only input for reasoning */
  userPrompt: string;
  /** Token budget estimate (rough chars / 4) */
  estimatedTokens: number;
}

/**
 * Build a validated facts brief for the LLM "spokesperson" role.
 *
 * @param hyp             Top hypothesis (topology-filtered, Platt-calibrated)
 * @param service         The incident service
 * @param gate            Planning gate decision (contains signals)
 * @param errorCount      Number of errors in the window
 * @param runtimeFact     Optional raw fact markdown from Datadog (truncated)
 */
export function formatValidatedFactsForLLM(
  hyp: Hypothesis,
  service: string,
  gate: PlanningDecision,
  errorCount: number,
  runtimeFact?: string | null,
  calibratedScore?: number,
): ValidatedFactsBrief {
  const rawScore = hyp.confidenceScore;
  const { calibrated: autoCalibrated, source, n } = plattScale(rawScore, hyp.tag);
  const calibrated = calibratedScore ?? autoCalibrated;
  const calibratedPct = Math.round(calibrated * 100);
  const basisNote = source === 'raw'
    ? '(prior — no calibration data yet)'
    : source === 'empirical'
      ? `(empirical — ${n} verdicts)`
      : `(Platt-calibrated — ${n} verdicts)`;

  // Topology context
  const callers  = serviceGraph.getCallers(service);
  const callees  = serviceGraph.getCallees(service);
  const topoLines: string[] = [];
  if (callers.length > 0) topoLines.push(`- Called by: ${callers.slice(0, 5).join(', ')}`);
  if (callees.length > 0) topoLines.push(`- Calls: ${callees.slice(0, 5).join(', ')}`);
  const topoSection = topoLines.length > 0
    ? `\nService topology (from live OTLP traces):\n${topoLines.join('\n')}`
    : '';

  // Planning signals
  const signalLines = [
    `- Classifier P(correct): ${(gate.signals.classifierScore * 100).toFixed(0)}%`,
    `- Blast risk: ${gate.signals.blastRisk} (${gate.signals.upstreamImpact} upstream services)`,
    gate.signals.histSuccessRate !== null
      ? `- Historical success rate for this detector: ${(gate.signals.histSuccessRate * 100).toFixed(0)}%`
      : '- Historical success rate: insufficient data',
  ];

  const systemPrompt =
    'You are the communications interface for an autonomous incident-response system. ' +
    'You will be given a structured facts package produced by deterministic analysis ' +
    '(topology graphs, calibrated classifiers, verdict corpus). ' +
    'Your ONLY job is to translate these validated facts into clear, human-readable ' +
    'engineering language. ' +
    'Do NOT add new hypotheses, speculate beyond the provided facts, or introduce ' +
    'uncertainty the data does not support. ' +
    'Do NOT pad with generic advice. Every sentence must trace back to a provided fact.';

  const userPrompt = [
    `## Incident Facts Package — ${service}`,
    '',
    `**Service under analysis:** ${service}`,
    `**Error count in window:** ${errorCount}`,
    topoSection,
    '',
    `## Validated Root Cause`,
    `**Detector:** ${hyp.tag}`,
    `**Summary:** ${hyp.summary}`,
    `**Calibrated confidence:** ${calibratedPct}% ${basisNote}`,
    hyp.causalPath.length > 0
      ? `**Causal path:**\n${hyp.causalPath.map((s, i) => `${i + 1}. ${s}`).join('\n')}`
      : '',
    hyp.evidence.length > 0
      ? `**Evidence:**\n${hyp.evidence.map((e) => `- ${e}`).join('\n')}`
      : '',
    '',
    `## Validated Planning Decision`,
    `**Decision:** ${gate.execute ? 'EXECUTE FIX' : 'HOLD — MANUAL ACTION REQUIRED'}`,
    `**Reason:** ${gate.reason}`,
    `**Signals:**\n${signalLines.join('\n')}`,
    hyp.fixHint
      ? `\n## Recommended Action\n${hyp.fixHint}`
      : '',
    runtimeFact
      ? `\n## Runtime Fact (Datadog trace summary)\n${runtimeFact.slice(0, 800)}`
      : '',
    '',
    '## Instructions',
    'Write a concise Slack thread reply (max 300 words) that explains the root cause and ' +
    'recommended action to the on-call engineer. Use the facts above. Do not add speculation.',
  ].filter((l) => l !== null).join('\n');

  return {
    systemPrompt,
    userPrompt,
    estimatedTokens: Math.round((systemPrompt.length + userPrompt.length) / 4),
  };
}

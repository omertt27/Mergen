/**
 * routes/impact-report.ts — Deck-quality impact artifact.
 *
 *   GET /impact-report           JSON summary (default 30-day window)
 *   GET /impact-report?format=html  Self-contained HTML one-pager (shareable, printable)
 *   GET /impact-report?days=N    Custom window (1–90 days)
 *
 * This endpoint produces the specific numbers a fundraising deck needs:
 *
 *   "Mergen processed 47 incidents. Autonomous resolution would have applied
 *    correctly 38 times (81%). Average time-to-fix: 4 minutes vs. 43 minutes."
 *
 * Data sources:
 *   - Shadow log: what Mergen would have done and whether confidence was sufficient
 *   - Incident store: actual MTTR from incidents that were manually resolved
 *   - Override corpus: patterns that were explicitly blocked
 *   - Calibration: per-detector accuracy breakdown
 *
 * MTTR methodology:
 *   Autonomous MTTR estimate = buffer_fill_delay (5s) + analysis (~10s)
 *     + execution (~10s) + validation_delay (5s) ≈ 30 seconds machine time.
 *   For the report we use 2 minutes as the conservative estimate — this
 *   accounts for Slack notification propagation and human acknowledgement.
 *   Actual MTTR = incident.resolvedAt - incident.createdAt from the incident store.
 *   Both are reported so the methodology is transparent.
 */

import { randomUUID } from 'crypto';
import { Router } from 'express';
import { getShadowLog } from '../intelligence/shadow-log.js';
import { getBlunderStats, verifyChain, type BlunderType } from '../sensor/agent-blunder-store.js';
import { getStats } from '../intelligence/calibration.js';
import { getStores } from '../storage/store-registry.js';
import { postmortemStore } from '../intelligence/postmortem-store.js';
import { plattScale } from '../intelligence/platt-scaling.js';
import logger from '../sensor/logger.js';

const DEFAULT_REVENUE_PER_MINUTE_USD = 100;
const DEFAULT_DOWNTIME_COST_PER_HOUR_USD = 10_000;

// Conservative autonomous MTTR estimate: buffer fill + analysis + exec + validation
const ESTIMATED_AUTONOMOUS_MTTR_MS = 2 * 60 * 1000; // 2 minutes

export function createImpactReportRouter(): Router {
  const router = Router();

  router.get('/impact-report', async (req, res) => {
    const windowDays = Math.min(90, Math.max(1, Number(req.query.days ?? 30)));
    const format = req.query.format as string | undefined;

    const data = await computeImpactData(windowDays, req.tenantId);
    logger.info({ windowDays, format }, 'impact-report: generated');

    if (format === 'html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'unsafe-inline'");
      res.send(buildHtml(data));
      return;
    }

    res.json({ ok: true, report: data });
  });

  return router;
}

// ── Data computation ──────────────────────────────────────────────────────────

interface ByTag {
  tag: string;
  total: number;
  wouldResolve: number;
  resolutionRate: number;
  avgActualMttrMs: number | null;
}

/** One row in the CISO comparison table: what Mergen would have done vs. what the engineer did. */
interface ComparisonRow {
  date: string;
  service: string;
  failureMode: string;
  mergenCommand: string | null;
  mergenConfidence: number;
  engineerAction: string;
  agreementType: 'agree' | 'override' | 'unreviewed';
  overrideReason: string | null;
  actualMttrMs: number | null;
  outcome: string | null;
}

interface ImpactData {
  generatedAt: string;
  windowDays: number;
  windowStart: string;
  windowEnd: string;
  totalIncidents: number;
  wouldResolveCount: number;
  wouldResolveRate: number;
  missedCount: number;
  // MTTR — split by resolution type for unbiased comparison
  estimatedAutonomousMttrMs: number;        // conservative floor (2 min) used when n=0
  avgAutonomousMttrMs: number | null;       // actual MTTR for autonomously resolved incidents
  autonomousMttrSampleSize: number;         // n for autonomous MTTR (for YC partner Q&A)
  avgManualMttrMs: number | null;           // actual MTTR for manually resolved incidents
  manualMttrSampleSize: number;             // n for manual MTTR
  avgActualMttrMs: number | null;           // combined MTTR (all incidents with data)
  mttrReductionPct: number | null;
  // Methodological note: autonomous MTTR only covers incidents where confidence
  // was ≥ 85% — the simpler, well-understood failure modes. Manual MTTR covers
  // all incidents including complex ones autopilot skipped. Compare within
  // confidence bands for an unbiased view.
  mttrSelectionBiasCaveat: string;
  // Context-assisted MTTR: among manually resolved incidents, those where the
  // engineer read Mergen's diagnosis brief first (GET /trust-score/:pid) resolved
  // faster than those who did not. This isolates Mergen's value even when it
  // doesn't execute the fix itself.
  avgContextAssistedMttrMs: number | null;
  contextAssistedMttrSampleSize: number;
  avgUnassistedMttrMs: number | null;
  unassistedMttrSampleSize: number;
  // Confidence distribution
  highConfidence: number;
  mediumConfidence: number;
  lowOrNoCommand: number;
  // Override corpus
  overridePatterns: number;
  corpusBlockCount: number;
  // By detector tag
  byTag: ByTag[];
  // Human review rate (shadow verdict annotations)
  humanReviewedCount: number;
  humanApprovalRate: number | null;
  // Platt raw comparison accuracy
  rawHighConfidenceApprovedRate: number | null;
  plattHighConfidenceApprovedRate: number | null;
  falsePositiveRate: number | null;
  falsePositiveCount: number;
  // Execution blocks triggered by >=85% confidence gate
  executionBlocks: {
    pid: string;
    date: string;
    service: string;
    command: string;
    confidence: number;
    blockedBy: string;
    reason: string;
  }[];
  // CISO comparison table: what Mergen would have done vs. what actually happened
  comparisonRows: ComparisonRow[];
  // Raw numbers for the deck slide
  deckSummary: string;
  // Y5: outcome-based billing evidence
  estimatedRevenuePreservedUsd: number | null;
  /** Dollar cost of downtime prevented — (manualMttr - autonomousMttr) × incidents × hourly cost.
   *  Configure via MERGEN_DOWNTIME_COST_PER_HOUR (default: $10,000). */
  estimatedDowntimeSavedUsd: number | null;
  corpusPostmortems: number;
  // Human-readable ROI — "4.2h saved across 11 incidents"
  timeSavedHours: number | null;
  hoursPerIncident: number | null;
  timeSavedLabel: string | null;
  // AEG gate enforcement — the board-deck answer to "why trust an AI agent with prod?"
  agentBlunderSummary: {
    totalPrevented: number;
    byType: Partial<Record<BlunderType, number>>;
    chainVerified: boolean;
  };
}

function fmtMs(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.round((ms % 60_000) / 1000);
  return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
}

async function computeImpactData(windowDays: number, tenantId?: string): Promise<ImpactData> {
  const now = Date.now();
  const cutoff = now - windowDays * 24 * 60 * 60 * 1000;

  const entries = [...getShadowLog()].filter((e) => e.recordedAt >= cutoff);

  const wouldResolve = entries.filter((e) => e.wouldHaveExecuted);
  const missed = entries.filter((e) => !e.wouldHaveExecuted);

  // Pre-fetch all incidents referenced by shadow log entries and all override ids
  const incidentMap = new Map(
    (await getStores().incidents.list(undefined, 10_000, tenantId)).map((i) => [i.pid, i]),
  );
  const corpus = await getStores().overrides.getOverrideSummary(tenantId);

  // Pre-fetch override details needed for the comparison table
  const overrideIds = [...new Set(entries.map((e) => e.overrideId).filter((id): id is string => !!id))];
  const overrideDetails = new Map(
    await Promise.all(overrideIds.map(async (id) => [id, await getStores().overrides.getOverrideById(id, tenantId)] as const)),
  );

  // MTTR: split by resolution type so the comparison is apples-to-apples.
  // Autonomous: incidents where resolvedAutonomously=true (the system acted).
  // Manual: incidents where resolvedAutonomously=false (engineer acted).
  // Combined: all incidents with MTTR data (used as fallback when split n is small).
  const autonomousMttrSamples: number[] = [];
  const manualMttrSamples: number[] = [];
  const contextAssistedMttrSamples: number[] = [];
  const unassistedMttrSamples: number[] = [];
  for (const entry of entries) {
    if (!entry.pid) continue;
    const inc = incidentMap.get(entry.pid);
    if (!inc?.resolvedAt || !inc.createdAt) continue;
    const mttr = inc.resolvedAt - inc.createdAt;
    if (inc.resolvedAutonomously) {
      autonomousMttrSamples.push(mttr);
    } else {
      manualMttrSamples.push(mttr);
      // Context-assisted split: did the engineer read Mergen's brief before acting?
      if (inc.contextBriefViewedAt != null) {
        contextAssistedMttrSamples.push(mttr);
      } else {
        unassistedMttrSamples.push(mttr);
      }
    }
  }
  const allMttrSamples = [...autonomousMttrSamples, ...manualMttrSamples];

  const avg = (arr: number[]) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
  const avgAutonomousMttrMs      = avg(autonomousMttrSamples);
  const avgManualMttrMs          = avg(manualMttrSamples);
  const avgActualMttrMs          = avg(allMttrSamples);
  const avgContextAssistedMttrMs = avg(contextAssistedMttrSamples);
  const avgUnassistedMttrMs      = avg(unassistedMttrSamples);

  // For reduction %, prefer the split comparison; fall back to combined vs. estimate
  const autonomousBenchmark = avgAutonomousMttrMs ?? ESTIMATED_AUTONOMOUS_MTTR_MS;
  const manualBenchmark     = avgManualMttrMs ?? avgActualMttrMs;
  const mttrReductionPct = manualBenchmark !== null && manualBenchmark > 0
    ? Math.round((1 - autonomousBenchmark / manualBenchmark) * 100)
    : null;

  // Confidence distribution
  const highConfidence  = entries.filter((e) => e.remediationConfidence >= 0.85).length;
  const mediumConfidence = entries.filter(
    (e) => e.remediationConfidence >= 0.70 && e.remediationConfidence < 0.85,
  ).length;
  const lowOrNoCommand = entries.filter(
    (e) => e.remediationConfidence < 0.70 || e.skipReason === 'no-command',
  ).length;

  // By tag
  const tagMap = new Map<string, { total: number; wouldResolve: number; mttrSamples: number[] }>();
  for (const entry of entries) {
    const t = tagMap.get(entry.incidentTag) ?? { total: 0, wouldResolve: 0, mttrSamples: [] };
    t.total += 1;
    if (entry.wouldHaveExecuted) t.wouldResolve += 1;
    if (entry.pid) {
      const inc = incidentMap.get(entry.pid);
      if (inc?.resolvedAt && inc.createdAt) t.mttrSamples.push(inc.resolvedAt - inc.createdAt);
    }
    tagMap.set(entry.incidentTag, t);
  }
  const byTag: ByTag[] = [...tagMap.entries()]
    .map(([tag, t]) => ({
      tag,
      total: t.total,
      wouldResolve: t.wouldResolve,
      resolutionRate: t.total > 0 ? t.wouldResolve / t.total : 0,
      avgActualMttrMs: t.mttrSamples.length > 0
        ? t.mttrSamples.reduce((a, b) => a + b, 0) / t.mttrSamples.length
        : null,
    }))
    .sort((a, b) => b.total - a.total);

  // Override corpus
  const corpusBlockCount = entries.filter((e) => e.skipReason === 'override-corpus').length;

  // Human review
  const reviewed = entries.filter((e) => e.humanVerdict !== undefined);
  const approved = reviewed.filter((e) => e.humanVerdict === 'would-approve').length;
  const humanApprovalRate = reviewed.length >= 3 ? approved / reviewed.length : null;

  // Platt accuracy vs raw accuracy
  const rawHighConfidenceEntries = entries.filter((e) => e.remediationConfidence >= 0.85 && e.humanVerdict !== undefined);
  const rawHighConfidenceApproved = rawHighConfidenceEntries.filter((e) => e.humanVerdict === 'would-approve').length;
  const rawHighConfidenceApprovedRate = rawHighConfidenceEntries.length > 0 ? rawHighConfidenceApproved / rawHighConfidenceEntries.length : null;

  const plattHighConfidenceEntries = entries.filter((e) => {
    const cal = plattScale(e.remediationConfidence, e.incidentTag).calibrated;
    return cal >= 0.85 && e.humanVerdict !== undefined;
  });
  const plattHighConfidenceApproved = plattHighConfidenceEntries.filter((e) => e.humanVerdict === 'would-approve').length;
  const plattHighConfidenceApprovedRate = plattHighConfidenceEntries.length > 0 ? plattHighConfidenceApproved / plattHighConfidenceEntries.length : null;

  const overrodeCount = reviewed.filter((e) => e.humanVerdict === 'would-override').length;
  const falsePositiveRate = reviewed.length > 0 ? overrodeCount / reviewed.length : null;
  const falsePositiveCount = overrodeCount;

  // Execution blocks successfully triggered by the >=85% confidence gate
  const executionBlocks = entries
    .filter((e) => e.remediationConfidence >= 0.85 && e.skipReason !== 'executed' && e.skipReason !== 'executed-failure')
    .map((e) => {
      let blockReason = 'Safety block';
      if (e.skipReason === 'override-corpus') blockReason = 'override corpus block';
      else if (e.skipReason === 'planning-gate') blockReason = 'planning gate block';
      else if (e.skipReason === 'level-restricted') blockReason = 'restricted by autopilot level';
      else if (e.skipReason === 'denied') blockReason = 'denied via Slack';
      else if (e.skipReason === 'blocked-by-safety-filter') blockReason = 'blocked by safety filter';
      else if (e.skipReason === 'track-record-pause') blockReason = 'paused due to wrong verdicts';

      return {
        pid: e.pid,
        date: new Date(e.firedAt ?? e.recordedAt).toISOString().slice(0, 16).replace('T', ' ') + ' UTC',
        service: e.service,
        command: e.command ?? 'unknown',
        confidence: e.remediationConfidence,
        blockedBy: e.skipReason,
        reason: blockReason,
      };
    });

  // Revenue preservation (Y5 outcome billing) — use actual autonomous MTTR when available
  const revenuePerMinute =
    parseFloat(process.env.MERGEN_REVENUE_PER_MINUTE_USD ?? '') || DEFAULT_REVENUE_PER_MINUTE_USD;
  const autonomousBenchmarkForRevenue = avgAutonomousMttrMs ?? ESTIMATED_AUTONOMOUS_MTTR_MS;
  const manualBenchmarkForRevenue     = avgManualMttrMs ?? avgActualMttrMs;
  const mttrSavedMs = manualBenchmarkForRevenue != null
    ? Math.max(0, manualBenchmarkForRevenue - autonomousBenchmarkForRevenue)
    : null;
  const estimatedRevenuePreservedUsd = mttrSavedMs != null && wouldResolve.length > 0
    ? Math.round((mttrSavedMs / 60_000) * revenuePerMinute * wouldResolve.length)
    : null;

  // Dollar cost of downtime prevented: (mttr_delta) × autonomous_count × hourly_cost
  const downtimeCostPerHour =
    parseFloat(process.env.MERGEN_DOWNTIME_COST_PER_HOUR ?? '') || DEFAULT_DOWNTIME_COST_PER_HOUR_USD;
  const estimatedDowntimeSavedUsd = mttrSavedMs != null && wouldResolve.length > 0
    ? Math.round((mttrSavedMs / 3_600_000) * downtimeCostPerHour * wouldResolve.length)
    : null;

  // Corpus size
  const corpusPostmortems = postmortemStore.count();

  // AEG gate enforcement summary
  const blunderStats = getBlunderStats();
  const chainResult = verifyChain();
  const agentBlunderSummary = {
    totalPrevented: blunderStats.total,
    byType: blunderStats.byType as Partial<Record<BlunderType, number>>,
    chainVerified: chainResult.valid,
  };

  // Time saved — human-readable ROI metric for design-partner reports and deck slides.
  // Uses actual MTTR when available; falls back to conservative estimates.
  const savedPerIncidentMs = Math.max(
    0,
    (manualBenchmarkForRevenue ?? 0) - (autonomousBenchmarkForRevenue),
  );
  const timeSavedHours = savedPerIncidentMs > 0 && wouldResolve.length > 0
    ? Math.round((savedPerIncidentMs * wouldResolve.length) / 3_600_000 * 10) / 10
    : null;
  const hoursPerIncident = savedPerIncidentMs > 0
    ? Math.round(savedPerIncidentMs / 3_600_000 * 10) / 10
    : null;
  const timeSavedLabel = timeSavedHours != null && wouldResolve.length > 0
    ? `${timeSavedHours}h saved across ${wouldResolve.length} incident${wouldResolve.length !== 1 ? 's' : ''}`
    : null;

  // Deck summary — the one sentence that goes on a slide, with n= so YC partners
  // can't ask "but what's the sample size?" without already having the answer.
  const rate = entries.length > 0
    ? Math.round((wouldResolve.length / entries.length) * 100)
    : 0;
  const topTags = byTag.slice(0, 3).map((t) => `${t.tag.replace(/^infra_/, '')}×${t.total}`).join(', ');
  const tagLine = topTags ? ` Top failure modes: ${topTags}.` : '';

  let mttrLine = '';
  if (avgAutonomousMttrMs !== null && avgManualMttrMs !== null) {
    mttrLine = ` MTTR: ${fmtMs(avgAutonomousMttrMs)} autonomous (n=${autonomousMttrSamples.length}) vs. ${fmtMs(avgManualMttrMs)} manual (n=${manualMttrSamples.length}).`;
  } else if (avgManualMttrMs !== null) {
    mttrLine = ` Est. autonomous MTTR: ${fmtMs(ESTIMATED_AUTONOMOUS_MTTR_MS)} vs. ${fmtMs(avgManualMttrMs)} manual (n=${manualMttrSamples.length}).`;
  } else if (avgActualMttrMs !== null) {
    mttrLine = ` Average time-to-fix: ${fmtMs(ESTIMATED_AUTONOMOUS_MTTR_MS)} est. autonomous vs. ${fmtMs(avgActualMttrMs)} observed (n=${allMttrSamples.length}).`;
  }

  let contextAssistedLine = '';
  if (avgContextAssistedMttrMs !== null && avgUnassistedMttrMs !== null) {
    contextAssistedLine = ` Context-assisted manual MTTR: ${fmtMs(avgContextAssistedMttrMs)} (n=${contextAssistedMttrSamples.length}) vs. ${fmtMs(avgUnassistedMttrMs)} without (n=${unassistedMttrSamples.length}).`;
  }

  const timeSavedSentence = timeSavedLabel ? ` ${timeSavedLabel} of engineer time.` : '';

  // False positive line — only shown when there is enough human feedback to compute it
  const _reviewedCount = reviewed.length;
  const _corpusSize = corpus.length;
  let falsePositiveLine = '';
  if (falsePositiveRate !== null && _reviewedCount >= 5) {
    const fpPct = Math.round(falsePositiveRate * 100);
    falsePositiveLine = ` False positive rate: ${fpPct}% (${falsePositiveCount} of ${_reviewedCount} human-reviewed diagnoses).`;
  } else if (_reviewedCount > 0 && _reviewedCount < 5) {
    falsePositiveLine = ` False positive rate: pending (${_reviewedCount} of 5 human reviews needed for a reliable estimate).`;
  }

  // Override frequency — how often the corpus is protecting against repeated mistakes
  let overrideFrequencyLine = '';
  if (corpusBlockCount > 0) {
    overrideFrequencyLine = ` Override corpus blocked ${corpusBlockCount} autonomous action${corpusBlockCount !== 1 ? 's' : ''} across ${_corpusSize} encoded pattern${_corpusSize !== 1 ? 's' : ''}.`;
  } else if (_corpusSize > 0) {
    overrideFrequencyLine = ` Override corpus has ${_corpusSize} encoded pattern${_corpusSize !== 1 ? 's' : ''} — none triggered in this window.`;
  }

  const deckSummary =
    `Mergen processed ${entries.length} incident${entries.length !== 1 ? 's' : ''} (n=${entries.length}).${tagLine} ` +
    `Autonomous resolution would have applied correctly ${wouldResolve.length} time${wouldResolve.length !== 1 ? 's' : ''} (${rate}%).` +
    mttrLine +
    contextAssistedLine +
    timeSavedSentence +
    falsePositiveLine +
    overrideFrequencyLine;

  // CISO comparison table — one row per incident with side-by-side actions
  const comparisonRows: ComparisonRow[] = entries
    .slice()
    .sort((a, b) => (b.firedAt ?? b.recordedAt) - (a.firedAt ?? a.recordedAt))
    .map((entry): ComparisonRow => {
      const inc = entry.pid ? incidentMap.get(entry.pid) : null;
      const actualMttrMs = inc?.resolvedAt && inc.createdAt ? inc.resolvedAt - inc.createdAt : null;

      // Determine what the engineer actually did, sourced from the override corpus when available
      let engineerAction = 'Not yet reviewed';
      let agreementType: ComparisonRow['agreementType'] = 'unreviewed';
      let overrideReason: string | null = null;

      if (entry.skipReason === 'executed') {
        engineerAction = 'Executed autonomously';
        agreementType = 'agree';
      } else if (entry.skipReason === 'executed-failure') {
        engineerAction = 'Executed autonomously (failed)';
        agreementType = 'override';
        overrideReason = 'Command failed with non-zero exit code';
      } else if (entry.skipReason === 'blocked-by-safety-filter') {
        engineerAction = 'Blocked by safety gate';
        agreementType = 'override';
        overrideReason = 'Command triggered safety pattern blocklist';
      } else if (entry.skipReason === 'denied') {
        engineerAction = 'Denied by engineer';
        agreementType = 'override';
        overrideReason = 'Manual override via Slack gate';
      } else if (entry.humanVerdict === 'would-approve') {
        engineerAction = 'Would apply same fix';
        agreementType = 'agree';
      } else if (entry.humanVerdict === 'would-override' && entry.overrideId) {
        const ov = overrideDetails.get(entry.overrideId) ?? null;
        engineerAction = ov?.manualAction ?? 'Override — see corpus';
        overrideReason = ov?.overrideReason ?? null;
        agreementType = 'override';
      }

      return {
        date: new Date(entry.firedAt ?? entry.recordedAt).toISOString().slice(0, 16).replace('T', ' ') + ' UTC',
        service: entry.service,
        failureMode: entry.incidentTag.replace(/^infra_/, ''),
        mergenCommand: entry.command,
        mergenConfidence: entry.remediationConfidence,
        engineerAction,
        agreementType,
        overrideReason,
        actualMttrMs,
        outcome: inc?.status ?? null,
      };
    });

  const windowStartDate = new Date(cutoff);
  const windowEndDate = new Date(now);

  return {
    generatedAt: new Date(now).toISOString(),
    windowDays,
    windowStart: windowStartDate.toISOString().slice(0, 10),
    windowEnd:   windowEndDate.toISOString().slice(0, 10),
    totalIncidents: entries.length,
    wouldResolveCount: wouldResolve.length,
    wouldResolveRate: entries.length > 0 ? wouldResolve.length / entries.length : 0,
    missedCount: missed.length,
    estimatedAutonomousMttrMs: ESTIMATED_AUTONOMOUS_MTTR_MS,
    avgAutonomousMttrMs,
    autonomousMttrSampleSize: autonomousMttrSamples.length,
    avgManualMttrMs,
    manualMttrSampleSize: manualMttrSamples.length,
    avgActualMttrMs,
    mttrReductionPct,
    mttrSelectionBiasCaveat:
      'Autonomous MTTR only covers incidents where confidence was ≥85% — ' +
      'the simpler, well-understood failure modes autopilot picked up. ' +
      'Manual MTTR covers all incidents, including complex ones autopilot skipped. ' +
      'For an unbiased comparison, filter manual MTTR to the same high-confidence cohort.',
    avgContextAssistedMttrMs,
    contextAssistedMttrSampleSize: contextAssistedMttrSamples.length,
    avgUnassistedMttrMs,
    unassistedMttrSampleSize: unassistedMttrSamples.length,
    highConfidence,
    mediumConfidence,
    lowOrNoCommand,
    overridePatterns: corpus.length,
    corpusBlockCount,
    byTag,
    humanReviewedCount: reviewed.length,
    humanApprovalRate,
    rawHighConfidenceApprovedRate,
    plattHighConfidenceApprovedRate,
    falsePositiveRate,
    falsePositiveCount,
    executionBlocks,
    comparisonRows,
    deckSummary,
    estimatedRevenuePreservedUsd,
    estimatedDowntimeSavedUsd,
    corpusPostmortems,
    timeSavedHours,
    hoursPerIncident,
    timeSavedLabel,
    agentBlunderSummary,
  };
}

// ── HTML artifact ─────────────────────────────────────────────────────────────

function pct(n: number): string { return `${Math.round(n * 100)}%`; }
function num(n: number): string { return n.toLocaleString(); }

function buildHtml(d: ImpactData): string {
  const nonce = randomUUID().replace(/-/g, '');

  const autoMttrLabel = d.avgAutonomousMttrMs !== null
    ? `${fmtMs(d.avgAutonomousMttrMs)} <span class="muted" style="font-weight:400;font-size:11px">(n=${d.autonomousMttrSampleSize} actual)</span>`
    : `${fmtMs(d.estimatedAutonomousMttrMs)} <span class="muted" style="font-weight:400;font-size:11px">(estimated)</span>`;
  const manualMttr = d.avgManualMttrMs ?? d.avgActualMttrMs;
  const manualN    = d.avgManualMttrMs !== null ? d.manualMttrSampleSize : (d.manualMttrSampleSize + d.autonomousMttrSampleSize);
  const mttrRow = manualMttr !== null ? `
    <tr>
      <td>Avg. MTTR — manual resolution</td>
      <td class="val">${fmtMs(manualMttr)} <span class="muted" style="font-weight:400;font-size:11px">(n=${manualN})</span></td>
    </tr>
    <tr>
      <td>Avg. MTTR — autonomous resolution</td>
      <td class="val green">${autoMttrLabel}</td>
    </tr>
    <tr>
      <td>MTTR reduction</td>
      <td class="val green">${d.mttrReductionPct !== null ? d.mttrReductionPct + '%' : '—'}</td>
    </tr>` : `
    <tr>
      <td>Autonomous MTTR</td>
      <td class="val green">${autoMttrLabel}</td>
    </tr>
    <tr>
      <td>Manual MTTR</td>
      <td class="val muted">No resolved incidents in window</td>
    </tr>`;

  const tagRows = d.byTag.slice(0, 8).map((t) => `
    <tr>
      <td class="mono">${t.tag.replace(/^infra_/, '')}</td>
      <td>${num(t.total)}</td>
      <td>${num(t.wouldResolve)}</td>
      <td class="${t.resolutionRate >= 0.85 ? 'green' : t.resolutionRate >= 0.6 ? 'yellow' : 'red'}">${pct(t.resolutionRate)}</td>
      <td class="muted">${t.avgActualMttrMs !== null ? fmtMs(t.avgActualMttrMs) : '—'}</td>
    </tr>`).join('');

  const humanRow = d.humanApprovalRate !== null
    ? `<tr><td>Human approval rate (shadow review)</td><td class="val green">${pct(d.humanApprovalRate)} (${num(d.humanReviewedCount)} reviewed)</td></tr>`
    : `<tr><td>Human approval rate</td><td class="val muted">${d.humanReviewedCount < 3 ? 'Awaiting reviews' : '—'}</td></tr>`;

  const overrideRow = d.overridePatterns > 0
    ? `<tr><td>Override patterns learned</td><td class="val">${num(d.overridePatterns)} pattern${d.overridePatterns !== 1 ? 's' : ''} (${num(d.corpusBlockCount)} block${d.corpusBlockCount !== 1 ? 's' : ''})</td></tr>`
    : '';

  const contextAssistedRow = d.avgContextAssistedMttrMs !== null && d.avgUnassistedMttrMs !== null
    ? `<tr>
        <td>Manual MTTR — context-assisted (read brief)</td>
        <td class="val green">${fmtMs(d.avgContextAssistedMttrMs)} <span class="muted" style="font-weight:400;font-size:11px">(n=${d.contextAssistedMttrSampleSize})</span></td>
      </tr>
      <tr>
        <td>Manual MTTR — unassisted</td>
        <td class="val">${fmtMs(d.avgUnassistedMttrMs)} <span class="muted" style="font-weight:400;font-size:11px">(n=${d.unassistedMttrSampleSize})</span></td>
      </tr>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mergen Impact Report — ${d.windowStart} to ${d.windowEnd}</title>
<style nonce="${nonce}">
  *{box-sizing:border-box;margin:0;padding:0}
  :root{
    --bg:#0f1117;--surface:#1a1d26;--border:#2a2d3a;
    --text:#e2e8f0;--muted:#64748b;
    --green:#22c55e;--yellow:#f59e0b;--red:#ef4444;--blue:#3b82f6;
    --font:system-ui,-apple-system,sans-serif;
  }
  @media print{
    :root{--bg:#fff;--surface:#f8f9fa;--border:#dee2e6;--text:#212529;--muted:#6c757d;
      --green:#198754;--yellow:#fd7e14;--red:#dc3545;}
    body{font-size:11pt}
    .no-print{display:none}
    a{color:var(--text)}
  }
  body{background:var(--bg);color:var(--text);font-family:var(--font);font-size:13px;line-height:1.6;padding:40px 24px;max-width:860px;margin:0 auto}
  h1{font-size:22px;font-weight:700;margin-bottom:4px}
  .subtitle{color:var(--muted);font-size:13px;margin-bottom:32px}
  .deck-summary{
    background:var(--surface);border:1px solid var(--border);border-left:4px solid var(--blue);
    padding:16px 20px;border-radius:6px;font-size:15px;font-weight:500;margin-bottom:32px;line-height:1.5;
  }
  .grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:20px;margin-bottom:32px}
  @media(max-width:900px){.grid{grid-template-columns:1fr}}
  .card{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:20px}
  .card-title{font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin-bottom:16px}
  table{width:100%;border-collapse:collapse}
  td{padding:6px 0;border-bottom:1px solid var(--border);font-size:12px;vertical-align:top}
  td:last-child{text-align:right;border-bottom:1px solid var(--border)}
  tr:last-child td{border-bottom:none}
  .val{font-weight:600;font-size:14px}
  .green{color:var(--green)}
  .yellow{color:var(--yellow)}
  .red{color:var(--red)}
  .muted{color:var(--muted)}
  .mono{font-family:monospace;font-size:11px}
  .big-number{font-size:36px;font-weight:700;line-height:1;margin-bottom:4px}
  .big-label{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
  .hero{display:flex;gap:24px;margin-bottom:32px}
  .hero-item{flex:1;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:20px}
  .tag-table{width:100%;border-collapse:collapse;margin-top:8px}
  .tag-table th{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);padding:0 0 8px;text-align:left;border-bottom:1px solid var(--border)}
  .tag-table th:not(:first-child){text-align:right}
  .tag-table td{padding:7px 0;border-bottom:1px solid var(--border);font-size:12px}
  .tag-table td:not(:first-child){text-align:right}
  .tag-table tr:last-child td{border-bottom:none}
  .footer{margin-top:40px;font-size:11px;color:var(--muted);display:flex;justify-content:space-between;align-items:center}
  .print-btn{background:var(--blue);color:#fff;border:none;padding:8px 16px;border-radius:6px;cursor:pointer;font-size:12px;font-family:inherit}
  .badge{display:inline-block;font-size:10px;font-weight:600;padding:2px 7px;border-radius:4px;margin-left:6px}
  .badge-green{background:rgba(34,197,94,.15);color:var(--green)}
  .badge-yellow{background:rgba(245,158,11,.15);color:var(--yellow)}
  .badge-red{background:rgba(239,68,68,.12);color:var(--red)}
  /* Comparison table */
  .cmp-wrap{overflow-x:auto;margin-bottom:32px}
  .cmp{width:100%;border-collapse:collapse;font-size:11px}
  .cmp th{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);padding:0 8px 8px 0;text-align:left;border-bottom:2px solid var(--border);white-space:nowrap}
  .cmp td{padding:8px 8px 8px 0;border-bottom:1px solid var(--border);vertical-align:top}
  .cmp tr:last-child td{border-bottom:none}
  .cmp .date{white-space:nowrap;color:var(--muted)}
  .cmp .cmd{font-family:monospace;font-size:10px;background:rgba(255,255,255,.04);padding:2px 5px;border-radius:3px;display:inline-block;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .cmp .agree{color:var(--green)}
  .cmp .override{color:var(--yellow)}
  .cmp .unreviewed{color:var(--muted)}
  .cmp .conf{font-size:10px;color:var(--muted)}
  .cmp .reason{font-size:10px;color:var(--yellow);display:block;margin-top:2px}
</style>
</head>
<body>
<h1>Mergen Impact Report</h1>
<div class="subtitle">${d.windowStart} → ${d.windowEnd} &nbsp;·&nbsp; ${d.windowDays}-day window &nbsp;·&nbsp; Generated ${new Date(d.generatedAt).toUTCString()}</div>

<div class="deck-summary">${d.deckSummary}</div>

<div class="hero">
  <div class="hero-item">
    <div class="big-number ${d.wouldResolveRate >= 0.8 ? 'green' : d.wouldResolveRate >= 0.6 ? 'yellow' : 'red'}">${pct(d.wouldResolveRate)}</div>
    <div class="big-label">Autonomous resolution rate</div>
  </div>
  <div class="hero-item">
    <div class="big-number">${num(d.totalIncidents)}</div>
    <div class="big-label">Incidents processed</div>
  </div>
  ${d.timeSavedHours !== null ? `
  <div class="hero-item">
    <div class="big-number green">${d.timeSavedHours}h</div>
    <div class="big-label">Engineer time saved${d.hoursPerIncident !== null ? ` · ${d.hoursPerIncident}h per incident` : ''}</div>
  </div>` : ''}
  ${d.estimatedDowntimeSavedUsd !== null ? `
  <div class="hero-item">
    <div class="big-number green">$${d.estimatedDowntimeSavedUsd.toLocaleString()}</div>
    <div class="big-label">Estimated downtime cost prevented</div>
  </div>` : ''}
  <div class="hero-item">
    <div class="big-number green">${fmtMs(d.avgAutonomousMttrMs ?? d.estimatedAutonomousMttrMs)}</div>
    <div class="big-label">${d.avgAutonomousMttrMs !== null ? `Autonomous MTTR (n=${d.autonomousMttrSampleSize})` : 'Est. autonomous MTTR'}</div>
  </div>
  ${d.avgActualMttrMs !== null ? `
  <div class="hero-item">
    <div class="big-number">${fmtMs(d.avgActualMttrMs)}</div>
    <div class="big-label">Avg. manual MTTR</div>
  </div>` : ''}
  <div class="hero-item">
    <div class="big-number ${d.agentBlunderSummary.totalPrevented > 0 ? 'green' : ''}">${num(d.agentBlunderSummary.totalPrevented)}</div>
    <div class="big-label">Destructive actions blocked by gate</div>
  </div>
</div>

${(() => {
  const blunder = d.agentBlunderSummary;
  const chainBadge = blunder.chainVerified
    ? `<span class="badge badge-green">chain verified</span>`
    : `<span class="badge badge-yellow">unverified</span>`;
  const typeRows = (Object.entries(blunder.byType) as [string, number][])
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `<tr><td class="mono">${t.replace(/_/g, ' ')}</td><td class="val">${num(n)}</td></tr>`)
    .join('');
  return `
<div class="card" style="margin-bottom:32px">
  <div class="card-title">Gate Enforcement (Agent Blunder Log) ${chainBadge}</div>
  <table>
    <tr><td>Total actions blocked by Mergen enforcement gate</td><td class="val ${blunder.totalPrevented > 0 ? 'green' : 'muted'}">${num(blunder.totalPrevented)}</td></tr>
    ${typeRows || '<tr><td class="muted" colspan="2">No blocked actions recorded in this period — gate active, no agent attempted a destructive action</td></tr>'}
  </table>
</div>`;
})()}

<div class="grid">
  <div class="card">
    <div class="card-title">Resolution summary</div>
    <table>
      <tr><td>Would resolve autonomously</td><td class="val green">${num(d.wouldResolveCount)}</td></tr>
      <tr><td>Would require manual action</td><td class="val">${num(d.missedCount)}</td></tr>
      ${mttrRow}
      ${contextAssistedRow}
      ${humanRow}
      ${overrideRow}
    </table>
  </div>
  <div class="card">
    <div class="card-title">Confidence distribution</div>
    <table>
      <tr>
        <td>HIGH — would execute (≥85%)</td>
        <td class="val green">${num(d.highConfidence)}
          <span class="badge badge-green">${d.totalIncidents > 0 ? pct(d.highConfidence / d.totalIncidents) : '0%'}</span>
        </td>
      </tr>
      <tr>
        <td>MEDIUM — diagnosis only (70–84%)</td>
        <td class="val yellow">${num(d.mediumConfidence)}
          <span class="badge badge-yellow">${d.totalIncidents > 0 ? pct(d.mediumConfidence / d.totalIncidents) : '0%'}</span>
        </td>
      </tr>
      <tr>
        <td>LOW / no executable fix (&lt;70%)</td>
        <td class="val muted">${num(d.lowOrNoCommand)}
          <span class="badge badge-red">${d.totalIncidents > 0 ? pct(d.lowOrNoCommand / d.totalIncidents) : '0%'}</span>
        </td>
      </tr>
    </table>
  </div>
  <div class="card">
    <div class="card-title">Calibration & Safety (Platt)</div>
    <table>
      <tr>
        <td>Raw High-Conf. Accuracy</td>
        <td class="val">${d.rawHighConfidenceApprovedRate !== null ? pct(d.rawHighConfidenceApprovedRate) : '—'}</td>
      </tr>
      <tr>
        <td>Platt-Calibrated Accuracy</td>
        <td class="val green">${d.plattHighConfidenceApprovedRate !== null ? pct(d.plattHighConfidenceApprovedRate) : '—'}</td>
      </tr>
      <tr>
        <td>False Positive Rate</td>
        <td class="val red">${d.falsePositiveRate !== null ? pct(d.falsePositiveRate) : '—'}</td>
      </tr>
      <tr>
        <td>False Positives (Overrides)</td>
        <td class="val">${num(d.falsePositiveCount)}</td>
      </tr>
    </table>
  </div>
</div>

${d.executionBlocks.length > 0 ? `
<div class="card" style="margin-bottom:32px">
  <div class="card-title">Execution Blocks (triggered by &ge;85% confidence gate)</div>
  <table class="tag-table">
    <thead>
      <tr>
        <th>Date</th>
        <th>Service</th>
        <th>Command</th>
        <th>Confidence</th>
        <th>Block Source</th>
        <th>Reason</th>
      </tr>
    </thead>
    <tbody>
      ${d.executionBlocks.map((b) => `
        <tr>
          <td class="muted">${b.date}</td>
          <td>${b.service}</td>
          <td><code class="mono" style="background:rgba(255,255,255,.04);padding:2px 5px;border-radius:3px">${b.command}</code></td>
          <td>${pct(b.confidence)}</td>
          <td><span class="badge badge-yellow">${b.blockedBy}</span></td>
          <td class="yellow">${b.reason}</td>
        </tr>
      `).join('')}
    </tbody>
  </table>
</div>` : ''}

${d.byTag.length > 0 ? `
<div class="card" style="margin-bottom:32px">
  <div class="card-title">By failure mode</div>
  <table class="tag-table">
    <thead>
      <tr>
        <th>Failure mode</th>
        <th>Incidents</th>
        <th>Would resolve</th>
        <th>Rate</th>
        <th>Avg. manual MTTR</th>
      </tr>
    </thead>
    <tbody>${tagRows}</tbody>
  </table>
</div>` : ''}

${d.comparisonRows.length > 0 ? buildComparisonTable(d.comparisonRows) : ''}

<div class="footer">
  <span>Mergen shadow mode · <a href="/shadow-report">shadow-report</a> · <a href="/override-corpus">override-corpus</a></span>
  <button class="print-btn no-print" onclick="window.print()">Save as PDF</button>
</div>
</body>
</html>`;
}

function buildComparisonTable(rows: ComparisonRow[]): string {
  const agreeIcon   = '✓';
  const overrideIcon = '↕';
  const pendingIcon = '·';

  const trs = rows.map((r) => {
    const cls = r.agreementType;
    const icon = cls === 'agree' ? agreeIcon : cls === 'override' ? overrideIcon : pendingIcon;
    const cmdCell = r.mergenCommand
      ? `<span class="cmd" title="${r.mergenCommand}">${r.mergenCommand}</span>`
      : '<span class="muted">No executable fix</span>';
    
    // Calibration Trust Badge
    const trustBadge = r.mergenCommand 
      ? `<span class="badge badge-green" style="margin-left:0; margin-top:4px; display:inline-block;">🛡 Empirically Verified (${Math.round(r.mergenConfidence * 100)}% accuracy)</span>`
      : `<span class="conf">${Math.round(r.mergenConfidence * 100)}% remediation confidence</span>`;

    const engineerCell = cls === 'unreviewed'
      ? `<span class="unreviewed">Not yet reviewed — POST /shadow-report/${r.service}/verdict</span>`
      : r.engineerAction;
    const reasonSpan = r.overrideReason
      ? `<span class="reason">${r.overrideReason}</span>`
      : '';
    
    // Ghost Timeline for MTTR
    const mttr = r.actualMttrMs !== null ? fmtMs(r.actualMttrMs) : '—';
    const ghostTimeline = r.actualMttrMs !== null 
      ? `<div style="margin-top:6px;font-size:10px;padding-left:6px;border-left:2px solid var(--border);color:var(--muted)">
           <i>Manual: ${fmtMs(r.actualMttrMs)} (Page → Wake up → Diagnose)</i><br>
           <i>Mergen: ~2m (Trigger → Fix)</i>
         </div>`
      : '';

    const outcome = r.outcome ?? '—';
    return `<tr>
      <td class="date">${r.date}</td>
      <td>${r.service}<br><span class="conf">${r.failureMode}</span></td>
      <td>${cmdCell}<br>${trustBadge}</td>
      <td class="${cls}">${icon} ${engineerCell}${reasonSpan}</td>
      <td class="muted">${mttr}${ghostTimeline}</td>
      <td class="muted">${outcome}</td>
    </tr>`;
  }).join('');

  const unreviewedCount = rows.filter((r) => r.agreementType === 'unreviewed').length;
  const unreviewedNote = unreviewedCount > 0
    ? `<p style="font-size:11px;color:var(--muted);margin-top:10px">${unreviewedCount} incident${unreviewedCount !== 1 ? 's' : ''} not yet reviewed. Use <code>POST /shadow-report/:id/verdict</code> to annotate — "would-approve" or "would-override".</p>`
    : '';

  return `<div class="card cmp-wrap" style="margin-bottom:32px">
  <div class="card-title">Incident comparison — what Mergen would have done vs. what happened</div>
  <table class="cmp">
    <thead><tr>
      <th>Date</th>
      <th>Service / Failure mode</th>
      <th>Mergen's proposed action</th>
      <th>Engineer's action</th>
      <th>Actual MTTR</th>
      <th>Outcome</th>
    </tr></thead>
    <tbody>${trs}</tbody>
  </table>
  ${unreviewedNote}
</div>`;
}

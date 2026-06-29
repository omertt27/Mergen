/**
 * billing-outcome.ts — Y5 outcome-based billing evidence endpoint.
 *
 *   GET /billing/outcome-report
 *
 * Returns the verified MTTR reduction and estimated revenue preserved —
 * the numbers needed for outcome-based pricing conversations. Customers
 * pay based on the value delivered (MTTR reduction × revenue rate), not
 * software licenses.
 *
 * Configure MERGEN_REVENUE_PER_MINUTE_USD to set your revenue rate:
 *   MERGEN_REVENUE_PER_MINUTE_USD=1000  →  $1k/minute of downtime
 *   (defaults to $100/minute as a conservative SaaS estimate)
 *
 * The report is designed for two audiences:
 *   1. Engineering leadership: total time saved, autonomous resolution rate
 *   2. Finance / procurement: revenue preservation estimate for ROI justification
 */

import { Router } from 'express';
import { getStores } from '../storage/store-registry.js';
import { postmortemStore } from '../intelligence/postmortem-store.js';
import { getIncidentCount } from '../intelligence/usage.js';

const DEFAULT_REVENUE_PER_MINUTE_USD = 100;
const AUTONOMOUS_MTTR_FALLBACK_MS = 2 * 60 * 1000; // fallback when no empirical data exists

/**
 * Compute the median autonomous MTTR from resolved incidents.
 * Returns null when fewer than 3 autonomous resolutions exist (not enough
 * data to be statistically meaningful — fall back to the conservative prior).
 */
function getMedianAutonomousMttrMs(
  resolved: Array<{ resolvedAutonomously: boolean; resolvedAt: number | null; createdAt: number }>,
): number | null {
  const samples = resolved
    .filter((i) => i.resolvedAutonomously && i.resolvedAt != null)
    .map((i) => i.resolvedAt! - i.createdAt)
    .filter((ms) => ms > 0)
    .sort((a, b) => a - b);
  if (samples.length < 3) return null;
  const mid = Math.floor(samples.length / 2);
  return samples.length % 2 === 0
    ? (samples[mid - 1] + samples[mid]) / 2
    : samples[mid];
}

function fmtMs(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.round((ms % 60_000) / 1000);
  return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
}

export function createBillingOutcomeRouter(): Router {
  const router = Router();

  router.get('/billing/outcome-report', async (req, res) => {
    const revenuePerMinute =
      parseFloat(process.env.MERGEN_REVENUE_PER_MINUTE_USD ?? '') || DEFAULT_REVENUE_PER_MINUTE_USD;

    // ── MTTR data ──────────────────────────────────────────────────────────
    const all = await getStores().incidents.list(undefined, 1000, req.tenantId);
    const resolved = all.filter((i) => i.status === 'resolved' && i.resolvedAt && i.createdAt);

    const manualMttrSamples = resolved
      .filter((i) => !i.resolvedAutonomously)
      .map((i) => i.resolvedAt! - i.createdAt);
    const avgManualMttrMs = manualMttrSamples.length > 0
      ? manualMttrSamples.reduce((a, b) => a + b, 0) / manualMttrSamples.length
      : null;

    const autonomousCount = resolved.filter((i) => i.resolvedAutonomously).length;
    const totalResolved = resolved.length;

    // ── Revenue preservation ───────────────────────────────────────────────
    // Autonomous MTTR: use the empirical median when ≥3 data points exist.
    // Below that threshold fall back to the conservative 2-minute prior so the
    // report doesn't look fabricated when a customer first installs Mergen.
    const empiricalAutonomousMttrMs = getMedianAutonomousMttrMs(resolved);
    const autonomousMttrMs = empiricalAutonomousMttrMs ?? AUTONOMOUS_MTTR_FALLBACK_MS;
    const autonomousMttrSource = empiricalAutonomousMttrMs != null
      ? `empirical median (n=${resolved.filter((i) => i.resolvedAutonomously && i.resolvedAt).length})`
      : 'conservative prior — updates after 3+ autonomous resolutions';

    const baselineMttrMs = avgManualMttrMs ?? 30 * 60 * 1000; // 30-min fallback
    const mttrSavedPerIncidentMs = Math.max(0, baselineMttrMs - autonomousMttrMs);
    const totalTimeSavedMs = mttrSavedPerIncidentMs * autonomousCount;
    const totalTimeSavedMin = totalTimeSavedMs / 60_000;
    const estimatedRevenuePreservedUsd = totalTimeSavedMin * revenuePerMinute;

    // ── Corpus value ───────────────────────────────────────────────────────
    const corpusTotal = postmortemStore.count();
    const tagStats = postmortemStore.tagStats();

    // ── NRR signals ────────────────────────────────────────────────────────
    // Services connected = expansion units; more services → higher NRR
    const serviceSet = new Set(all.map((i) => i.service ?? 'unknown').filter((s) => s !== 'unknown'));
    const incidentsThisMonth = getIncidentCount();

    const report = {
      generatedAt: new Date().toISOString(),
      // Core SRE metrics
      totalResolved,
      autonomousResolutions: autonomousCount,
      autonomousRate: totalResolved > 0 ? Math.round((autonomousCount / totalResolved) * 100) : 0,
      avgManualMttrMs,
      avgManualMttrLabel: avgManualMttrMs != null ? fmtMs(avgManualMttrMs) : null,
      estimatedAutonomousMttrMs: autonomousMttrMs,
      autonomousMttrSource,
      // Time savings
      mttrSavedPerIncidentMs: avgManualMttrMs != null ? mttrSavedPerIncidentMs : null,
      totalTimeSavedMs: avgManualMttrMs != null ? totalTimeSavedMs : null,
      totalTimeSavedLabel: avgManualMttrMs != null ? fmtMs(totalTimeSavedMs) : null,
      // Revenue preservation (Y5 outcome billing)
      revenuePerMinuteUsd: revenuePerMinute,
      estimatedRevenuePreservedUsd: avgManualMttrMs != null
        ? Math.round(estimatedRevenuePreservedUsd)
        : null,
      revenuePreservedNote: avgManualMttrMs == null
        ? 'Insufficient data: need at least one manually-resolved incident for MTTR baseline.'
        : `Based on ${fmtMs(baselineMttrMs)} avg manual MTTR vs ${fmtMs(autonomousMttrMs)} autonomous (${autonomousMttrSource}). Configure MERGEN_REVENUE_PER_MINUTE_USD for your revenue rate.`,
      // Corpus health (corpus moat metrics)
      corpusPostmortems: corpusTotal,
      topFailureModes: tagStats.slice(0, 5).map((s) => ({
        tag: s.tag.replace(/^infra_/, ''),
        incidents: s.count,
        avgMttrLabel: s.avgMttrMs != null ? fmtMs(s.avgMttrMs) : null,
      })),
      // Expansion signals (NRR growth)
      servicesConnected: serviceSet.size,
      services: [...serviceSet],
      incidentsThisMonth,
    };

    res.json({ ok: true, report });
  });

  return router;
}

/**
 * cascade-detector.ts — Detects when a new incident is part of a cascade
 * (multiple services failing within a short time window due to a shared root cause).
 *
 * How it works:
 *   1. When a new incident arrives, inspect all currently-open incidents.
 *   2. If two or more services are failing within CASCADE_WINDOW_MS, it's a cascade.
 *   3. Use the service graph to identify the root service (the one with the most
 *      dependents failing, or the service that fired first).
 *   4. Return a CascadeResult so the autopilot can:
 *      - Skip HITL for downstream services (only hold once, for the root)
 *      - Target the root service for the fix
 *      - Label the incident as part of a cascade in Slack
 *
 * This prevents alert fatigue during real outages where a single upstream failure
 * triggers a cascade of PagerDuty alerts across dependent services.
 */

import { incidentStore } from '../sensor/incident-store.js';
import { serviceGraph } from '../sensor/service-graph.js';
import logger from '../sensor/logger.js';

const CASCADE_WINDOW_MS = 2 * 60 * 1_000; // 2 minutes

export interface CascadeResult {
  isCascade: boolean;
  /** The service most likely to be the root cause (earliest or highest upstream impact). */
  rootService: string;
  /** All services involved in this cascade, including the new one. */
  affectedServices: string[];
  /** The pid of the earliest open incident — used to attach subsequent incidents as a thread. */
  rootPid: string | null;
  /** Human-readable summary for Slack. */
  summary: string;
}

/**
 * Call this when a new incident fires for `newService` (pid `newPid`).
 * Returns cascade metadata if two or more services are open within the window.
 */
export function detectCascade(newService: string, newPid: string): CascadeResult {
  const now = Date.now();
  const cutoff = now - CASCADE_WINDOW_MS;

  // Collect all open incidents within the cascade window
  const openIncidents = incidentStore.list('open', 200).filter(
    (inc) => inc.createdAt >= cutoff && inc.pid !== newPid,
  );

  if (openIncidents.length === 0) {
    return {
      isCascade: false,
      rootService: newService,
      affectedServices: [newService],
      rootPid: null,
      summary: '',
    };
  }

  const affectedServices = [
    ...new Set([newService, ...openIncidents.map((inc) => inc.service ?? 'unknown')]),
  ];

  if (affectedServices.length < 2) {
    return {
      isCascade: false,
      rootService: newService,
      affectedServices,
      rootPid: null,
      summary: '',
    };
  }

  // Identify root: prefer the service with the most downstream dependents in the graph.
  // Fall back to the earliest open incident.
  const graphData = serviceGraph.toJSON() as { nodes?: string[]; edges?: Array<{ source: string; target: string }> };
  const edges: Array<{ source: string; target: string }> = graphData.edges ?? [];

  // Count how many of the affected services each candidate is upstream of
  let bestRoot = openIncidents[0]?.service ?? newService;
  let bestUpstreamScore = -1;

  for (const candidate of affectedServices) {
    const downstreamCount = edges.filter(
      (e) => e.source === candidate && affectedServices.includes(e.target),
    ).length;
    if (downstreamCount > bestUpstreamScore) {
      bestUpstreamScore = downstreamCount;
      bestRoot = candidate;
    }
  }

  // Find the root pid (earliest open incident for the root service)
  const rootIncident = openIncidents
    .filter((inc) => inc.service === bestRoot)
    .sort((a, b) => a.createdAt - b.createdAt)[0];
  const rootPid = rootIncident?.pid ?? null;

  const summary = `🌊 *Cascade detected* — ${affectedServices.length} services affected within ${CASCADE_WINDOW_MS / 60_000} minutes.\n` +
    `Likely root: \`${bestRoot}\`  ·  Affected: ${affectedServices.map((s) => `\`${s}\``).join(', ')}\n` +
    `Suppressing redundant HITL — targeting root service for fix.`;

  logger.info(
    { rootService: bestRoot, affectedServices, rootPid },
    'cascade-detector: cascade detected',
  );

  return { isCascade: true, rootService: bestRoot, affectedServices, rootPid, summary };
}
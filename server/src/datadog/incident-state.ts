import type { BlameAttribution } from './blame-attribution.js';

const INCIDENT_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

export interface ActiveIncident {
  service: string;
  traceId: string;
  alertTitle: string;
  alertUrl?: string;
  firedAt: number;
  runtimeFact?: string;
  implicatedFile?: string | null;
  implicatedLine?: number | null;
  /** Confidence-scored causal attribution — set after Datadog trace is fetched. */
  blameAttribution?: BlameAttribution | null;
}

let activeIncident: ActiveIncident | null = null;

export function setActiveIncident(incident: ActiveIncident): void {
  activeIncident = incident;
}

export function getActiveIncident(): ActiveIncident | null {
  if (!activeIncident) return null;
  if (Date.now() - activeIncident.firedAt > INCIDENT_TTL_MS) {
    activeIncident = null;
    return null;
  }
  return activeIncident;
}

export function clearActiveIncident(): void {
  activeIncident = null;
}

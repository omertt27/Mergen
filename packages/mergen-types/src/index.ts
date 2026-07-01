/**
 * @mergen/types — canonical shared types for the Mergen server API.
 *
 * These interfaces define the contract between the Express server and its
 * consumers (VS Code extension, future web clients). Import with `import type`
 * so all declarations are erased at compile time — no runtime overhead.
 */

// ── Activity feed ─────────────────────────────────────────────────────────────

export interface ActivityEvent {
  id:             string;
  timestamp:      number;
  toolName:       string;
  commandArg:     string;
  verdict:        'PASS' | 'BLOCK' | 'HOLD';
  triggeredRules: string[];
  ruleNames:      string[];
}

// ── Health / session signals ──────────────────────────────────────────────────

export interface SessionSignal {
  kind:          string;
  message:       string;
  action:        string;
  count:         number;
  confidence:    number;
  suggestedTool: string;
}

export interface HealthResponse {
  ok:             boolean;
  buffered:       number;
  errors:         number;
  warnings:       number;
  networkErrors:  number;
  signals:        SessionSignal[];
  version:        string;
  [key: string]:  unknown;
}

// ── Usage / billing ───────────────────────────────────────────────────────────

export interface UsageSnapshot {
  planName:                string;
  month:                   string;
  resetsAt:                string;
  used:                    number;
  included:                number | null;
  remaining:               number | null;
  lowCredits:              boolean;
  overage:                 number;
  billingStatus:           'pending' | 'confirmed';
  overagePendingCredits:   number;
  overageCentsPerCredit:   number;
  estimatedOverageCents:   number;
  toolCallCounts?:         Record<string, number>;
  analysesToday?:          number;
  analysesAvgPerDay7d?:    number;
}

// ── Calibration ───────────────────────────────────────────────────────────────

export interface CalibrationStats {
  tag:                string;
  predictions:        number;
  verdicts:           number;
  accuracy:           number;
  trusted:            boolean;
  shouldInterrupt:    boolean;
  accuracy7d:         number | null;
  trendDelta:         number | null;
  commonFailureModes?: Array<{ note: string; count: number }>;
}

export interface CalibrationOverview {
  ok:               boolean;
  overallAccuracy:  number | null;
  trustedDetectors: number;
  totalDetectors:   number;
  perDetector:      CalibrationStats[];
}

// ── Hypothesis / diagnosis ────────────────────────────────────────────────────

export interface Hypothesis {
  tag:             string;
  summary:         string;
  confidence:      'HIGH' | 'MEDIUM' | 'LOW' | 'INSUFFICIENT';
  confidenceScore: number;
  evidence:        string[];
  causalPath:      string[];
  fixHint:         string | null;
  pid?:            string;
  calibration?:    CalibrationStats | null;
}

export interface LastPack {
  hasPack:          boolean;
  builtAt?:         number;
  builtAtIso?:      string;
  triggerMessage?:  string;
  reason?:          string;
  topHypothesis?:   Hypothesis | null;
  hypotheses?:      Hypothesis[];
  contextPack?:     string;
  hypothesesCount?: number;
  errorsCount?:     number;
}

export interface HistoryEntry {
  builtAt:          number;
  builtAtIso:       string;
  triggerMessage:   string;
  reason?:          string;
  topHypothesis:    Hypothesis | null;
}

// ── Timeline ──────────────────────────────────────────────────────────────────

export interface TimelineRow {
  ts:       number;
  isoTs:    string;
  kind:     | 'log' | 'warn' | 'error' | 'request' | 'context'
            | 'terminal' | 'process_exit'
            | 'ci_failure' | 'ci_success'
            | 'deployment' | 'backend_span';
  summary:  string;
  source?:  'browser' | 'backend' | 'ci' | 'deploy';
  sha?:     string;
  confidence?: number;
  traceId?:    string;
}

export interface RootCause {
  hypothesis: string;
  tag:        string;
  confidence: number;
  fixHint:    string | null;
  builtAt?:   number;
}

// ── PR / file intent ──────────────────────────────────────────────────────────

export interface FilePRContext {
  sha:          string;
  prNumber:     number | null;
  prTitle:      string | null;
  author:       string | null;
  approvers:    string[];
  linkedIssues: Array<{ ref: string }>;
  aiGenerated:  boolean;
  aiTool:       string | null;
  mergedAt:     number | null;
  capturedAt:   number;
}

// ── Account ───────────────────────────────────────────────────────────────────

export interface AccountState {
  email:    string | null;
  name:     string | null;
  planId:   string;
  planName: string;
  status:   'active' | 'inactive' | null;
}

// ── Services / interactions ───────────────────────────────────────────────────

export interface ServiceInfo {
  sdk:        string;
  lastSeen:   number;
  errorCount: number;
  spanCount:  number;
}

export interface ServiceInteractions {
  edges:    Array<{ source: string; target: string; weight: number; lastIncidentAt: number }>;
  services: string[];
}

// ── HITL / bypass ────────────────────────────────────────────────────────────

export interface PendingBypass {
  token:      string;
  toolName:   string;
  commandArg: string;
  expiresAt:  number;
}

// ── Unified dashboard response ────────────────────────────────────────────────

export interface UnifiedDashboardResponse {
  health:          HealthResponse;
  usage:           UsageSnapshot;
  lastPack:        LastPack;
  history:         HistoryEntry[];
  calibration:     CalibrationOverview;
  timelineUnified: { rows: TimelineRow[]; rootCause: RootCause | null };
  services:        Record<string, ServiceInfo> | null;
  interactions:    ServiceInteractions | null;
  pendingBypasses: PendingBypass[] | null;
  activity?:       ActivityEvent[];
  policies?: {
    enabled: boolean;
    rules: Array<{
      id: string;
      name: string;
      description: string;
      action: 'block' | 'warn' | 'pass';
      triggerCount: number;
      immutable: boolean;
    }>;
  };
  gateCovers?: {
    hardBlocks: string[];
    humanReviewRequired: string[];
    totalPatterns: number;
  };
  securityMetrics?: {
    protectedActions: number;
    blockedActions: number;
    approvalsRequested: number;
    shadowViolations: number;
    latencyMs?: number;
  };
}

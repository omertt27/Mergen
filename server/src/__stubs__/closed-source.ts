/**
 * Generic stub for closed-source intelligence modules that are gitignored and
 * don't exist on disk in CI.  vitest.config.ts aliases any unrecognised
 * intelligence/*.js import here so Vite can resolve the module graph.
 *
 * Tests that exercise specific behaviour use vi.mock() or vi.doMock() to
 * replace individual exports — this stub is only ever executed when no mock
 * intercepts first.
 *
 * Critical: billingRouter and teamRouter MUST be valid Express middleware
 * because app.ts calls app.use() with them at startup time.  Everything else
 * can be a no-op; route handlers that reference other exports are only invoked
 * when the matching route is hit, which doesn't happen in the pagerduty test.
 */

import { Router } from 'express';

const r = Router();
const noop = (): void => {};
const noopAsync = (): Promise<void> => Promise.resolve();

// ── Express routers (called at app startup via app.use()) ─────────────────────
export const billingRouter = r;
export const teamRouter    = r;

// ── Init/shutdown lifecycle functions ─────────────────────────────────────────
export const initTeam              = noopAsync;
export const broadcastToTeam       = noop;
export const initUsage             = noopAsync;
export const flushOverageOnShutdown = noopAsync;
export const initLicense           = noopAsync;
export const initTelemetry         = noopAsync;
export const maybeSendTelemetry    = noopAsync;
export const uploadCalibrationBatch = noopAsync;

// ── Plan / license accessors ──────────────────────────────────────────────────
export const getActivePlanId = (): string => 'free';
export const getPlan = (): Record<string, unknown> => ({ bufferSize: 2000, name: 'free' });

const _PLAN_RANK: Record<string, number> = {
  free: 0,
  starter: 1, solo_starter: 1,
  team: 2, solo_pro: 2,
  platform: 3, solo_power: 3,
  enterprise: 4, pay_as_you_go: 4,
};
const _rank = (planId?: string): number => _PLAN_RANK[planId ?? ''] ?? 0;
const _minRankForGate = (gate: string): number =>
  gate === 'free' || gate === 'all' ? 0 : gate === 'pro' ? 1 : (_PLAN_RANK[gate] ?? 0);

export const PLAN_ORDER = ['free', 'starter', 'team', 'platform', 'enterprise'];
export const getPlanRank = (planId?: string): number => _rank(planId);
export const planMeetsMin = (planId: string | undefined, minPlanId: string): boolean =>
  _rank(planId) >= _rank(minPlanId);
export const minPlanForGate = (gate: string): string =>
  gate === 'free' || gate === 'all' ? 'free' : gate === 'pro' ? 'starter' : gate;
export const planAllowsGate = (planId: string | undefined, gate: string): boolean =>
  _rank(planId) >= _minRankForGate(gate);
export const planHasCapability = (_planId: string | undefined, _cap: string): boolean => false;
export const planAllowsTier = (planId: string | undefined, tier: string): boolean =>
  planAllowsGate(planId, tier);

// ── Usage accessors ───────────────────────────────────────────────────────────
export const getIncidentCount       = (): number => 0;
export const getUsageSnapshot       = (): Record<string, unknown> => ({});
export const recordExplainWhyFeedback = noopAsync;

// ── Team state ────────────────────────────────────────────────────────────────
export const getTeamState   = (): Record<string, unknown> => ({ members: [] });
export const isTeamEnabled  = (): boolean => false;

// ── Telemetry state ───────────────────────────────────────────────────────────
export const getTelemetryState  = (): Record<string, unknown> => ({ enabled: false, installId: 'stub' });
export const setTelemetryEnabled = noopAsync;

// ── Tool registry ─────────────────────────────────────────────────────────────
export const registerTools          = noop;
export const toolCallCounts         = {} as Record<string, number>;
export const lastMcpCallAt          = null;
export const firstAnalyzeAt         = null;
export const lastTimeToFirstAnalysisMs = null;

// ── Hypothesis history ────────────────────────────────────────────────────────
export const hypothesisHistory = {
  list:                    (): unknown[] => [],
  latest:                  (): null => null,
  clear:                   noop,
  notifyError:             noop,
  add:                     noop,
  size:                    (): number => 0,
  _rebuildNowForTesting:   noopAsync,
};

// ── Calibration (fallback — specific stub in __stubs__/calibration.ts wins) ───
export const getStats    = (): null => null;
export const getRecords  = (): unknown[] => [];
export const recordVerdict = noop;
export const getStatsForTag = (): null => null;

// ── Session-level utilities ───────────────────────────────────────────────────
export const listActiveSessions = (): unknown[] => [];
export const SYSTEM_PROMPT      = '';

// ── AI integrations (github webhook, PR analysis) ────────────────────────────
export const analyzeCommit       = noopAsync;
export const postPRComment       = noopAsync;
export const analyzePRShadow     = noopAsync;
export const getSessionMetrics   = (): Record<string, unknown> => ({});
export const getUnclassified     = (): unknown[] => [];
export const slackRoutingRouter  = r;

// ── License accessors ─────────────────────────────────────────────────────────
export const getLicenseState    = (): Record<string, unknown> => ({});
export const activateKey        = (_key: string): Promise<Record<string, unknown>> => Promise.resolve({});
export const deactivateKey      = noopAsync;
export const planFromVariantId  = (_v: unknown): string => 'free';
export const PLANS              = { free: { bufferSize: 2000, name: 'free', backendObservability: true } } as Record<string, unknown>;

// ── Usage billing ─────────────────────────────────────────────────────────────
export const consumeCredit   = (): Promise<{ allowed: boolean }> => Promise.resolve({ allowed: true });
export const consumeIncident = (): Promise<{ allowed: boolean }> => Promise.resolve({ allowed: true });
export const recordExplainWhy = noop;
export const _resetForTesting = noop;
export const _setSleepForTesting = noop;

// ── Anomaly / baseline ────────────────────────────────────────────────────────
export const computeAnomaly        = (): Promise<{ summary: string }> => Promise.resolve({ summary: '' });
export const getAnomalousPatterns  = (): Promise<unknown[]> => Promise.resolve([]);

// ── Error fingerprinting ──────────────────────────────────────────────────────
export const computeErrorFrequency   = (_logs: unknown[]): unknown[] => [];
export const computeNetworkFrequency = (_net: unknown[]): unknown[] => [];
export const normaliseMessage        = (msg: string): string => msg;

// ── Detectors ─────────────────────────────────────────────────────────────────
export const scoreToConfidence = (score: number): string =>
  score >= 0.8 ? 'high' : score >= 0.5 ? 'medium' : 'low';

// ── Repro steps ───────────────────────────────────────────────────────────────
export const generateReproSteps = (): { confidence: string; markdown: string; steps: string[] } =>
  ({ confidence: 'low', markdown: '', steps: [] });
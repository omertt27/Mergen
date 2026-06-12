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
export const hypothesisHistory = { getAll: () => [], add: noop };

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
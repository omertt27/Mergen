/**
 * calibration-persistence.test.ts
 *
 * Regression tests for failure modes in the calibration persistence layer.
 * These complement calibration.test.ts which covers the happy-path classification
 * logic. Here we exercise the failure conditions that only matter once records
 * are written to disk.
 *
 * Tests:
 *   1. Orphaned .tmp.{PID} file (kill-9 simulation) — load() reads the main
 *      CALIBRATION_FILE, not the abandoned tmp file.
 *   2. Pending-feedback TTL is preserved at 7 days after the PENDING/LABELED split.
 *   3. Labeled records survive 90 days (LABELED_TTL_MS), not 7 days.
 *   4. recordVerdict() extends expiresAt to 90 days from verdict time.
 *
 * Architecture note:
 *   The calibration module imports CALIBRATION_FILE as a module-level constant
 *   from paths.ts. Redirecting it to a temp path requires vi.doMock() +
 *   vi.resetModules() + a fresh dynamic import — hoisted vi.mock() alone is not
 *   sufficient because the constant is bound at module load time.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// ── Temp filesystem setup ─────────────────────────────────────────────────────

let tmpDir:    string;
let calibFile: string;

beforeEach(() => {
  tmpDir    = fs.mkdtempSync(path.join(os.tmpdir(), 'mergen-cal-test-'));
  calibFile = path.join(tmpDir, 'calibration.json');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.useRealTimers();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Fresh import of calibration module with paths redirected to temp dir. */
async function freshCalibration() {
  vi.resetModules();
  vi.doMock('../sensor/paths.js', () => ({
    CALIBRATION_FILE:  calibFile,
    DATA_DIR:          tmpDir,
    USER_RUNBOOKS_DIR: path.join(tmpDir, 'runbooks'),
    zeroRetentionMode: () => false,
    TOPOLOGY_FILE:     path.join(tmpDir, 'topology.json'),
    SHADOW_LOG_FILE:   path.join(tmpDir, 'shadow.json'),
    OVERRIDE_CORPUS_FILE: path.join(tmpDir, 'override-corpus.json'),
    SECRET_FILE:       path.join(tmpDir, 'secret'),
    SESSION_FILE:      path.join(tmpDir, 'session.json'),
    SESSIONS_DIR:      path.join(tmpDir, 'sessions'),
    AUDIT_LOG:         path.join(tmpDir, 'audit.log'),
    HISTORY_DB:        path.join(tmpDir, 'history.db'),
    POSTMORTEMS_DB:    path.join(tmpDir, 'postmortems.db'),
    LICENSE_FILE:      path.join(tmpDir, 'license.json'),
    USAGE_FILE:        path.join(tmpDir, 'usage.json'),
    TEAM_FILE:         path.join(tmpDir, 'team.json'),
    TELEMETRY_FILE:    path.join(tmpDir, 'telemetry.json'),
  }));
  return import('../intelligence/calibration.js');
}

function writtenRecordToFile(records: object[]): void {
  fs.writeFileSync(calibFile, JSON.stringify({ version: 1, records }), 'utf8');
}

function recordEntry(overrides: object = {}): object {
  return {
    pid: `pid-${Math.random().toString(36).slice(2)}`,
    tag: 'disk_full',
    confidence: 'HIGH',
    confidenceScore: 0.94,
    predictedAt: new Date(Date.now() - 60_000).toISOString(),
    verdict: 'correct',
    verdictAt: new Date(Date.now() - 30_000).toISOString(),
    note: null,
    verdictDimension: null,
    expiresAt: Date.now() + 90 * 24 * 60 * 60 * 1000,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('calibration persistence: kill-9 / orphan .tmp file', () => {
  it('load() reads CALIBRATION_FILE and ignores an orphan .tmp.{PID} file', async () => {
    // Last clean state — one record tagged 'disk_full'
    writtenRecordToFile([recordEntry({ tag: 'disk_full', pid: 'good-pid-1' })]);

    // Orphan tmp file from a crashed process — different content (different tag)
    const orphanPath = `${calibFile}.tmp.99999`;
    fs.writeFileSync(orphanPath, JSON.stringify({
      version: 1,
      records: [recordEntry({ tag: 'injected_by_orphan', pid: 'orphan-pid-1' })],
    }), 'utf8');

    // Do NOT call _resetForTesting() here — the module was just freshly imported
    // via vi.resetModules(), so _loaded = false by default. Calling _resetForTesting()
    // would set _loaded = true, bypassing the disk read we're trying to test.
    const { getStats } = await freshCalibration();

    const stats = getStats(); // triggers load() → reads calibFile

    // Main file content is loaded
    expect(stats.find((s: { tag: string }) => s.tag === 'disk_full')).toBeTruthy();
    // Orphan content is NOT loaded
    expect(stats.find((s: { tag: string }) => s.tag === 'injected_by_orphan')).toBeUndefined();
    // Orphan file still on disk (not auto-cleaned — known, accepted)
    expect(fs.existsSync(orphanPath)).toBe(true);
  });

  it('load() starts fresh when CALIBRATION_FILE does not exist, even if an orphan tmp file does', async () => {
    // Only the orphan exists — CALIBRATION_FILE was never successfully written
    const orphanPath = `${calibFile}.tmp.12345`;
    fs.writeFileSync(orphanPath, JSON.stringify({
      version: 1,
      records: [recordEntry({ tag: 'should_not_appear' })],
    }), 'utf8');

    expect(fs.existsSync(calibFile)).toBe(false);

    // Fresh module — _loaded = false, no _resetForTesting() needed.
    const { getStats } = await freshCalibration();

    const stats = getStats(); // triggers load() → CALIBRATION_FILE absent → seeds

    // Orphan not loaded
    expect(stats.find((s: { tag: string }) => s.tag === 'should_not_appear')).toBeUndefined();
    // Seeds ARE loaded because CALIBRATION_FILE didn't exist — fresh start
    expect(stats.find((s: { tag: string }) => s.tag === 'disk_full')).toBeTruthy();
  });
});

describe('calibration persistence: TTL semantics', () => {
  it('getPendingFeedback() still expires after 30 days (PENDING_TTL_MS extended)', async () => {
    const { recordPrediction, getPendingFeedback, _resetForTesting } = await freshCalibration();
    _resetForTesting();

    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    recordPrediction([{ tag: 'pending_test', summary: 's', confidence: 'HIGH',
      confidenceScore: 0.9, evidence: [], causalPath: [], fixHint: null }]);

    // At t+29d: still pending
    vi.setSystemTime(now + 29 * 24 * 60 * 60 * 1000);
    expect(getPendingFeedback()).toHaveLength(1);

    // At t+31d: pending TTL elapsed — no longer pending
    vi.setSystemTime(now + 31 * 24 * 60 * 60 * 1000);
    expect(getPendingFeedback()).toHaveLength(0);
  });

  it('recordVerdict() sets expiresAt to 90 days from NOW, not from prediction time', async () => {
    const { recordPrediction, recordVerdict, getRecords, _resetForTesting } = await freshCalibration();
    _resetForTesting();

    vi.useFakeTimers();
    const t0 = Date.now();
    vi.setSystemTime(t0);

    const [tagged] = recordPrediction([{
      tag: 'ttl_check', summary: 's', confidence: 'HIGH',
      confidenceScore: 0.9, evidence: [], causalPath: [], fixHint: null,
    }]);

    // Give verdict 6 days later — one day before PENDING_TTL_MS would expire
    const verdictTime = t0 + 6 * 24 * 60 * 60 * 1000;
    vi.setSystemTime(verdictTime);
    recordVerdict(tagged.pid!, 'wrong');

    const recs = getRecords();
    const rec  = recs.find((r: { pid: string }) => r.pid === tagged.pid);
    expect(rec).toBeTruthy();

    const expectedExpiry = verdictTime + 90 * 24 * 60 * 60 * 1000;
    expect(rec!.expiresAt).toBeGreaterThanOrEqual(expectedExpiry - 2_000);
    expect(rec!.expiresAt).toBeLessThanOrEqual(expectedExpiry + 2_000);
  });

  it('a labeled record given a verdict at day 3 would expire at day 93 (not day 7)', async () => {
    // This asserts the intended behavior of the expiresAt extension.
    // The 7-day cliff bug would have caused the record to expire at day 7
    // regardless of when the verdict was given. After the fix, expiry is
    // 90 days from verdict time.
    const { recordPrediction, recordVerdict, getRecords, _resetForTesting } = await freshCalibration();
    _resetForTesting();

    vi.useFakeTimers();
    const t0 = Date.now();
    vi.setSystemTime(t0);

    const [tagged] = recordPrediction([{
      tag: 'survival_check', summary: 's', confidence: 'HIGH',
      confidenceScore: 0.9, evidence: [], causalPath: [], fixHint: null,
    }]);

    // Give verdict at day 3
    vi.setSystemTime(t0 + 3 * 24 * 60 * 60 * 1000);
    recordVerdict(tagged.pid!, 'correct');

    const rec = getRecords().find((r: { pid: string }) => r.pid === tagged.pid);
    expect(rec).toBeTruthy();

    const LABELED_TTL_MS = 90 * 24 * 60 * 60 * 1000;
    const PENDING_TTL_MS =  7 * 24 * 60 * 60 * 1000;

    // Under the old 7-day TTL (bug): expiresAt ≈ t0 + PENDING_TTL_MS
    const oldBuggyExpiry = t0 + PENDING_TTL_MS; // day 7

    // Under the correct 90-day labeled TTL (fix): expiresAt ≈ (t0+3days) + 90days
    const correctExpiry  = (t0 + 3 * 24 * 60 * 60 * 1000) + LABELED_TTL_MS; // day 93

    // The actual expiresAt must be near the correct expiry, NOT the buggy one
    expect(rec!.expiresAt).toBeGreaterThan(oldBuggyExpiry + 1_000); // not the 7-day cliff
    expect(rec!.expiresAt).toBeGreaterThanOrEqual(correctExpiry - 2_000); // near 93 days
    expect(rec!.expiresAt).toBeLessThanOrEqual(correctExpiry + 2_000);
  });

  it('a prediction survives to receive a verdict on day 10 under the extended TTL (30 days)', async () => {
    const { recordPrediction, recordVerdict, getRecords, _resetForTesting } = await freshCalibration();
    _resetForTesting();

    vi.useFakeTimers();
    const t0 = Date.now();
    vi.setSystemTime(t0);

    const [tagged] = recordPrediction([{
      tag: 'day_10_survival', summary: 's', confidence: 'HIGH',
      confidenceScore: 0.95, evidence: [], causalPath: [], fixHint: null,
    }]);

    // Fast-forward past the old 7-day cliff to day 10
    const day10 = t0 + 10 * 24 * 60 * 60 * 1000;
    vi.setSystemTime(day10);

    // Call recordVerdict on day 10. Under the old 7-day TTL this would have expired or failed.
    // Here it should succeed and extend expiry to day 10 + 90 days = day 100
    const res = recordVerdict(tagged.pid!, 'correct');
    expect(res.found).toBe(true);

    const recs = getRecords();
    const rec = recs.find((r: { pid: string }) => r.pid === tagged.pid);
    expect(rec).toBeTruthy();
    expect(rec!.verdict).toBe('correct');
    
    // Expected expiry is day 10 + 90 days
    const expectedExpiry = day10 + 90 * 24 * 60 * 60 * 1000;
    expect(rec!.expiresAt).toBeGreaterThanOrEqual(expectedExpiry - 2000);
    expect(rec!.expiresAt).toBeLessThanOrEqual(expectedExpiry + 2000);
  });
});

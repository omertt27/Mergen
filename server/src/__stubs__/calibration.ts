/**
 * Open-source stub for the closed-source calibration feedback-loop module.
 *
 * Key change from original: all CalibrationRecords are now persisted to
 * ~/.mergen/calibration.json so real verdicts survive server restarts.
 * On startup the calibration classifier is warm-started from the loaded
 * corpus, making the ROC-derived execution threshold genuinely data-driven
 * rather than always falling back to the 0.85 prior.
 */

import fs from 'fs';
import { randomUUID } from 'crypto';
import type { Hypothesis } from './causal.js';
import { calibrationClassifier } from '../intelligence/calibration-classifier.js';
import { invalidateThresholdCache } from '../intelligence/threshold-optimizer.js';
import { CALIBRATION_FILE, DATA_DIR, zeroRetentionMode } from '../sensor/paths.js';
import logger from '../sensor/logger.js';

const MIN_SAMPLES        = 5;
const DEMOTE_THRESHOLD   = 0.5;
const SUPPRESS_THRESHOLD = 0.2;
// PENDING_TTL_MS governs how long an unresolved prediction stays in the
// getPendingFeedback() queue before it's considered stale. 30 days provides
// ample time for human operator review across shifts/sprints.
const PENDING_TTL_MS     = 30 * 24 * 60 * 60 * 1000; // 30 days — pending predictions
// LABELED_TTL_MS governs how long a *verdict-bearing* record is retained for
// classifier training and ROC analysis. 90 days matches the override corpus
// retention window and gives at least a quarter of real production data before
// the first record expires.
const LABELED_TTL_MS     = 90 * 24 * 60 * 60 * 1000; // 90 days — labeled data
const SEED_TTL_MS        = 365 * 24 * 60 * 60 * 1000; // 1 year — built-in priors

export type VerdictDimension = string;

interface CalibrationRecord {
  pid:              string;
  tag:              string;
  confidence:       string;
  confidenceScore:  number;
  predictedAt:      Date;
  verdict:          'correct' | 'wrong' | 'partial' | null;
  verdictAt:        Date | null;
  note:             string | null;
  verdictDimension: string | null;
  expiresAt:        number;
  /** True for synthetic warm-start priors seeded at install time. False for production verdicts. */
  isBuiltinSeed:    boolean;
}

// ── Serialized form (Dates → ISO strings) ─────────────────────────────────────

interface SerializedRecord {
  pid: string; tag: string; confidence: string; confidenceScore: number;
  predictedAt: string; verdict: string | null; verdictAt: string | null;
  note: string | null; verdictDimension: string | null; expiresAt: number;
  /** Optional — absent in files written before this field was added (treated as false). */
  isBuiltinSeed?: boolean;
}

interface PersistedCalibration { version: 1; records: SerializedRecord[] }

// ── In-memory state ───────────────────────────────────────────────────────────

let _records: CalibrationRecord[] = [];
let _loaded   = false;
// True when the active corpus is synthetic priors, not production verdicts.
// Set by _seedBuiltInPriors(); cleared when real labeled records are loaded.
let _corpusIsSeeded = false;

// ── Debounced persistence ─────────────────────────────────────────────────────
// Writes are deferred 1 s after the last mutation — prevents fsync on every
// verdict under high incident volume.

let _persistTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePersist(): void {
  if (zeroRetentionMode()) return;
  if (_persistTimer) clearTimeout(_persistTimer);
  _persistTimer = setTimeout(() => { _persistTimer = null; _persist(); }, 1_000);
}

function _persist(): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const payload: PersistedCalibration = {
      version: 1,
      records: _records.map((r): SerializedRecord => ({
        ...r,
        predictedAt:   r.predictedAt.toISOString(),
        verdictAt:     r.verdictAt?.toISOString() ?? null,
        isBuiltinSeed: r.isBuiltinSeed,
      })),
    };
    const tmp = `${CALIBRATION_FILE}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
    fs.renameSync(tmp, CALIBRATION_FILE);
  } catch (err) {
    logger.warn({ err }, 'calibration: persist failed');
  }
}

// ── Classifier warm-start ─────────────────────────────────────────────────────
// Called on startup after loading persisted records. Bulk-trains the online
// logistic regression from the full labeled corpus so the classifier starts
// calibrated rather than at zero.

function _trainClassifierFromCorpus(): void {
  const tagMap = new Map<string, CalibrationRecord[]>();
  for (const r of _records) {
    if (!r.verdict) continue;
    if (r.isBuiltinSeed) continue; // synthetic priors must not bias the classifier
    const list = tagMap.get(r.tag) ?? [];
    list.push(r);
    tagMap.set(r.tag, list);
  }

  const samples: Array<{
    confidence: number; tagAccuracy: number;
    sampleCount: number; trusted: boolean; isCorrect: boolean;
  }> = [];

  for (const recs of tagMap.values()) {
    const verdicts = recs.length;
    let correct = 0;
    for (const r of recs) {
      if (r.verdict === 'correct') correct += 1;
      else if (r.verdict === 'partial') correct += 0.5;
    }
    const accuracy = correct / verdicts;
    const trusted  = verdicts >= MIN_SAMPLES;

    for (const r of recs) {
      samples.push({
        confidence:  r.confidenceScore,
        tagAccuracy: accuracy,
        sampleCount: verdicts,
        trusted,
        isCorrect:   r.verdict === 'correct' || r.verdict === 'partial',
      });
    }
  }

  if (samples.length >= 10) {
    calibrationClassifier.trainBulk(samples);
  }
  logger.debug(
    { samples: samples.length, totalRecords: _records.length },
    'calibration: classifier warm-started from real corpus (seeds excluded)',
  );
}

// ── Lazy load ─────────────────────────────────────────────────────────────────

function load(): void {
  if (_loaded) return;
  _loaded = true;

  if (zeroRetentionMode()) {
    _seedBuiltInPriors();
    return;
  }

  if (!fs.existsSync(CALIBRATION_FILE)) {
    _seedBuiltInPriors();
    schedulePersist(); // persist seeds so next startup loads them immediately
    _trainClassifierFromCorpus();
    return;
  }

  try {
    const raw = JSON.parse(fs.readFileSync(CALIBRATION_FILE, 'utf8')) as PersistedCalibration;
    if (raw?.version === 1 && Array.isArray(raw.records)) {
      const now = Date.now();
      _records = (raw.records as SerializedRecord[])
        .filter((r) => r.expiresAt > now)
        .map((r): CalibrationRecord => ({
          pid:             r.pid,
          tag:             r.tag,
          confidence:      r.confidence,
          confidenceScore: r.confidenceScore,
          predictedAt:     new Date(r.predictedAt),
          verdict:         r.verdict as CalibrationRecord['verdict'],
          verdictAt:       r.verdictAt ? new Date(r.verdictAt) : null,
          note:            r.note,
          verdictDimension: r.verdictDimension,
          expiresAt:       r.expiresAt,
          isBuiltinSeed:   r.isBuiltinSeed ?? false,
        }));

      // Detect whether the corpus is made up entirely of built-in seeds.
      // Seeds carry isBuiltinSeed=true; real verdicts carry false.
      // Legacy files that predate this field default isBuiltinSeed to false (real data assumed).
      if (_records.length > 0) {
        _corpusIsSeeded = _records.every((r) => r.isBuiltinSeed);
      }

      if (_records.length === 0) {
        _seedBuiltInPriors();
        schedulePersist();
      }
    } else {
      _seedBuiltInPriors();
      schedulePersist();
    }
  } catch (err) {
    logger.warn({ err }, 'calibration: failed to load — seeding built-in priors');
    _seedBuiltInPriors();
    schedulePersist();
  }

  _trainClassifierFromCorpus();
}

// ── Public API ────────────────────────────────────────────────────────────────

export type CalibratedHypothesis = Hypothesis & { pid: string; calibrationAction?: string };

export function _resetForTesting(): void {
  _records = [];
  // Set _loaded = true so subsequent load() calls skip disk reads — tests
  // manage their own state explicitly via seedCalibration().
  _loaded = true;
}

// ── recordPrediction ──────────────────────────────────────────────────────────

export function recordPrediction(hypotheses: Hypothesis[]): CalibratedHypothesis[] {
  load();
  return hypotheses.map((h) => {
    const existing = h.pid ? _records.find((r) => r.pid === h.pid) : null;
    if (existing) return h as CalibratedHypothesis;

    const pid = randomUUID();
    _records.push({
      pid,
      tag:             h.tag,
      confidence:      h.confidence,
      confidenceScore: h.confidenceScore,
      predictedAt:     new Date(),
      verdict:         null,
      verdictAt:       null,
      note:            null,
      verdictDimension: null,
      // Pending predictions expire after PENDING_TTL_MS (30 days). If a verdict
      // is recorded before expiry, recordVerdict() extends expiresAt to
      // LABELED_TTL_MS (90 days) so the labeled record survives for classifier
      // training. The two TTLs serve different purposes and must not be merged.
      expiresAt:       Date.now() + PENDING_TTL_MS,
      isBuiltinSeed:   false,
    });
    schedulePersist();
    return { ...h, pid };
  });
}

// ── recordVerdict ─────────────────────────────────────────────────────────────

export function recordVerdict(
  pid: string,
  verdict: 'correct' | 'wrong' | 'partial',
  note?: string,
  dimension?: string,
): { found: boolean; persisted: boolean } {
  load();
  const rec = _records.find((r) => r.pid === pid);
  if (!rec) return { found: false, persisted: false };

  rec.verdict          = verdict;
  rec.verdictAt        = new Date();
  rec.note             = note ?? null;
  rec.verdictDimension = dimension ?? null;
  rec.isBuiltinSeed    = false; // this is now a real production verdict
  _corpusIsSeeded      = false; // at least one real verdict exists
  // Extend retention: now that this record carries a ground-truth label it is
  // training data, not just a pending notification. Re-stamp expiresAt to
  // LABELED_TTL_MS from NOW so the record survives for 90 days from verdict
  // time regardless of when the original prediction was made.
  rec.expiresAt = Date.now() + LABELED_TTL_MS;

  // Online update: one SGD step on the new labeled sample.
  // getStatsForTag() reads _records in its current state — the verdict we just
  // recorded is included, giving the classifier the most recent accuracy signal.
  const stats = getStatsForTag(rec.tag);
  calibrationClassifier.update(
    rec.confidenceScore,
    stats?.accuracy      ?? 0.5,
    stats?.verdicts      ?? 0,
    stats?.trusted       ?? false,
    verdict === 'correct' || verdict === 'partial',
  );

  // Invalidate the ROC threshold cache — new labeled data may shift the optimum.
  invalidateThresholdCache();

  schedulePersist();
  return { found: true, persisted: true };
}

// ── getRecords ────────────────────────────────────────────────────────────────

export function getRecords(): CalibrationRecord[] {
  load();
  return [..._records];
}

// ── getStats / getStatsForTag ─────────────────────────────────────────────────

export interface TagStats {
  tag:                string;
  predictions:        number;
  verdicts:           number;
  accuracy:           number;
  trusted:            boolean;
  isEmpirical:        boolean;
  shouldInterrupt:    boolean;
  diagnosisAccuracy:  number;
  remediationAccuracy: number;
  trendDelta:         number | null;
  accuracy7d:         number | null;
  commonFailureModes: Array<{ note: string; count: number }>;
}

// Re-exported alias for threshold-optimizer
export type PredictionRecord = CalibrationRecord;

function normalizeNote(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim().replace(/\s+/g, ' ');
}

function _computeTagStats(tag: string, recs: CalibrationRecord[]): TagStats {
  const predictions  = recs.length;
  const withVerdict  = recs.filter((r) => r.verdict !== null);
  const verdicts     = withVerdict.length;

  let correct = 0;
  for (const r of withVerdict) {
    if (r.verdict === 'correct') correct += 1;
    else if (r.verdict === 'partial') correct += 0.5;
  }
  const accuracy = verdicts > 0 ? correct / verdicts : 0;
  const trusted  = verdicts >= MIN_SAMPLES;

  // 7-day accuracy trend
  const cutoff7d = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recent   = withVerdict.filter((r) => r.verdictAt && r.verdictAt.getTime() >= cutoff7d);
  let recentCorrect = 0;
  for (const r of recent) {
    if (r.verdict === 'correct') recentCorrect += 1;
    else if (r.verdict === 'partial') recentCorrect += 0.5;
  }
  const accuracy7d   = recent.length >= 3 ? recentCorrect / recent.length : null;
  const trendDelta   = accuracy7d !== null ? accuracy7d - accuracy : null;

  // Common failure modes from 'wrong' verdict notes
  const noteGroups = new Map<string, { canonical: string; count: number }>();
  for (const r of withVerdict) {
    if (r.note && r.verdict === 'wrong') {
      const key = normalizeNote(r.note);
      const ex  = noteGroups.get(key);
      if (ex) ex.count++;
      else noteGroups.set(key, { canonical: r.note, count: 1 });
    }
  }
  const commonFailureModes = [...noteGroups.values()]
    .sort((a, b) => b.count - a.count)
    .map(({ canonical, count }) => ({ note: canonical, count }));

  return {
    tag, predictions, verdicts, accuracy, trusted,
    isEmpirical:        trusted,
    shouldInterrupt:    trusted && accuracy < SUPPRESS_THRESHOLD,
    diagnosisAccuracy:  accuracy,
    remediationAccuracy: accuracy * 0.7,
    trendDelta,
    accuracy7d,
    commonFailureModes,
  };
}

export function getStats(): TagStats[] {
  load();
  const tagMap = new Map<string, CalibrationRecord[]>();
  for (const r of _records) {
    const list = tagMap.get(r.tag) ?? [];
    list.push(r);
    tagMap.set(r.tag, list);
  }
  return [...tagMap.entries()].map(([tag, recs]) => _computeTagStats(tag, recs));
}

export function getGlobalStats(): null { return null; }

/**
 * Returns true when the active corpus consists entirely of built-in synthetic
 * priors — i.e., no production verdicts have been recorded yet (or all have
 * expired). When true, accuracy numbers shown to agents are estimates, not
 * empirical measurements from this system's production history.
 */
export function isCorpusSeeded(): boolean {
  load();
  return _corpusIsSeeded;
}

export function getStatsForTag(tag: string): TagStats | undefined {
  load();
  const recs = _records.filter((r) => r.tag === tag);
  if (recs.length === 0) return undefined;
  return _computeTagStats(tag, recs);
}

// ── applyCalibration ──────────────────────────────────────────────────────────

export function applyCalibration(
  hypotheses: Hypothesis[],
): { active: CalibratedHypothesis[]; suppressed: CalibratedHypothesis[] } {
  load();
  const active: CalibratedHypothesis[]      = [];
  const suppressed: CalibratedHypothesis[]  = [];

  for (const h of hypotheses) {
    const stats = getStatsForTag(h.tag);

    if (!stats || !stats.trusted) {
      active.push({ ...h, calibrationAction: 'passed' } as CalibratedHypothesis);
      continue;
    }

    if (stats.accuracy >= DEMOTE_THRESHOLD) {
      active.push({ ...h, calibrationAction: 'passed' } as CalibratedHypothesis);
    } else if (stats.accuracy >= SUPPRESS_THRESHOLD) {
      const demoted: CalibratedHypothesis = {
        ...h,
        confidence:      h.confidence === 'HIGH' ? 'MEDIUM' : (h.confidence === 'MEDIUM' ? 'LOW' : 'LOW'),
        confidenceScore: h.confidenceScore * 0.5,
        calibrationAction: 'demoted',
      } as CalibratedHypothesis;
      active.push(demoted);
    } else {
      suppressed.push({ ...h, calibrationAction: 'suppressed' } as CalibratedHypothesis);
    }
  }

  return { active, suppressed };
}

// ── getPendingFeedback ────────────────────────────────────────────────────────

export function getPendingFeedback(): Array<{ pid: string; expiresAt: number }> {
  load();
  const now = Date.now();
  return _records
    .filter((r) => r.verdict === null && r.expiresAt > now)
    .map((r) => ({ pid: r.pid, tag: r.tag, expiresAt: r.expiresAt }));
}

// ── seedCalibration (test helper) ─────────────────────────────────────────────

export function seedCalibration(
  tag: string,
  counts: { correct?: number; wrong?: number; partial?: number },
): void {
  load();
  const { correct = 0, wrong = 0, partial = 0 } = counts;

  const addRecords = (count: number, verdict: 'correct' | 'wrong' | 'partial') => {
    for (let i = 0; i < count; i++) {
      _records.push({
        pid: randomUUID(), tag,
        confidence: 'HIGH', confidenceScore: 0.9,
        predictedAt: new Date(Date.now() - 60_000),
        verdict, verdictAt: new Date(),
        note: null, verdictDimension: null,
        expiresAt: Date.now() + LABELED_TTL_MS, // already labeled — use retention TTL
        isBuiltinSeed: false,
      });
    }
  };

  addRecords(correct, 'correct');
  addRecords(wrong, 'wrong');
  addRecords(partial, 'partial');
  schedulePersist();
}

// ── exportCsv ─────────────────────────────────────────────────────────────────

import { createHash } from 'crypto';

function csvQuote(s: string | null): string {
  if (s === null || s === undefined) return '';
  if (!/[",\n\r]/.test(s)) return s;
  return '"' + s.replace(/"/g, '""') + '"';
}

export function exportCsv(): string {
  load();
  const header = 'pid,tag,confidence,predictedAt,verdict,verdictAt,note,verdictDimension';
  const rows = _records.map((r) => [
    r.pid, r.tag, r.confidence,
    r.predictedAt.toISOString(),
    r.verdict ?? '',
    r.verdictAt ? r.verdictAt.toISOString() : '',
    csvQuote(r.note),
    r.verdictDimension ?? '',
  ].join(','));

  const dataBlock = rows.length > 0 ? rows.join('\n') : '';
  const sha256    = createHash('sha256').update(dataBlock).digest('hex');
  const comment   = `# rows: ${rows.length}, sha256: ${sha256}`;

  if (rows.length === 0) return `${comment}\n${header}`;
  return `${comment}\n${header}\n${dataBlock}\n`;
}

export const CALIBRATION_CONFIG: Record<string, unknown> = {};

// ── Built-in priors (synthetic warm-start) ────────────────────────────────────
// Only runs when no persisted corpus exists. After the first persist() call
// these synthetic records are saved alongside any real verdicts, so subsequent
// restarts load from disk instead of re-seeding from scratch.

function _seedBuiltInPriors(): void {
  if (_records.length > 0) return;
  _corpusIsSeeded = true;

  const DAY  = 24 * 60 * 60 * 1000;
  const seeds: Array<[string, number, number]> = [
    ['auth_token_not_persisted',      17,  3],
    ['disk_full',                     19,  1],
    ['memory_leak_oom',               23,  2],
    ['deployment_induced_regression', 22,  3],
    ['missing_env_var',               20,  2],
    ['unhandled_promise_rejection',   22,  2],
    ['connection_refused',            19,  3],
    ['rate_limit_silent',             18,  4],
    ['cors_preflight_failure',        20,  4],
    ['jwt_expiry',                    21,  3],
    ['n_plus_one_query',              15,  6],
    ['health_check_degraded',         18,  5],
    ['stale_cache',                   14,  6],
    ['cascading_timeout',             17,  6],
    ['connection_pool_exhausted',     19,  5],
    ['session_fixation',              15,  7],
    ['db_migration_lock',             16,  6],
    ['failed_migration',              20,  3],
    ['slow_api_silent',               16,  7],
    ['empty_response_silent',         14,  8],
  ];

  for (const [tag, correct, wrong] of seeds) {
    for (let i = 0; i < correct; i++) {
      _records.push({
        pid: randomUUID(), tag,
        confidence: 'HIGH', confidenceScore: 0.88,
        predictedAt: new Date(Date.now() - Math.floor(Math.random() * 60) * DAY),
        verdict: 'correct',
        verdictAt:   new Date(Date.now() - Math.floor(Math.random() * 59) * DAY),
        note: null, verdictDimension: null,
        expiresAt: Date.now() + SEED_TTL_MS,
        isBuiltinSeed: true,
      });
    }
    for (let i = 0; i < wrong; i++) {
      _records.push({
        pid: randomUUID(), tag,
        confidence: 'HIGH', confidenceScore: 0.88,
        predictedAt: new Date(Date.now() - Math.floor(Math.random() * 60) * DAY),
        verdict: 'wrong',
        verdictAt:   new Date(Date.now() - Math.floor(Math.random() * 59) * DAY),
        note: null, verdictDimension: null,
        expiresAt: Date.now() + SEED_TTL_MS,
        isBuiltinSeed: true,
      });
    }
  }
}

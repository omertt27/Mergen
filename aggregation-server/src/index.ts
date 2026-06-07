/**
 * Mergen Calibration Corpus Aggregation Server
 *
 * Cloudflare Worker that receives anonymous calibration verdicts from Mergen
 * installations and returns cross-installation accuracy stats.
 *
 * Privacy design:
 *   - Receives: tag, verdict, verdictDimension (from CSV)
 *   - Ignores: pid, note, confidence_score, predictedAt, verdictAt
 *   - Stores: per-tag aggregated counts only — no individual verdicts
 *   - Never stores: install IDs beyond rate-limit TTL (1 hour)
 *
 * API:
 *   POST /corpus          — receive calibration CSV, return global stats
 *   GET  /stats           — current global stats (public, cached)
 *   GET  /admin/stats     — per-tag breakdown (requires CORPUS_ADMIN_KEY header)
 *   POST /telemetry       — receive usage snapshot (stored in aggregate only)
 *
 * KV schema:
 *   tag:<name>            — TagCounts JSON
 *   stats:cached          — cached stats response JSON (TTL 300s)
 *   ratelimit:<installId> — "1" with TTL 3600s (rate limiting per install)
 *   telemetry:daily       — DailyTelemetry JSON (aggregated usage)
 */

export interface Env {
  CALIBRATION_KV: KVNamespace;
  CORPUS_ADMIN_KEY?: string;
}

// ── Data types ────────────────────────────────────────────────────────────────

interface TagCounts {
  /** Weighted correct verdicts (correct=1, partial=0.5, wrong=0). */
  weightedScore: number;
  totalVerdicts: number;
  /** Diagnosis-specific (verdictDimension=root_cause|both). */
  diagnosisWeightedScore: number;
  diagnosisTotalVerdicts: number;
  /** Remediation-specific (verdictDimension=fix_hint|both). */
  remediationWeightedScore: number;
  remediationTotalVerdicts: number;
  updatedAt: number;
}

interface StatsResponse {
  stats: GlobalStat[];
  generatedAt: number;
  totalInstallations: number;
}

interface GlobalStat {
  tag: string;
  globalAccuracy: number;
  sampleCount: number;
  diagnosisAccuracy: number | null;
  remediationAccuracy: number | null;
}

interface DailyTelemetry {
  installations: number;
  toolCalls: Record<string, number>;
  date: string;
}

// ── CSV parsing ───────────────────────────────────────────────────────────────

type VerdictDimension = 'root_cause' | 'fix_hint' | 'both';
type Verdict = 'correct' | 'partial' | 'wrong';

interface CsvRow {
  tag: string;
  verdict: Verdict;
  verdictDimension: VerdictDimension | null;
}

function parseCsv(csv: string): CsvRow[] {
  const lines = csv.split('\n').map((l) => l.trim());
  const rows: CsvRow[] = [];

  let headerLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('pid,')) { headerLine = i; break; }
  }
  if (headerLine === -1) return rows;

  const header = lines[headerLine].split(',');
  const tagIdx = header.indexOf('tag');
  const verdictIdx = header.indexOf('verdict');
  const dimIdx = header.indexOf('verdictDimension');

  if (tagIdx === -1 || verdictIdx === -1) return rows;

  for (let i = headerLine + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.startsWith('#')) continue;

    const cols = splitCsvLine(line);
    const tag = cols[tagIdx]?.trim();
    const verdict = cols[verdictIdx]?.trim() as Verdict;
    const dim = dimIdx !== -1 ? (cols[dimIdx]?.trim() || null) as VerdictDimension | null : null;

    // Validate — only accept known tags and verdicts
    if (!tag || !isValidTag(tag)) continue;
    if (verdict !== 'correct' && verdict !== 'partial' && verdict !== 'wrong') continue;

    rows.push({ tag, verdict, verdictDimension: dim });
  }

  return rows;
}

function splitCsvLine(line: string): string[] {
  const cols: string[] = [];
  let cur = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if (c === ',' && !inQuotes) {
      cols.push(cur); cur = '';
    } else {
      cur += c;
    }
  }
  cols.push(cur);
  return cols;
}

// Allowlist of valid detector tag prefixes — prevents arbitrary key injection
const VALID_TAG_PREFIXES = [
  'infra_', 'browser_', 'runtime_', 'deploy_', 'ci_',
  'db_', 'network_', 'auth_', 'queue_', 'cert_',
];

function isValidTag(tag: string): boolean {
  if (tag.length > 80) return false;
  if (!/^[a-z][a-z0-9_]{2,79}$/.test(tag)) return false;
  return VALID_TAG_PREFIXES.some((p) => tag.startsWith(p));
}

function verdictWeight(v: Verdict): number {
  return v === 'correct' ? 1 : v === 'partial' ? 0.5 : 0;
}

// ── KV helpers ────────────────────────────────────────────────────────────────

async function getTagCounts(kv: KVNamespace, tag: string): Promise<TagCounts> {
  const raw = await kv.get(`tag:${tag}`, 'json') as TagCounts | null;
  return raw ?? {
    weightedScore: 0, totalVerdicts: 0,
    diagnosisWeightedScore: 0, diagnosisTotalVerdicts: 0,
    remediationWeightedScore: 0, remediationTotalVerdicts: 0,
    updatedAt: 0,
  };
}

async function incrementTagCounts(kv: KVNamespace, rows: CsvRow[]): Promise<void> {
  // Group rows by tag so we do one KV read+write per tag
  const byTag = new Map<string, CsvRow[]>();
  for (const row of rows) {
    const list = byTag.get(row.tag) ?? [];
    list.push(row);
    byTag.set(row.tag, list);
  }

  // Process each tag — read current counts, add new data, write back
  const writes: Promise<void>[] = [];
  for (const [tag, tagRows] of byTag) {
    const p = (async () => {
      const counts = await getTagCounts(kv, tag);
      for (const row of tagRows) {
        const w = verdictWeight(row.verdict);
        counts.weightedScore += w;
        counts.totalVerdicts += 1;
        const dim = row.verdictDimension;
        if (dim === 'root_cause' || dim === 'both' || dim === null) {
          counts.diagnosisWeightedScore += w;
          counts.diagnosisTotalVerdicts += 1;
        }
        if (dim === 'fix_hint' || dim === 'both' || dim === null) {
          counts.remediationWeightedScore += w;
          counts.remediationTotalVerdicts += 1;
        }
      }
      counts.updatedAt = Date.now();
      await kv.put(`tag:${tag}`, JSON.stringify(counts));
    })();
    writes.push(p);
  }

  await Promise.all(writes);
}

async function buildStatsResponse(kv: KVNamespace): Promise<StatsResponse> {
  // List all tag keys
  const list = await kv.list({ prefix: 'tag:' });
  const stats: GlobalStat[] = [];

  const reads = list.keys.map(async (k) => {
    const tag = k.name.slice(4); // strip "tag:" prefix
    const counts = await kv.get<TagCounts>(k.name, 'json');
    if (!counts || counts.totalVerdicts < 3) return; // minimum 3 verdicts to surface

    const globalAccuracy = counts.weightedScore / counts.totalVerdicts;
    const diagnosisAccuracy = counts.diagnosisTotalVerdicts >= 3
      ? counts.diagnosisWeightedScore / counts.diagnosisTotalVerdicts
      : null;
    const remediationAccuracy = counts.remediationTotalVerdicts >= 3
      ? counts.remediationWeightedScore / counts.remediationTotalVerdicts
      : null;

    stats.push({ tag, globalAccuracy, sampleCount: counts.totalVerdicts, diagnosisAccuracy, remediationAccuracy });
  });

  await Promise.all(reads);
  stats.sort((a, b) => b.sampleCount - a.sampleCount);

  // Count distinct installations: we don't store install IDs, so use a proxy
  // counter stored separately (incremented on each upload that isn't rate-limited)
  const installCount = parseInt(await kv.get('meta:installations') ?? '0', 10);

  return {
    stats,
    generatedAt: Date.now(),
    totalInstallations: installCount,
  };
}

// ── Rate limiting ─────────────────────────────────────────────────────────────

async function isRateLimited(kv: KVNamespace, installId: string): Promise<boolean> {
  const key = `ratelimit:${installId.slice(0, 36)}`; // UUID length cap
  const existing = await kv.get(key);
  if (existing) return true;
  await kv.put(key, '1', { expirationTtl: 3600 }); // 1 hour window
  return false;
}

// ── CORS headers ──────────────────────────────────────────────────────────────

function corsHeaders(): HeadersInit {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Install-Id',
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

// ── Request handlers ──────────────────────────────────────────────────────────

async function handleCorpus(req: Request, env: Env): Promise<Response> {
  const installId = req.headers.get('X-Install-Id') ?? 'anonymous';

  if (await isRateLimited(env.CALIBRATION_KV, installId)) {
    return json({ ok: false, error: 'rate limited — one upload per hour per installation' }, 429);
  }

  const body = await req.text();
  if (!body || body.length > 512_000) { // 512 KB max
    return json({ ok: false, error: 'body too large or empty' }, 413);
  }

  const rows = parseCsv(body);
  if (rows.length === 0) {
    return json({ ok: true, stats: [] });
  }

  // Only process rows that have verdicts
  const verdictRows = rows.filter((r) => r.verdict);
  if (verdictRows.length > 0) {
    await incrementTagCounts(env.CALIBRATION_KV, verdictRows);
    // Increment installation counter (not tied to install ID for privacy)
    const cur = parseInt(await env.CALIBRATION_KV.get('meta:installations') ?? '0', 10);
    await env.CALIBRATION_KV.put('meta:installations', String(cur + 1));
    // Invalidate stats cache
    await env.CALIBRATION_KV.delete('stats:cached');
  }

  // Return current global stats so caller can update their local prior
  const cached = await env.CALIBRATION_KV.get<StatsResponse>('stats:cached', 'json');
  if (cached) return json({ ok: true, stats: cached.stats });

  const statsResponse = await buildStatsResponse(env.CALIBRATION_KV);
  await env.CALIBRATION_KV.put('stats:cached', JSON.stringify(statsResponse), { expirationTtl: 300 });

  return json({ ok: true, stats: statsResponse.stats });
}

async function handleGetStats(env: Env): Promise<Response> {
  const cached = await env.CALIBRATION_KV.get<StatsResponse>('stats:cached', 'json');
  if (cached) return json(cached);

  const statsResponse = await buildStatsResponse(env.CALIBRATION_KV);
  await env.CALIBRATION_KV.put('stats:cached', JSON.stringify(statsResponse), { expirationTtl: 300 });
  return json(statsResponse);
}

async function handleAdminStats(req: Request, env: Env): Promise<Response> {
  if (!env.CORPUS_ADMIN_KEY) return json({ error: 'admin endpoint not configured' }, 404);
  const provided = req.headers.get('X-Admin-Key');
  if (provided !== env.CORPUS_ADMIN_KEY) return json({ error: 'unauthorized' }, 401);

  const statsResponse = await buildStatsResponse(env.CALIBRATION_KV);
  return json(statsResponse);
}

async function handleTelemetry(req: Request, env: Env): Promise<Response> {
  // Aggregate usage counts — no individual snapshots stored
  const body = await req.json() as {
    toolCallCounts?: Record<string, number>;
    planId?: string;
  };

  const daily = await env.CALIBRATION_KV.get<DailyTelemetry>('telemetry:daily', 'json') ?? {
    installations: 0,
    toolCalls: {},
    date: new Date().toISOString().slice(0, 10),
  };

  daily.installations += 1;
  if (body.toolCallCounts) {
    for (const [tool, count] of Object.entries(body.toolCallCounts)) {
      daily.toolCalls[tool] = (daily.toolCalls[tool] ?? 0) + count;
    }
  }

  await env.CALIBRATION_KV.put('telemetry:daily', JSON.stringify(daily), { expirationTtl: 86400 * 2 });
  return json({ ok: true });
}

// ── Entry point ───────────────────────────────────────────────────────────────

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const method = req.method.toUpperCase();

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (method === 'POST' && url.pathname === '/corpus') {
      return handleCorpus(req, env);
    }

    if (method === 'GET' && url.pathname === '/stats') {
      return handleGetStats(env);
    }

    if (method === 'GET' && url.pathname === '/admin/stats') {
      return handleAdminStats(req, env);
    }

    if (method === 'POST' && url.pathname === '/') {
      return handleTelemetry(req, env);
    }

    if (method === 'GET' && url.pathname === '/health') {
      return json({ ok: true, service: 'mergen-corpus' });
    }

    return json({ error: 'not found' }, 404);
  },
};

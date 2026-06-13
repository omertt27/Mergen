#!/usr/bin/env node
/**
 * seed-corpus.mjs — Seed the eval corpus from production verdicts.
 *
 * Connects to a running Mergen server, fetches calibration verdicts that
 * have been human-verified, and generates TypeScript CorpusEntry objects
 * ready to append to server/src/__tests__/evals/fixtures/corpus.ts.
 *
 * Usage:
 *   node scripts/seed-corpus.mjs
 *   node scripts/seed-corpus.mjs --port 3001
 *   node scripts/seed-corpus.mjs --url http://my-server:3000
 *   node scripts/seed-corpus.mjs --only-new   # skip tags already in corpus
 *   node scripts/seed-corpus.mjs --min-verdicts 3  # minimum verdicts to include
 *
 * Output: TypeScript snippet printed to stdout. Pipe to a file or paste
 * into corpus.ts manually after reviewing.
 *
 * The script builds a minimal InfraEvent for each verdict. For infra tags
 * (infra_*) it can construct the event kind automatically. For browser tags
 * (auth_*, null_*, failed_*) it prints a placeholder — add real events manually.
 */

import { createRequire } from 'module';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const args        = process.argv.slice(2);
const PORT        = Number(args[args.indexOf('--port')  + 1] ?? 3000);
const BASE_URL    = args[args.indexOf('--url')   + 1] ?? `http://127.0.0.1:${PORT}`;
const ONLY_NEW    = args.includes('--only-new');
const MIN_VERDICTS = Number(args[args.indexOf('--min-verdicts') + 1] ?? 1);

// ── ANSI helpers ──────────────────────────────────────────────────────────────
const b = s => `\x1b[1m${s}\x1b[0m`;
const g = s => `\x1b[32m${s}\x1b[0m`;
const r = s => `\x1b[31m${s}\x1b[0m`;
const y = s => `\x1b[33m${s}\x1b[0m`;
const d = s => `\x1b[2m${s}\x1b[0m`;

// ── Tag → InfraEventKind mapping ──────────────────────────────────────────────
const TAG_TO_KIND = {
  infra_db_connection_pool:   'db_connection_pool_exhausted',
  infra_oom_kill:             'oom_kill',
  infra_rate_limit_cascade:   'rate_limit_cascade',
  infra_slow_query:           'slow_query',
  infra_downstream_latency:   'downstream_latency_spike',
  infra_certificate_expiry:   'certificate_expiry',
  infra_disk_pressure:        'disk_pressure',
  infra_queue_backlog:        'queue_backlog',
  infra_service_unavailable:  'service_unavailable',
  infra_upstream_error:       'upstream_error',
};

const BROWSER_TAGS = new Set([
  'auth_token_not_persisted', 'token_overwrite_race',
  'failed_request_caused_crash', 'null_storage_key', 'empty_network_response',
]);

// ── Parse calibration CSV ─────────────────────────────────────────────────────
function parseCsv(csv) {
  const lines = csv.split('\n').filter(l => l && !l.startsWith('#'));
  if (lines.length < 2) return [];
  const headers = lines[0].split(',');

  const records = [];
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    // RFC-4180: handle quoted fields with embedded commas/newlines
    const fields = [];
    let cur = '';
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuote && line[i + 1] === '"') { cur += '"'; i++; }
        else { inQuote = !inQuote; }
      } else if (ch === ',' && !inQuote) {
        fields.push(cur); cur = '';
      } else {
        cur += ch;
      }
    }
    fields.push(cur);

    const rec = {};
    headers.forEach((h, i) => { rec[h] = fields[i] ?? ''; });
    records.push(rec);
  }
  return records;
}

// ── Generate a corpus entry for an infra tag ─────────────────────────────────
function makeInfraEntry(tag, verdict, service = 'unknown-service', message = null) {
  const kind = TAG_TO_KIND[tag];
  const msg = message ?? defaultMessage(tag, service);
  return {
    tag,
    verdict,
    kind,
    service,
    message: msg,
  };
}

function defaultMessage(tag, service) {
  const msgs = {
    infra_db_connection_pool:  `DB connection pool exhausted on \`${service}\``,
    infra_oom_kill:            `OOM killed — exit 137 on \`${service}\``,
    infra_rate_limit_cascade:  `429 Too Many Requests — upstream returned rate limit on \`${service}\``,
    infra_slow_query:          `query exceeded statement_timeout on \`${service}\``,
    infra_downstream_latency:  `downstream p99 latency spike on \`${service}\``,
    infra_certificate_expiry:  `TLS certificate expired on \`${service}\``,
    infra_disk_pressure:       `no space left on device — disk full on \`${service}\``,
    infra_queue_backlog:       `consumer lag growing on \`${service}\``,
    infra_service_unavailable: `upstream connect error — no healthy upstream on \`${service}\``,
    infra_upstream_error:      `production error on \`${service}\``,
  };
  return msgs[tag] ?? `${tag} incident on \`${service}\``;
}

// ── Render TypeScript corpus entry ────────────────────────────────────────────
function renderInfraEntry(entry, index) {
  return `  // entry from production verdict — enrich events with real telemetry data if available
  {
    events: [evt('${entry.kind}', '${entry.service}', ${JSON.stringify(entry.message)})],
    expectedTag: '${entry.tag}',
    verdict: '${entry.verdict}',
  },`;
}

function renderBrowserEntry(tag, verdict, pid) {
  return `  // TODO: add real ConsoleEvent/NetworkEvent/ContextSnapshot for browser tag: ${tag}
  // verdict: ${verdict} (pid: ${pid})
  // {
  //   events: [],  // browser detectors use ConsoleEvent[], not InfraEvent[]
  //   expectedTag: '${tag}',
  //   verdict: '${verdict}',
  // },`;
}

// ── Load existing corpus to detect duplicates ─────────────────────────────────
function loadExistingTags() {
  const corpusPath = resolve(__dirname, '../server/src/__tests__/evals/fixtures/corpus.ts');
  if (!existsSync(corpusPath)) return new Set();
  const content = readFileSync(corpusPath, 'utf8');
  const tags = new Set();
  for (const m of content.matchAll(/expectedTag:\s*'([^']+)'/g)) tags.add(m[1]);
  return tags;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.error(b('seed-corpus.mjs') + ` — connecting to ${BASE_URL}`);

  // 1. Fetch calibration export CSV
  let csv;
  try {
    const res = await fetch(`${BASE_URL}/calibration/export`);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    csv = await res.text();
  } catch (err) {
    console.error(r(`✗ Could not reach ${BASE_URL}/calibration/export: ${err.message}`));
    console.error(d('  Start the server with: mergen-server start'));
    process.exit(1);
  }

  // 2. Parse records — keep only those with verdicts
  const all = parseCsv(csv);
  const verdicted = all.filter(r => r.verdict && r.verdict !== '');

  if (verdicted.length === 0) {
    console.error(y('⚠ No verdicted records found. Submit some feedback first:'));
    console.error(d(`  curl -X POST ${BASE_URL}/feedback -d '{"pid":"<pid>","verdict":"correct"}'`));
    process.exit(0);
  }

  console.error(d(`  Found ${all.length} total records, ${verdicted.length} with verdicts`));

  // 3. Aggregate by tag (deduplicate, pick most common verdict per tag)
  const byTag = {};
  for (const rec of verdicted) {
    const { tag, verdict } = rec;
    if (!tag || !verdict) continue;
    byTag[tag] = byTag[tag] ?? { correct: 0, wrong: 0, partial: 0, pids: [] };
    byTag[tag][verdict] = (byTag[tag][verdict] ?? 0) + 1;
    byTag[tag].pids.push(rec.pid);
  }

  // 4. Filter to tags meeting minimum verdicts
  const qualifying = Object.entries(byTag)
    .filter(([, counts]) => (counts.correct + counts.wrong + counts.partial) >= MIN_VERDICTS);

  const existingTags = ONLY_NEW ? loadExistingTags() : new Set();
  if (ONLY_NEW) console.error(d(`  Skipping ${existingTags.size} tags already in corpus`));

  // 5. Generate TypeScript entries
  const infraEntries = [];
  const browserEntries = [];
  const skipped = [];

  for (const [tag, counts] of qualifying) {
    if (ONLY_NEW && existingTags.has(tag)) { skipped.push(tag); continue; }

    // Choose the most common verdict
    const verdict = counts.correct >= counts.wrong && counts.correct >= counts.partial
      ? 'correct'
      : counts.wrong >= counts.partial
        ? 'wrong'
        : 'partial';

    if (BROWSER_TAGS.has(tag) || (!TAG_TO_KIND[tag] && !BROWSER_TAGS.has(tag))) {
      browserEntries.push({ tag, verdict, pid: counts.pids[0] });
    } else {
      infraEntries.push(makeInfraEntry(tag, verdict));
    }
  }

  if (skipped.length > 0) console.error(d(`  Skipped (already in corpus): ${skipped.join(', ')}`));

  // 6. Print output
  const now = new Date().toISOString().slice(0, 10);
  const totalEntries = infraEntries.length + browserEntries.length;

  if (totalEntries === 0) {
    console.error(y('⚠ No new entries to add.'));
    process.exit(0);
  }

  console.log(`\n  // ── Seeded from production verdicts on ${now} ──────────────────────────────`);
  console.log(`  // ${infraEntries.length} infra entries, ${browserEntries.length} browser entries`);
  console.log(`  // Append these to REPLAY_CORPUS in server/src/__tests__/evals/fixtures/corpus.ts\n`);

  for (let i = 0; i < infraEntries.length; i++) {
    console.log(renderInfraEntry(infraEntries[i], i));
  }

  if (browserEntries.length > 0) {
    console.log('\n  // ── Browser detector stubs (fill in real events) ──────────────────────────');
    for (const entry of browserEntries) {
      console.log(renderBrowserEntry(entry.tag, entry.verdict, entry.pid));
    }
  }

  // 7. Summary
  console.error('');
  console.error(g(`✓ Generated ${infraEntries.length} infra entries`));
  if (browserEntries.length > 0) console.error(y(`⚠ ${browserEntries.length} browser entries need manual events`));
  console.error(d('  Review output, then append to server/src/__tests__/evals/fixtures/corpus.ts'));
  console.error(d('  Then run: npm test -- evals'));
}

main().catch(err => { console.error(r(`✗ ${err.message}`)); process.exit(1); });

#!/usr/bin/env node
/**
 * update-eval-baseline.mjs — Regenerate eval-baseline.json from the current corpus.
 *
 * Run this after intentionally improving a detector so CI picks up the
 * new accuracy floor. Never run it to paper over a regression — fix the
 * detector first, then update the baseline.
 *
 * Usage:
 *   node scripts/update-eval-baseline.mjs
 *   npm run eval:update-baseline   (alias in package.json)
 *
 * Writes: server/eval-baseline.json
 */

import { writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require   = createRequire(import.meta.url);

const b = s => `\x1b[1m${s}\x1b[0m`;
const g = s => `\x1b[32m${s}\x1b[0m`;
const r = s => `\x1b[31m${s}\x1b[0m`;
const d = s => `\x1b[2m${s}\x1b[0m`;

// ── Load compiled detector (must run after `npm run build:server`) ─────────────
const distDir = resolve(__dirname, '../server/dist/intelligence');

let ALL_INFRA_DETECTORS;
try {
  ({ ALL_INFRA_DETECTORS } = require(`${distDir}/infra-detectors.js`));
} catch {
  console.error(r('✗ Could not load server/dist/intelligence/infra-detectors.js'));
  console.error(d('  Run: cd server && npm run build:server'));
  process.exit(1);
}

// ── Load corpus ───────────────────────────────────────────────────────────────
let REPLAY_CORPUS;
try {
  // corpus.ts is TypeScript — require the compiled version from dist if available,
  // otherwise fall back to a dynamic import of the source via tsx.
  const corpusDistPath = resolve(__dirname, '../server/dist/__tests__/evals/fixtures/corpus.js');
  try {
    ({ REPLAY_CORPUS } = require(corpusDistPath));
  } catch {
    // Run tsx to evaluate the TypeScript corpus directly
    const { execSync } = await import('child_process');
    const tsxPath = resolve(__dirname, '../server/node_modules/.bin/tsx');
    const corpusSrcPath = resolve(__dirname, '../server/src/__tests__/evals/fixtures/corpus.ts');
    const json = execSync(
      `${tsxPath} --eval "import { REPLAY_CORPUS } from '${corpusSrcPath}'; process.stdout.write(JSON.stringify(REPLAY_CORPUS))"`,
      { encoding: 'utf8' },
    );
    REPLAY_CORPUS = JSON.parse(json);
  }
} catch (err) {
  console.error(r(`✗ Could not load corpus: ${err.message}`));
  process.exit(1);
}

// ── Run pipeline ──────────────────────────────────────────────────────────────
function runInfraPipeline(events) {
  const results = ALL_INFRA_DETECTORS
    .map(detect => detect(events))
    .filter(h => h !== null);
  if (results.length === 0) return null;
  return results.reduce((best, h) => h.confidenceScore > best.confidenceScore ? h : best);
}

// ── Compute accuracy ──────────────────────────────────────────────────────────
const byTag = {};
let totalPassed = 0;

for (const entry of REPLAY_CORPUS) {
  const top = runInfraPipeline(entry.events);
  const ok  = top !== null && top.tag === entry.expectedTag;

  byTag[entry.expectedTag] = byTag[entry.expectedTag] ?? { total: 0, passed: 0 };
  byTag[entry.expectedTag].total++;
  if (ok) { byTag[entry.expectedTag].passed++; totalPassed++; }
}

const overallPct = Math.round((totalPassed / REPLAY_CORPUS.length) * 100);

const byTagResult = {};
for (const [tag, s] of Object.entries(byTag)) {
  byTagResult[tag] = {
    total:  s.total,
    passed: s.passed,
    pct:    Math.round((s.passed / s.total) * 100),
  };
}

// ── Write baseline ────────────────────────────────────────────────────────────
const baseline = {
  updatedAt:    new Date().toISOString(),
  corpusSize:   REPLAY_CORPUS.length,
  overall:      overallPct,
  byTag:        byTagResult,
};

const outPath = resolve(__dirname, '../server/eval-baseline.json');
writeFileSync(outPath, JSON.stringify(baseline, null, 2) + '\n');

// ── Report ────────────────────────────────────────────────────────────────────
console.log(b('\nEval baseline updated'));
console.log(`Overall accuracy: ${g(overallPct + '%')} (${totalPassed}/${REPLAY_CORPUS.length})\n`);
for (const [tag, s] of Object.entries(byTagResult)) {
  const indicator = s.pct === 100 ? g('✓') : s.pct >= 85 ? '~' : r('✗');
  console.log(`  ${indicator} ${tag}: ${s.passed}/${s.total} (${s.pct}%)`);
}
console.log(d(`\nWritten to: ${outPath}`));
console.log(d('Commit this file to lock in the new accuracy floor.'));

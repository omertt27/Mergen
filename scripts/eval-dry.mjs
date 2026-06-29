#!/usr/bin/env node
/**
 * eval-dry.mjs — CI-safe AEG gate structure check for Mergen.
 *
 * Runs the same gate scenarios as eval.mjs but scores the gate response
 * structure returned by POST /ci/gate directly — no LLM API key required.
 *
 * What this catches:
 *   - Gate returning wrong verdict (block when it should pass, or vice versa)
 *   - Block/warn responses missing required fields (reasons, recommendation)
 *   - riskScore out of expected range for the verdict
 *   - /agent-blunders endpoint returning a malformed response
 *
 * What this does NOT catch (needs eval.mjs + LLM):
 *   - Guidance text that is vague or non-actionable
 *   - Reasons that don't name the specific command/pattern blocked
 *
 * Usage:
 *   node scripts/eval-dry.mjs [--port 3000] [--verbose]
 *   npm run eval:dry   (from server/ directory)
 *
 * Requires a running Mergen server. Exit 0 = all scenarios pass. Exit 1 = failures.
 */

import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const args    = process.argv.slice(2);
const VERBOSE = args.includes('--verbose');
const _portIdx = args.indexOf('--port');
const PORT     = _portIdx !== -1 ? Number(args[_portIdx + 1]) : 3000;

function readLocalSecret() {
  if (process.env.MERGEN_SECRET) return process.env.MERGEN_SECRET;
  try { return readFileSync(join(homedir(), '.mergen', 'secret'), 'utf8').trim(); } catch { return ''; }
}
const SECRET = readLocalSecret();

const b = s => `\x1b[1m${s}\x1b[0m`;
const g = s => `\x1b[32m${s}\x1b[0m`;
const r = s => `\x1b[31m${s}\x1b[0m`;
const y = s => `\x1b[33m${s}\x1b[0m`;
const d = s => `\x1b[2m${s}\x1b[0m`;

// ── Scenarios ─────────────────────────────────────────────────────────────────
// Each scenario checks the structure of the gate response, not its prose quality.
//
// expect_verdict:  the verdict that MUST be returned
// expect_fields:   fields that must be present in the response (non-empty)
// riskRange:       [min, max] riskScore expected for this verdict tier

const SCENARIOS = [
  // ── Block: destructive diff ──────────────────────────────────────────────
  {
    name:           'DROP TABLE in diff → gate returns block with reasons',
    expect_verdict: 'block',
    expect_fields:  ['reasons', 'recommendation', 'riskScore'],
    riskRange:      [70, 100],
    request: {
      files:   ['db/drop_users.sql'],
      diff:    'DROP TABLE users;',
      prTitle: 'Remove users table',
      actor:   'agent',
    },
  },

  // ── Block: rm -rf in diff ────────────────────────────────────────────────
  {
    name:           'rm -rf in diff → gate returns block',
    expect_verdict: 'block',
    expect_fields:  ['reasons', 'recommendation', 'riskScore'],
    riskRange:      [70, 100],
    request: {
      files:   ['scripts/cleanup.sh'],
      diff:    'rm -rf /var/data/production',
      prTitle: 'Delete old production data',
      actor:   'agent',
    },
  },

  // ── Warn: human touching migration files ─────────────────────────────────
  {
    name:           'Human touching migration files → gate returns warn with reasons',
    expect_verdict: 'warn',
    expect_fields:  ['reasons', 'recommendation', 'riskScore'],
    riskRange:      [1, 69],
    request: {
      files:   ['db/migrations/0042_add_column.sql'],
      diff:    'ALTER TABLE users ADD COLUMN verified BOOLEAN;',
      prTitle: 'Add verified column',
      actor:   'human',
    },
  },

  // ── Pass: safe refactor ───────────────────────────────────────────────────
  {
    name:           'Safe API handler refactor → gate returns pass with no block reasons',
    expect_verdict: 'pass',
    expect_fields:  ['recommendation', 'riskScore'],
    riskRange:      [0, 30],
    request: {
      files:   ['src/api/users.ts'],
      diff:    'function getUser(id) { return db.findById(id); }',
      prTitle: 'Refactor getUser handler',
      actor:   'agent',
    },
  },
];

// ── Scoring ───────────────────────────────────────────────────────────────────

function scoreResponse(response, scenario) {
  const issues = [];

  // 1. Verdict must match
  if (response.verdict !== scenario.expect_verdict) {
    issues.push(`verdict: got '${response.verdict}', expected '${scenario.expect_verdict}'`);
  }

  // 2. Required fields must be present and non-empty
  for (const field of scenario.expect_fields) {
    const val = response[field];
    if (val === undefined || val === null) {
      issues.push(`missing field: ${field}`);
    } else if (Array.isArray(val) && field === 'reasons' && scenario.expect_verdict !== 'pass' && val.length === 0) {
      issues.push(`reasons array is empty for a ${response.verdict} verdict`);
    } else if (typeof val === 'string' && val.trim() === '') {
      issues.push(`field '${field}' is an empty string`);
    }
  }

  // 3. riskScore in expected range
  const score = response.riskScore;
  if (typeof score !== 'number') {
    issues.push('riskScore is not a number');
  } else if (score < scenario.riskRange[0] || score > scenario.riskRange[1]) {
    issues.push(`riskScore ${score} not in expected range [${scenario.riskRange[0]}, ${scenario.riskRange[1]}]`);
  }

  // 4. For pass: reasons should be empty (no spurious blocks)
  if (scenario.expect_verdict === 'pass' && (response.reasons ?? []).length > 0) {
    issues.push(`pass response should have no reasons, got: ${response.reasons.join('; ')}`);
  }

  return { pass: issues.length === 0, issues };
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function authHeaders(extra = {}) {
  return SECRET ? { 'content-type': 'application/json', 'x-mergen-secret': SECRET, ...extra }
                : { 'content-type': 'application/json', ...extra };
}

async function post(path, body) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json();
}

async function get(path) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    headers: authHeaders(),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json();
}

// ── Runner ────────────────────────────────────────────────────────────────────

async function runScenario(scenario, index, total) {
  process.stdout.write(`\n${b(`[${index}/${total}]`)} ${scenario.name}\n`);

  const response = await post('/ci/gate', scenario.request);

  if (VERBOSE) {
    console.log(d('\n── Gate response ───────────────────────────────────────'));
    console.log(d(JSON.stringify(response, null, 2).slice(0, 500)));
  }

  const s = scoreResponse(response, scenario);

  const verdictColor = response.verdict === 'block' ? r
    : response.verdict === 'warn' ? y
    : g;
  console.log(`  verdict:   ${verdictColor(response.verdict)} (expected: ${scenario.expect_verdict})`);
  console.log(`  riskScore: ${response.riskScore}  (expected range: [${scenario.riskRange}])`);

  if (s.pass) {
    console.log(`  structure: ${g('✓ PASS')} — all required fields present and in range`);
  } else {
    for (const issue of s.issues) {
      console.log(`  structure: ${r(`✗ FAIL — ${issue}`)}`);
    }
  }

  return { scenario: scenario.name, pass: s.pass, issues: s.issues };
}

async function runBlunderLogCheck(index, total) {
  process.stdout.write(`\n${b(`[${index}/${total}]`)} Blunder log endpoint returns valid structure\n`);

  const response = await get('/agent-blunders');

  const issues = [];

  // Must return an object with expected fields
  if (typeof response !== 'object' || response === null) {
    issues.push('response is not an object');
  } else {
    if (typeof response.prevented !== 'number')        issues.push('missing numeric field: prevented');
    if (typeof response.byType !== 'object')            issues.push('missing object field: byType');
    if (!Array.isArray(response.recentBlunders))        issues.push('missing array field: recentBlunders');
  }

  const pass = issues.length === 0;
  if (pass) {
    console.log(`  structure: ${g('✓ PASS')} — recentBlunders: ${response.recentBlunders?.length ?? 0}, prevented: ${response.prevented ?? 0}`);
  } else {
    for (const issue of issues) {
      console.log(`  structure: ${r(`✗ FAIL — ${issue}`)}`);
    }
  }

  return { scenario: 'Blunder log endpoint returns valid structure', pass, issues };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(b('\n🛡️  Mergen AEG Gate Dry Eval (no LLM required)'));
  console.log(d(`   port: ${PORT}   scenarios: ${SCENARIOS.length + 1}\n`));

  try {
    await get('/health');
  } catch {
    console.error(r('\n✗ Mergen server not reachable. Start it first:\n  cd server && npm start'));
    process.exit(1);
  }

  const results = [];
  for (let i = 0; i < SCENARIOS.length; i++) {
    try {
      results.push(await runScenario(SCENARIOS[i], i + 1, SCENARIOS.length + 1));
    } catch (err) {
      console.error(r(`\n✗ Scenario "${SCENARIOS[i].name}" threw: ${err.message}`));
      results.push({ scenario: SCENARIOS[i].name, pass: false, issues: [err.message] });
    }
  }

  // Blunder log structural check
  try {
    results.push(await runBlunderLogCheck(SCENARIOS.length + 1, SCENARIOS.length + 1));
  } catch (err) {
    results.push({ scenario: 'Blunder log endpoint returns valid structure', pass: false, issues: [err.message] });
  }

  const passed = results.filter(r => r.pass).length;
  const failed = results.length - passed;

  console.log('\n' + b('─'.repeat(60)));
  console.log(b(`Results: ${passed}/${results.length} passed`));
  console.log('');

  for (const res of results) {
    const icon = res.pass ? g('✓') : y('✗');
    console.log(`  ${icon}  ${res.scenario}`);
    if (!res.pass && res.issues?.length) {
      for (const issue of res.issues) {
        console.log(d(`       issue: ${issue}`));
      }
    }
  }

  console.log('');

  if (failed > 0) {
    console.log(y(`${failed} scenario(s) failed.`));
    console.log(d('Iterate on: ci-gate.ts, action-risk.ts, enterprise-policy-engine.ts, or routes/agent-blunders.ts'));
    console.log('');
    process.exit(1);
  } else {
    console.log(g('All scenarios passed. Gate response structure is correct.'));
    console.log(d('Run eval.mjs (with ANTHROPIC_API_KEY or OPENAI_API_KEY) to verify guidance quality.'));
    console.log('');
  }
}

main().catch(err => {
  console.error(r('\n✗ ' + (err.message ?? err)));
  process.exit(1);
});

#!/usr/bin/env node
/**
 * eval.mjs — Automated quality evaluation for Mergen's LLM diagnosis.
 *
 * Runs 4 synthetic bug scenarios against the live server, gets an LLM
 * diagnosis for each, and scores the output on two axes:
 *
 *   SPECIFICITY  — does root_cause name a concrete endpoint/field/line?
 *   ACTIONABILITY — does fix give an immediately-applicable code action?
 *
 * Usage:
 *   OPENAI_API_KEY=sk-... node scripts/eval.mjs
 *   OPENAI_API_KEY=sk-... node scripts/eval.mjs --model gpt-4o-mini --verbose
 *
 * Exit code 0 = all scenarios passed. Exit code 1 = one or more failed.
 * Run this after every change to causal.ts, buffer.ts, or the prompt.
 */

import { createRequire } from 'module';

const args      = process.argv.slice(2);
const VERBOSE   = args.includes('--verbose');
const MODEL     = args[args.indexOf('--model') + 1] ?? 'gpt-4o';
const PORT      = Number(args[args.indexOf('--port') + 1] ?? 3000);

// ── ANSI helpers ─────────────────────────────────────────────────────────────
const b  = s => `\x1b[1m${s}\x1b[0m`;
const g  = s => `\x1b[32m${s}\x1b[0m`;
const r  = s => `\x1b[31m${s}\x1b[0m`;
const y  = s => `\x1b[33m${s}\x1b[0m`;
const d  = s => `\x1b[2m${s}\x1b[0m`;

// ── Scenario definitions ──────────────────────────────────────────────────────
// Each scenario:
//   events   — array of raw ingest payloads (same shape as the browser extension sends)
//   expect   — scoring rules: keywords that MUST appear in root_cause / fix
//   name     — human label
//   tag      — expected detector tag (for regression checking)

const NOW = Date.now();
const ago = ms => NOW - ms;

const SCENARIOS = [
  // ── S1: Auth token not stored ─────────────────────────────────────────────
  {
    name: 'Auth token not stored after successful login',
    tag:  'auth_token_not_stored',
    expect: {
      root_cause: ['/api/auth', 'token', '200'],   // must name the endpoint and the field
      fix:        ['localStorage', 'setItem'],      // must name the concrete storage call
    },
    events: [
      // Successful auth call
      { type: 'network', method: 'POST', url: 'http://localhost:3000/api/auth/login',
        status: 200, statusText: 'OK', duration: 312,
        requestBody:  { email: 'user@example.com', password: '***' },
        requestHeaders: { 'content-type': 'application/json' },
        responseBody: { token: 'eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOiIxMjMifQ.abc', userId: '123' },
        responseHeaders: { 'content-type': 'application/json' },
        timestamp: ago(4000) },
      // Navigation to dashboard (token never written)
      { type: 'network', method: 'GET', url: 'http://localhost:3000/api/user/profile',
        status: 401, statusText: 'Unauthorized', duration: 89,
        requestBody: null, requestHeaders: {}, responseBody: { error: 'No token' },
        responseHeaders: {}, timestamp: ago(2000) },
      // Console error when reading missing token
      { type: 'console', level: 'error',
        args: ["Cannot read properties of null (reading 'userId')", 'at Dashboard.useEffect (dashboard.tsx:42)'],
        stack: 'TypeError: Cannot read properties of null\n  at Dashboard (dashboard.tsx:42:18)',
        url: 'http://localhost:5173/dashboard', timestamp: ago(1800) },
      // Context snapshot at crash time — token absent from localStorage
      { type: 'context', trigger: 'error', timestamp: ago(1800),
        url: 'http://localhost:5173/dashboard', title: 'Dashboard',
        activeElement: 'body', component: 'Dashboard',
        localStorage: { theme: 'dark', lastRoute: '/dashboard' },   // no token key
        sessionStorage: {} },
    ],
  },

  // ── S2: API 500 → uninitialised state → crash ─────────────────────────────
  {
    name: 'GET /api/products 500 → products.map crash',
    tag:  'failed_request_uninitialised_state',
    expect: {
      root_cause: ['/api/products', '500'],
      fix:        ['response.ok', 'guard', 'check'],  // needs a guard
    },
    events: [
      { type: 'network', method: 'GET', url: 'http://localhost:3000/api/products',
        status: 500, statusText: 'Internal Server Error', duration: 1204,
        requestBody: null, requestHeaders: { authorization: 'Bearer tok…abc' },
        responseBody: { error: 'Database connection timeout' },
        responseHeaders: {}, timestamp: ago(3000) },
      { type: 'console', level: 'error',
        args: ["TypeError: Cannot read properties of undefined (reading 'map')", 'at ProductList (products.tsx:18)'],
        stack: 'TypeError: Cannot read properties of undefined (reading \'map\')\n  at ProductList (products.tsx:18:22)',
        url: 'http://localhost:5173/products', timestamp: ago(2500) },
      { type: 'context', trigger: 'error', timestamp: ago(2500),
        url: 'http://localhost:5173/products', title: 'Products',
        activeElement: null, component: 'ProductList',
        localStorage: { token: 'eyJhbGci…' }, sessionStorage: {} },
    ],
  },

  // ── S3: Storage cleared between snapshots → null read ────────────────────
  {
    name: 'localStorage.token cleared between navigation steps',
    tag:  'storage_cleared',
    expect: {
      root_cause: ['token', 'cleared', 'null'],
      fix:        ['removeItem', 'clear', 'guard'],
    },
    events: [
      // First snapshot — token present
      { type: 'context', trigger: 'warn', timestamp: ago(8000),
        url: 'http://localhost:5173/checkout', title: 'Checkout',
        activeElement: null, component: 'CheckoutForm',
        localStorage: { token: 'eyJhbGci…valid', cartId: 'cart_abc' },
        sessionStorage: {} },
      // Network call that succeeds
      { type: 'network', method: 'POST', url: 'http://localhost:3000/api/orders',
        status: 201, statusText: 'Created', duration: 450,
        requestBody: { cartId: 'cart_abc' }, requestHeaders: { authorization: 'Bearer eyJhbGci…' },
        responseBody: { orderId: 'ord_123' }, responseHeaders: {}, timestamp: ago(4000) },
      // Second snapshot — token gone
      { type: 'context', trigger: 'error', timestamp: ago(1000),
        url: 'http://localhost:5173/confirmation', title: 'Order Confirmation',
        activeElement: null, component: 'Confirmation',
        localStorage: { cartId: 'null' },   // token missing, cartId cleared
        sessionStorage: {} },
      { type: 'console', level: 'error',
        args: ["Unauthorized: token is null"],
        stack: 'Error: Unauthorized\n  at requireAuth (auth.ts:12:9)',
        url: 'http://localhost:5173/confirmation', timestamp: ago(900) },
    ],
  },

  // ── S4: Warning spike → escalation to error ───────────────────────────────
  {
    name: 'React key warning spike precedes render crash',
    tag:  'warn_spike',
    expect: {
      root_cause: ['key', 'warning', 'list'],
      fix:        ['key', 'prop'],
    },
    events: [
      ...Array.from({ length: 7 }, (_, i) => ({
        type: 'console', level: 'warn',
        args: [`Warning: Each child in a list should have a unique "key" prop. Check the render method of \`OrderRow\`.`],
        url: 'http://localhost:5173/orders', timestamp: ago(6000 - i * 200),
      })),
      { type: 'console', level: 'error',
        args: ['Minified React error #130; visit https://reactjs.org/docs/error-decoder.html?invariant=130'],
        stack: 'Error: Minified React error #130\n  at OrderList (orders.tsx:31)',
        url: 'http://localhost:5173/orders', timestamp: ago(4500) },
      { type: 'context', trigger: 'error', timestamp: ago(4500),
        url: 'http://localhost:5173/orders', title: 'Orders',
        activeElement: null, component: 'OrderList',
        localStorage: { token: 'eyJhbGci…' }, sessionStorage: {} },
    ],
  },
];

// ── Scoring ───────────────────────────────────────────────────────────────────
// Each keyword list is OR-per-group, AND-across-groups for that field.
// e.g. expect.fix = [['localStorage','setItem']] means both must appear.
// Flat arrays mean any one keyword is sufficient per check.

function scoreField(text, keywords) {
  if (!text) return { pass: false, missing: keywords };
  const t = text.toLowerCase();
  const missing = keywords.filter(k => !t.includes(k.toLowerCase()));
  return { pass: missing.length === 0, missing };
}

function score(result, expect) {
  const rc = scoreField(result.root_cause, expect.root_cause);
  const fx = scoreField(result.fix,        expect.fix);
  return {
    pass: rc.pass && fx.pass,
    root_cause: rc,
    fix: fx,
    confidence: result.confidence,
    missing_signals: result.missing_signals,
  };
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function post(path, body) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json();
}

async function get(path) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json();
}

// ── OpenAI ────────────────────────────────────────────────────────────────────

async function callOpenAI(request) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not set');

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ ...request, model: MODEL }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenAI ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content ?? '';
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`LLM did not return valid JSON:\n${text.slice(0, 300)}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function runScenario(scenario, index, total) {
  process.stdout.write(`\n${b(`[${index}/${total}]`)} ${scenario.name}\n`);

  // 1. Clear buffer
  await post('/clear', {});

  // 2. Inject telemetry
  for (const event of scenario.events) {
    await post('/ingest', event);
  }

  // 3. Get contextPack + OpenAI request from /diagnose
  const diagnose = await get('/diagnose');

  if (VERBOSE) {
    console.log(d('\n── Context Pack (truncated) ──────────────────────────'));
    console.log(d(diagnose.contextPack.slice(0, 800) + (diagnose.contextPack.length > 800 ? '\n…' : '')));
  }

  // 4. Call OpenAI
  process.stdout.write(d(`  → calling ${MODEL}… `));
  const result = await callOpenAI(diagnose.openai_request);
  process.stdout.write(g('✓') + '\n');

  // 5. Score
  const s = score(result, scenario.expect);

  const confColor = result.confidence === 'HIGH' ? g : result.confidence === 'MEDIUM' ? y : r;

  console.log(`  root_cause: ${result.root_cause ? `"${result.root_cause.slice(0, 120)}"` : r('(empty)')}`);
  console.log(`  fix:        ${result.fix        ? `"${result.fix.slice(0, 120)}"` : r('(empty)')}`);
  console.log(`  confidence: ${confColor(result.confidence ?? '?')}`);
  if (result.missing_signals) {
    console.log(`  missing:    ${d(result.missing_signals.slice(0, 100))}`);
  }

  const rcLabel = s.root_cause.pass ? g('✓ PASS') : r(`✗ FAIL — missing: ${s.root_cause.missing.join(', ')}`);
  const fxLabel = s.fix.pass        ? g('✓ PASS') : r(`✗ FAIL — missing: ${s.fix.missing.join(', ')}`);

  console.log(`  specificity:    ${rcLabel}`);
  console.log(`  actionability:  ${fxLabel}`);
  console.log(`  overall:        ${s.pass ? g('✓ PASS') : r('✗ FAIL')}`);

  return { scenario: scenario.name, ...s, result };
}

async function main() {
  console.log(b('\n🧪 Mergen Diagnosis Eval'));
  console.log(d(`   model: ${MODEL}   port: ${PORT}   scenarios: ${SCENARIOS.length}\n`));

  // Verify server is up
  try {
    await get('/health');
  } catch {
    console.error(r('\n✗ Mergen server not reachable. Start it first:\n  cd server && npm start'));
    process.exit(1);
  }

  const results = [];
  for (let i = 0; i < SCENARIOS.length; i++) {
    try {
      const result = await runScenario(SCENARIOS[i], i + 1, SCENARIOS.length);
      results.push(result);
    } catch (err) {
      console.error(r(`\n✗ Scenario "${SCENARIOS[i].name}" threw: ${err.message}`));
      results.push({ scenario: SCENARIOS[i].name, pass: false, error: err.message });
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  const passed = results.filter(r => r.pass).length;
  const failed = results.length - passed;

  console.log('\n' + b('─'.repeat(60)));
  console.log(b(`Results: ${passed}/${results.length} passed`));
  console.log('');

  for (const r of results) {
    const icon = r.pass ? g('✓') : y('✗');
    console.log(`  ${icon}  ${r.scenario}`);
    if (!r.pass && r.root_cause && !r.root_cause.pass) {
      console.log(d(`       root_cause missing: ${r.root_cause.missing?.join(', ')}`));
    }
    if (!r.pass && r.fix && !r.fix.pass) {
      console.log(d(`       fix missing: ${r.fix.missing?.join(', ')}`));
    }
    if (r.error) {
      console.log(r(`       error: ${r.error}`));
    }
  }

  console.log('');

  if (failed > 0) {
    console.log(y(`${failed} scenario(s) failed.`));
    console.log(d('Iterate on: causal.ts detectors, contextPack sections, or the system prompt in index.ts'));
    console.log('');
    process.exit(1);
  } else {
    console.log(g('All scenarios passed. The output is specific and actionable.'));
    console.log('');
  }
}

main().catch(err => {
  console.error(r('\n✗ ' + (err.message ?? err)));
  process.exit(1);
});

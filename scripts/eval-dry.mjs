#!/usr/bin/env node
/**
 * eval-dry.mjs — CI-safe context-pack quality check for Mergen's diagnosis pipeline.
 *
 * Runs the same 4 synthetic scenarios as eval.mjs but scores the contextPack
 * text returned by /diagnose directly — no OPENAI_API_KEY required.
 *
 * What this catches:
 *   - Buffer not including the ingested event data in the contextPack
 *   - Endpoint URLs, status codes, or localStorage keys dropped from context
 *   - /diagnose returning empty or malformed contextPack after buffer changes
 *
 * What this does NOT catch (needs eval.mjs + OpenAI):
 *   - LLM generating vague or non-actionable fix text
 *   - Prompt changes that cause the model to stop naming concrete endpoints
 *
 * Usage:
 *   node scripts/eval-dry.mjs [--port 3000] [--verbose]
 *   npm run eval:dry   (from server/ directory)
 *
 * Requires a running Mergen server. Exit 0 = all scenarios pass. Exit 1 = failures.
 */

const args    = process.argv.slice(2);
const VERBOSE = args.includes('--verbose');
const PORT    = Number(args[args.indexOf('--port') + 1] ?? 3000);

const b = s => `\x1b[1m${s}\x1b[0m`;
const g = s => `\x1b[32m${s}\x1b[0m`;
const r = s => `\x1b[31m${s}\x1b[0m`;
const y = s => `\x1b[33m${s}\x1b[0m`;
const d = s => `\x1b[2m${s}\x1b[0m`;

// ── Scenarios ─────────────────────────────────────────────────────────────────
// These are the same browser-side events as eval.mjs.
// expect_in_context: keywords that MUST appear in the contextPack assembled by
// the server — these come from the raw event data, so a missing keyword means
// the buffer or context builder dropped relevant signal.

const NOW = Date.now();
const ago = ms => NOW - ms;

const SCENARIOS = [
  {
    name: 'Auth token not stored after successful login',
    expect_in_context: ['/api/auth', 'token', '200', '401'],
    events: [
      { type: 'network', method: 'POST', url: 'http://localhost:3000/api/auth/login',
        status: 200, statusText: 'OK', duration: 312,
        requestBody: { email: 'user@example.com', password: '***' },
        requestHeaders: { 'content-type': 'application/json' },
        responseBody: { token: 'eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOiIxMjMifQ.abc', userId: '123' },
        responseHeaders: { 'content-type': 'application/json' },
        timestamp: ago(4000) },
      { type: 'network', method: 'GET', url: 'http://localhost:3000/api/user/profile',
        status: 401, statusText: 'Unauthorized', duration: 89,
        requestBody: null, requestHeaders: {}, responseBody: { error: 'No token' },
        responseHeaders: {}, timestamp: ago(2000) },
      { type: 'console', level: 'error',
        args: ["Cannot read properties of null (reading 'userId')", 'at Dashboard.useEffect (dashboard.tsx:42)'],
        stack: 'TypeError: Cannot read properties of null\n  at Dashboard (dashboard.tsx:42:18)',
        url: 'http://localhost:5173/dashboard', timestamp: ago(1800) },
      { type: 'context', trigger: 'error', timestamp: ago(1800),
        url: 'http://localhost:5173/dashboard', title: 'Dashboard',
        activeElement: 'body', component: 'Dashboard',
        localStorage: { theme: 'dark', lastRoute: '/dashboard' },
        sessionStorage: {} },
    ],
  },

  {
    name: 'GET /api/products 500 → products.map crash',
    expect_in_context: ['/api/products', '500', 'undefined'],
    events: [
      { type: 'network', method: 'GET', url: 'http://localhost:3000/api/products',
        status: 500, statusText: 'Internal Server Error', duration: 1204,
        requestBody: null, requestHeaders: { authorization: 'Bearer tok…abc' },
        responseBody: { error: 'Database connection timeout' },
        responseHeaders: {}, timestamp: ago(3000) },
      { type: 'console', level: 'error',
        args: ["TypeError: Cannot read properties of undefined (reading 'map')", 'at ProductList (products.tsx:18)'],
        stack: "TypeError: Cannot read properties of undefined (reading 'map')\n  at ProductList (products.tsx:18:22)",
        url: 'http://localhost:5173/products', timestamp: ago(2500) },
      { type: 'context', trigger: 'error', timestamp: ago(2500),
        url: 'http://localhost:5173/products', title: 'Products',
        activeElement: null, component: 'ProductList',
        localStorage: { token: 'eyJhbGci…' }, sessionStorage: {} },
    ],
  },

  {
    name: 'localStorage.token cleared between navigation steps',
    expect_in_context: ['token', '/api/orders', '201'],
    events: [
      { type: 'context', trigger: 'warn', timestamp: ago(8000),
        url: 'http://localhost:5173/checkout', title: 'Checkout',
        activeElement: null, component: 'CheckoutForm',
        localStorage: { token: 'eyJhbGci…valid', cartId: 'cart_abc' },
        sessionStorage: {} },
      { type: 'network', method: 'POST', url: 'http://localhost:3000/api/orders',
        status: 201, statusText: 'Created', duration: 450,
        requestBody: { cartId: 'cart_abc' }, requestHeaders: { authorization: 'Bearer eyJhbGci…' },
        responseBody: { orderId: 'ord_123' }, responseHeaders: {}, timestamp: ago(4000) },
      { type: 'context', trigger: 'error', timestamp: ago(1000),
        url: 'http://localhost:5173/confirmation', title: 'Order Confirmation',
        activeElement: null, component: 'Confirmation',
        localStorage: { cartId: 'null' },
        sessionStorage: {} },
      { type: 'console', level: 'error',
        args: ['Unauthorized: token is null'],
        stack: 'Error: Unauthorized\n  at requireAuth (auth.ts:12:9)',
        url: 'http://localhost:5173/confirmation', timestamp: ago(900) },
    ],
  },

  {
    name: 'React key warning spike precedes render crash',
    expect_in_context: ['key', 'OrderRow', '/orders'],
    events: [
      ...Array.from({ length: 7 }, (_, i) => ({
        type: 'console', level: 'warn',
        args: ['Warning: Each child in a list should have a unique "key" prop. Check the render method of `OrderRow`.'],
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

function scoreContextPack(contextPack, keywords) {
  if (!contextPack) return { pass: false, missing: keywords };
  const text    = contextPack.toLowerCase();
  const missing = keywords.filter(k => !text.includes(k.toLowerCase()));
  return { pass: missing.length === 0, missing };
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

// ── Runner ────────────────────────────────────────────────────────────────────

async function runScenario(scenario, index, total) {
  process.stdout.write(`\n${b(`[${index}/${total}]`)} ${scenario.name}\n`);

  await post('/clear', {});

  for (const event of scenario.events) {
    await post('/ingest', event);
  }

  const diagnose = await get('/diagnose');
  const contextPack = diagnose.contextPack ?? '';

  if (VERBOSE) {
    console.log(d('\n── contextPack (truncated) ──────────────────────────'));
    console.log(d(contextPack.slice(0, 600) + (contextPack.length > 600 ? '\n…' : '')));
  }

  const s = scoreContextPack(contextPack, scenario.expect_in_context);

  const label = s.pass
    ? g('✓ PASS') + d(' — all expected keywords present in contextPack')
    : r(`✗ FAIL — keywords missing from contextPack: ${s.missing.join(', ')}`);

  console.log(`  context score: ${label}`);

  return { scenario: scenario.name, pass: s.pass, missing: s.missing };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(b('\n🧪 Mergen Context-Pack Dry Eval (no OpenAI required)'));
  console.log(d(`   port: ${PORT}   scenarios: ${SCENARIOS.length}\n`));

  try {
    await get('/health');
  } catch {
    console.error(r('\n✗ Mergen server not reachable. Start it first:\n  cd server && npm start'));
    process.exit(1);
  }

  const results = [];
  for (let i = 0; i < SCENARIOS.length; i++) {
    try {
      results.push(await runScenario(SCENARIOS[i], i + 1, SCENARIOS.length));
    } catch (err) {
      console.error(r(`\n✗ Scenario "${SCENARIOS[i].name}" threw: ${err.message}`));
      results.push({ scenario: SCENARIOS[i].name, pass: false, missing: [], error: err.message });
    }
  }

  const passed = results.filter(r => r.pass).length;
  const failed = results.length - passed;

  console.log('\n' + b('─'.repeat(60)));
  console.log(b(`Results: ${passed}/${results.length} passed`));
  console.log('');

  for (const res of results) {
    const icon = res.pass ? g('✓') : y('✗');
    console.log(`  ${icon}  ${res.scenario}`);
    if (!res.pass && res.missing?.length) {
      console.log(d(`       missing in contextPack: ${res.missing.join(', ')}`));
    }
    if (res.error) {
      console.log(r(`       error: ${res.error}`));
    }
  }

  console.log('');

  if (failed > 0) {
    console.log(y(`${failed} scenario(s) failed.`));
    console.log(d('Iterate on: buffer.ts ingest pipeline, contextPack builder, or /diagnose route.'));
    console.log('');
    process.exit(1);
  } else {
    console.log(g('All scenarios passed. The contextPack contains the expected signal.'));
    console.log(d('Run eval.mjs (with OPENAI_API_KEY) to verify LLM output quality.'));
    console.log('');
  }
}

main().catch(err => {
  console.error(r('\n✗ ' + (err.message ?? err)));
  process.exit(1);
});
#!/usr/bin/env node
// inject-test-events.mjs — sends a realistic sequence of browser events to Mergen
// for manual testing / demo purposes.
// Usage: node scripts/inject-test-events.mjs [port]

import http from 'http';

async function findPort(start = 3000, end = 3010) {
  for (let p = start; p <= end; p++) {
    const ok = await new Promise(res => {
      const r = http.get({ hostname: '127.0.0.1', port: p, path: '/health', timeout: 500 }, () => res(p));
      r.on('error', () => res(null));
    });
    if (ok) return ok;
  }
  return null;
}

async function post(port, body) {
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port,
      path: '/ingest', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(d ? JSON.parse(d) : {}));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function get(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(d ? JSON.parse(d) : {}));
    }).on('error', reject);
  });
}

const port = process.argv[2] ? parseInt(process.argv[2]) : await findPort();
if (!port) { console.error('Mergen server not found on ports 3000–3010. Is it running?'); process.exit(1); }
console.log(`Found Mergen server on port ${port}\n`);

const NOW = Date.now();
const URL = 'http://localhost/dashboard';

const events = [
  // S1 trigger: auth endpoint 200 but token absent from localStorage
  { type: 'context', trigger: 'pageload', timestamp: NOW, url: URL, title: 'Dashboard', localStorage: {}, sessionStorage: {} },
  { type: 'network', method: 'POST', url: 'http://localhost/api/auth/login', status: 200, statusText: 'OK', duration: 210, timestamp: NOW + 100 },
  // S2 trigger: auth endpoint failing 4xx
  { type: 'network', method: 'POST', url: 'http://localhost/api/auth/login', status: 401, statusText: 'Unauthorized', duration: 95, timestamp: NOW + 200 },
  // S4 trigger: same non-auth URL failing 3+ times
  { type: 'network', method: 'GET',  url: 'http://localhost/api/profile', status: 500, statusText: 'Internal Server Error', duration: 830, timestamp: NOW + 300 },
  { type: 'network', method: 'GET',  url: 'http://localhost/api/profile', status: 500, statusText: 'Internal Server Error', duration: 791, timestamp: NOW + 400 },
  { type: 'network', method: 'GET',  url: 'http://localhost/api/profile', status: 500, statusText: 'Internal Server Error', duration: 812, timestamp: NOW + 500 },
  // Errors to raise confidence on S1
  { type: 'console', level: 'error', args: ["TypeError: Cannot read properties of null (reading 'token')"], stack: 'TypeError\n    at auth.js:42', url: URL, timestamp: NOW + 600 },
  { type: 'console', level: 'warn',  args: ['auth token missing from storage'], url: URL, timestamp: NOW + 700 },
  { type: 'console', level: 'warn',  args: ['localStorage key "authToken" is null'], url: URL, timestamp: NOW + 800 },
];

const labels = [
  'context/pageload',
  '200 POST /api/auth/login (token NOT saved → S1)',
  '401 POST /api/auth/login (→ S2)',
  '500 GET /api/profile #1 (→ S4)',
  '500 GET /api/profile #2',
  '500 GET /api/profile #3 — triggers S4',
  'error (null token read)',
  'warn (token missing)',
  'warn (authToken null)',
];

for (let i = 0; i < events.length; i++) {
  const res = await post(port, events[i]);
  const ok = res.ok !== false ? '✓' : '✗';
  console.log(`  ${ok} [${i+1}/${events.length}] ${labels[i]}`);
}

console.log('\n─── /health ───');
const health = await get(port, '/health');
console.log(`  buffered: ${health.buffered}`);
console.log(`  errors:   ${health.errors}`);
console.log(`  warnings: ${health.warnings}`);
console.log(`  net errors: ${health.networkErrors}`);
console.log(`  patterns: ${(health.signals || []).length}`);
(health.signals || []).forEach(s => console.log(`    · ${s.message}`));

console.log('\n─── /calibration ───');
const cal = await get(port, '/calibration');
console.log(`  overall accuracy: ${cal.overallAccuracy ?? 'n/a (no verdicts yet)'}`);
console.log(`  trusted detectors: ${cal.trustedDetectors}/${cal.totalDetectors}`);

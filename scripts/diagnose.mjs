#!/usr/bin/env node
/**
 * diagnose.mjs — One-command LLM diagnosis of the current Mergen buffer.
 *
 * Usage:
 *   OPENAI_API_KEY=sk-... node scripts/diagnose.mjs
 *
 * Or pipe from the /diagnose endpoint directly:
 *   curl -s http://127.0.0.1:3000/diagnose | OPENAI_API_KEY=sk-... node scripts/diagnose.mjs
 *
 * Options:
 *   --port  <number>   Mergen server port (default: 3000, auto-scans 3000–3010)
 *   --model <string>   OpenAI model (default: gpt-4o)
 *   --json             Print raw JSON result instead of formatted output
 *   --dry-run          Print the prompt only, do not call OpenAI
 *
 * Tested with Node 18+. No dependencies beyond the standard library.
 */

import { readFileSync } from 'fs';

// ── Parse args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt  = (name, def) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
};

const PORT_START = Number(opt('--port', 3000));
const MODEL      = opt('--model', 'gpt-4o');
const JSON_OUT   = flag('--json');
const DRY_RUN    = flag('--dry-run');

// ── Helpers ───────────────────────────────────────────────────────────────────

function bold(s)    { return `\x1b[1m${s}\x1b[0m`; }
function green(s)   { return `\x1b[32m${s}\x1b[0m`; }
function yellow(s)  { return `\x1b[33m${s}\x1b[0m`; }
function red(s)     { return `\x1b[31m${s}\x1b[0m`; }
function dim(s)     { return `\x1b[2m${s}\x1b[0m`; }

function confColor(c) {
  if (c === 'HIGH')   return green(c);
  if (c === 'MEDIUM') return yellow(c);
  return red(c);
}

// ── Step 1: Get contextPack + OpenAI request from the server ─────────────────

async function fetchDiagnosePayload(portStart) {
  for (let port = portStart; port <= portStart + 10; port++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/diagnose`, {
        signal: AbortSignal.timeout(4000),
      });
      if (!res.ok) continue;
      const data = await res.json();
      return { port, ...data };
    } catch {
      // try next port
    }
  }
  throw new Error(
    `Could not reach Mergen server on ports ${portStart}–${portStart + 10}.\n` +
    `Start the server first: cd server && npm start`,
  );
}

// ── Step 2: Read from stdin if piped ─────────────────────────────────────────

async function readStdin() {
  if (process.stdin.isTTY) return null;
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8').trim()));
  });
}

// ── Step 3: Call OpenAI ───────────────────────────────────────────────────────

async function callOpenAI(request) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'OPENAI_API_KEY is not set.\n' +
      'Run: OPENAI_API_KEY=sk-... node scripts/diagnose.mjs',
    );
  }

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ ...request, model: MODEL }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenAI ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content ?? '';
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`LLM did not return valid JSON:\n${text.slice(0, 500)}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // Try stdin first (piped from curl), then fetch from server
  const stdin = await readStdin();
  let payload;

  if (stdin) {
    try {
      payload = JSON.parse(stdin);
    } catch {
      console.error(red('✗ stdin was not valid JSON'));
      process.exit(1);
    }
  } else {
    process.stderr.write(dim('→ Fetching buffer from Mergen server… '));
    payload = await fetchDiagnosePayload(PORT_START);
    process.stderr.write(green('✓') + '\n');
  }

  if (!payload.ok) {
    console.error(red('✗ Server returned error:'), payload.error ?? payload);
    process.exit(1);
  }

  const { contextPack, openai_request, prompt, buffered, hypotheses } = payload;

  // Dry run: just print the prompt
  if (DRY_RUN) {
    console.log(bold('\n── SYSTEM ──────────────────────────────────────────────────\n'));
    console.log(prompt.system);
    console.log(bold('\n── USER ────────────────────────────────────────────────────\n'));
    console.log(prompt.user.slice(0, 3000), prompt.user.length > 3000 ? '\n… (truncated)' : '');
    console.log(dim(`\n(${buffered} events buffered, ${hypotheses} pre-computed hypotheses)`));
    return;
  }

  process.stderr.write(dim(`→ Calling ${MODEL} (temp=0, json_object mode)… `));
  const result = await callOpenAI(openai_request);
  process.stderr.write(green('✓') + '\n\n');

  // JSON output mode (for scripts / CI)
  if (JSON_OUT) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // Human-readable output
  const conf = result.confidence ?? '?';
  console.log(bold('┌── Mergen Diagnosis ──────────────────────────────────────────'));
  console.log(bold('│'));
  console.log(bold('│  Root cause:  ') + (result.root_cause ?? dim('(none)')));
  console.log(bold('│'));
  console.log(bold('│  Fix:         ') + (result.fix ?? dim('(none)')));
  console.log(bold('│'));
  console.log(bold('│  Confidence:  ') + confColor(conf));
  if (result.missing_signals) {
    console.log(bold('│  Missing:     ') + dim(result.missing_signals));
  }
  console.log(bold('│'));
  console.log(bold('└─────────────────────────────────────────────────────────────'));
  console.log('');
  console.log(dim(`(${buffered} events · ${hypotheses} pre-computed hypotheses · model: ${MODEL})`));
  console.log('');
}

main().catch((err) => {
  console.error(red('\n✗ ' + (err.message ?? err)));
  process.exit(1);
});

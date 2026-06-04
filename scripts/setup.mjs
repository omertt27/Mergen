#!/usr/bin/env node
/**
 * Mergen setup script
 * Run once after `cd server && npm run build`.
 * Writes the correct MCP server config for your IDE.
 *
 * Usage:
 *   node scripts/setup.mjs
 */

import { createInterface } from 'readline';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SERVER_ENTRY = resolve(REPO_ROOT, 'server', 'dist', 'index.js');

// ── Preflight checks ──────────────────────────────────────────────────────────

if (!existsSync(SERVER_ENTRY)) {
  console.error(`\nERROR: ${SERVER_ENTRY} not found.`);
  console.error('Run this first:\n');
  console.error('  cd server && npm install && npm run build\n');
  process.exit(1);
}

const nodeVersion = process.versions.node.split('.')[0];
if (Number(nodeVersion) < 18) {
  console.error(`\nERROR: Node.js 18+ is required (you have ${process.versions.node}).\n`);
  process.exit(1);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function ask(rl, question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

function writeJSON(filePath, data) {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  // Merge into existing file if present
  let existing = {};
  if (existsSync(filePath)) {
    try { existing = JSON.parse(readFileSync(filePath, 'utf8')); } catch { /* ignore */ }
  }

  const merged = deepMerge(existing, data);
  writeFileSync(filePath, JSON.stringify(merged, null, 2) + '\n', 'utf8');
}

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(target[key] ?? {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

function hr() { console.log('\n' + '─'.repeat(60)); }

// ── IDE config writers ────────────────────────────────────────────────────────

const MERGEN_STDIO_CONFIG = {
  command: 'node',
  args: [SERVER_ENTRY],
};

function setupClaudeCode() {
  hr();
  console.log('Registering with Claude Code...\n');

  try {
    execSync(
      `claude mcp add mergen --transport stdio -- node "${SERVER_ENTRY}"`,
      { stdio: 'inherit' }
    );
    console.log('\nVerify with:\n  claude mcp list\n');
  } catch {
    console.log('\nclaude CLI not found. Run this manually:\n');
    console.log(`  claude mcp add mergen --transport stdio -- node "${SERVER_ENTRY}"\n`);
  }
}

function setupCursor() {
  // Cursor reads from ~/.cursor/mcp.json (global) or .cursor/mcp.json (project)
  const globalPath = resolve(homedir(), '.cursor', 'mcp.json');
  hr();
  console.log(`Writing Cursor config to ${globalPath}\n`);

  writeJSON(globalPath, {
    mcpServers: {
      mergen: MERGEN_STDIO_CONFIG,
    },
  });

  console.log('Done. In Cursor:\n');
  console.log('  1. Open Settings > Tools > MCP');
  console.log('  2. You should see "mergen" listed and enabled.');
  console.log('  3. Ask the Agent: "Why did that last request fail?"\n');
}

function setupWindsurf() {
  // Windsurf reads from ~/.codeium/windsurf/mcp_config.json
  const configPath = resolve(homedir(), '.codeium', 'windsurf', 'mcp_config.json');
  hr();
  console.log(`Writing Windsurf config to ${configPath}\n`);

  writeJSON(configPath, {
    mcpServers: {
      mergen: MERGEN_STDIO_CONFIG,
    },
  });

  console.log('Done. In Windsurf:\n');
  console.log('  1. Open Cascade panel > Settings > MCP Servers');
  console.log('  2. You should see "mergen" listed.');
  console.log('  3. Restart Windsurf if it was already open.\n');
}

function setupVSCode() {
  // VS Code MCP support (GitHub Copilot Chat) reads .vscode/mcp.json
  const configPath = resolve(REPO_ROOT, '.vscode', 'mcp.json');
  hr();
  console.log(`Writing VS Code config to ${configPath}\n`);

  writeJSON(configPath, {
    servers: {
      mergen: {
        type: 'stdio',
        command: MERGEN_STDIO_CONFIG.command,
        args: MERGEN_STDIO_CONFIG.args,
      },
    },
  });

  console.log('Done. In VS Code:\n');
  console.log('  1. Open GitHub Copilot Chat (Ctrl/Cmd+Alt+I)');
  console.log('  2. Switch to Agent mode (the robot icon)');
  console.log('  3. Click the tools button — "mergen" tools will appear.\n');
}

// ── Agent directive injection ─────────────────────────────────────────────────
// Writes one sentence to the project's AI context file so the agent reaches
// for Mergen data automatically instead of guessing.
//
// Files written (IDE-specific):
//   Claude Code  →  CLAUDE.md
//   Cursor       →  .cursorrules
//   Windsurf     →  .windsurfrules
//
// The directive is appended under a clearly-labelled section so it can be
// found and removed with a single line delete. Opt-out: just remove the block.

const AGENT_DIRECTIVE =
  'When diagnosing unexpected behavior or errors, call get_correlated_trace before suggesting fixes.';

const IDE_DIRECTIVE_FILES = {
  claude:   'CLAUDE.md',
  cursor:   '.cursorrules',
  windsurf: '.windsurfrules',
};

async function injectAgentDirective(ideName, projectDir) {
  const fileName = IDE_DIRECTIVE_FILES[ideName];
  if (!fileName) return;

  const filePath = resolve(projectDir, fileName);
  const block =
    '\n\n# Mergen — runtime context\n' +
    `# ${AGENT_DIRECTIVE}\n` +
    '# Remove this block to opt out.\n';

  // Skip if the directive is already present
  if (existsSync(filePath)) {
    const existing = readFileSync(filePath, 'utf8');
    if (existing.includes('Mergen — runtime context')) {
      console.log(`  Directive already present in ${fileName} — skipping.`);
      return;
    }
  }

  writeFileSync(filePath, existsSync(filePath)
    ? readFileSync(filePath, 'utf8') + block
    : block.trimStart(), 'utf8');
  console.log(`  Wrote agent directive to ${filePath}`);
}

async function setupDirectives(rl, ideKeys) {
  hr();
  console.log('Agent directive injection (optional)\n');
  console.log('This writes one line to your project\'s AI context file:');
  console.log(`  "${AGENT_DIRECTIVE}"\n`);
  console.log('The agent will call get_correlated_trace automatically instead of');
  console.log('asking you to paste logs. Remove the block at any time to opt out.\n');

  const projectDir = (await ask(rl,
    `Project directory to inject into (Enter for current dir: ${process.cwd()}): `
  )).trim() || process.cwd();

  if (!existsSync(projectDir)) {
    console.log(`  Directory not found: ${projectDir} — skipping.`);
    return;
  }

  for (const ideKey of ideKeys) {
    await injectAgentDirective(ideKey, projectDir);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

const IDES = [
  { label: 'Claude Code',  key: '1', fn: setupClaudeCode },
  { label: 'Cursor',       key: '2', fn: setupCursor },
  { label: 'Windsurf',     key: '3', fn: setupWindsurf },
  { label: 'VS Code',      key: '4', fn: setupVSCode },
  { label: 'All of the above', key: '5', fn: null },
  { label: 'Git pre-commit hook (surfaces signals before every commit)', key: '6', fn: setupGitHook },
];

// ── Git pre-commit hook ───────────────────────────────────────────────────────
// Installs a hook that:
//   1. POSTs a checkpoint event to the Mergen server (marks the commit in the timeline)
//   2. Fetches the signal list — if any HIGH-confidence signals exist, prints them
//      and asks the dev whether to proceed. Does NOT block commits automatically
//      (that would be annoying) — it just makes the signal visible at the right moment.
//
// This is the engagement hook for normal dev flow: every commit = one Mergen moment.

function setupGitHook() {
  const gitDir = resolve(REPO_ROOT, '.git');
  if (!existsSync(gitDir)) {
    console.error('\nERROR: .git directory not found. Run from the repo root.\n');
    return;
  }

  const hooksDir = resolve(gitDir, 'hooks');
  if (!existsSync(hooksDir)) mkdirSync(hooksDir, { recursive: true });

  const hookPath = resolve(hooksDir, 'pre-commit');
  const hookContent = `#!/bin/sh
# Mergen pre-commit hook — installed by scripts/setup.mjs
# Posts a checkpoint to the local Mergen server and surfaces any detected signals.
# Does NOT block commits — it just makes patterns visible at commit time.

MERGEN_URL="http://127.0.0.1:3000"

# Post a checkpoint (marks this commit in the causal timeline)
RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" \\
  -X POST "$MERGEN_URL/checkpoint" \\
  -H "Content-Type: application/json" \\
  -d "{\\"label\\": \\"pre-commit: $(git log --oneline -1 2>/dev/null | cut -c1-60 || echo 'commit')\\"}" \\
  --connect-timeout 1 --max-time 2 2>/dev/null)

if [ "$RESPONSE" = "200" ]; then
  # Fetch signals from the health endpoint
  SIGNALS=$(curl -s "$MERGEN_URL/health" --connect-timeout 1 --max-time 2 2>/dev/null | \\
    node -e "
      let d='';
      process.stdin.on('data',c=>d+=c);
      process.stdin.on('end',()=>{
        try {
          const s = JSON.parse(d).signals || [];
          const high = s.filter(x => x.confidence >= 0.80);
          if (high.length) {
            console.log('');
            console.log('  ⚡ Mergen detected ' + high.length + ' pattern(s) before this commit:');
            high.forEach(x => console.log('    · ' + x.message + ' (' + Math.round(x.confidence*100) + '%)'));
            console.log('  Run quick_check in your AI assistant for details.');
            console.log('');
          }
        } catch {}
      });
    " 2>/dev/null)
  echo "$SIGNALS"
fi

exit 0
`;

  writeFileSync(hookPath, hookContent, { mode: 0o755 });

  hr();
  console.log('Git pre-commit hook installed.\n');
  console.log('On every commit the hook will:');
  console.log('  • Mark the commit in the Mergen causal timeline');
  console.log('  • Print any HIGH-confidence signals detected in the buffer');
  console.log('  • Never block the commit — it only surfaces patterns\n');
  console.log(`Hook location: ${hookPath}\n`);
}

console.log('\nMergen Setup');
console.log('Server entry:', SERVER_ENTRY);
console.log('\nWhich IDE do you want to configure?\n');
IDES.forEach(({ key, label }) => console.log(`  ${key}) ${label}`));

const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = (await ask(rl, '\nChoice [1-6]: ')).trim();

const chosen = IDES.find((ide) => ide.key === answer);

if (!chosen) {
  rl.close();
  console.error('\nInvalid choice. Run the script again.\n');
  process.exit(1);
}

const ideKeysChosen = [];
if (chosen.key === '5') {
  for (const ide of IDES.slice(0, 4)) ide.fn();
  ideKeysChosen.push('claude', 'cursor', 'windsurf');
} else {
  chosen.fn();
  if (chosen.key === '1') ideKeysChosen.push('claude');
  if (chosen.key === '2') ideKeysChosen.push('cursor');
  if (chosen.key === '3') ideKeysChosen.push('windsurf');
}

// Offer agent directive injection for IDE setups (not git hook)
if (ideKeysChosen.length > 0) {
  const injectAnswer = (await ask(rl,
    '\nInject a one-line agent directive into your project? [y/N]: '
  )).trim().toLowerCase();
  if (injectAnswer === 'y' || injectAnswer === 'yes') {
    await setupDirectives(rl, ideKeysChosen);
  } else {
    console.log('\nSkipped. You can run this step later with: node scripts/setup.mjs');
  }
}

rl.close();

hr();
console.log('Next: load the Chrome extension\n');
console.log('  1. Open chrome://extensions');
console.log('  2. Enable Developer mode');
console.log('  3. Load unpacked → select the extension/ folder\n');
console.log('Then start the Mergen server:\n');
console.log(`  cd "${REPO_ROOT}/server" && npm start\n`);

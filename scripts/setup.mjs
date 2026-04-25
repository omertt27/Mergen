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

// ── Main ──────────────────────────────────────────────────────────────────────

const IDES = [
  { label: 'Claude Code',  key: '1', fn: setupClaudeCode },
  { label: 'Cursor',       key: '2', fn: setupCursor },
  { label: 'Windsurf',     key: '3', fn: setupWindsurf },
  { label: 'VS Code',      key: '4', fn: setupVSCode },
  { label: 'All of the above', key: '5', fn: null },
];

console.log('\nMergen Setup');
console.log('Server entry:', SERVER_ENTRY);
console.log('\nWhich IDE do you want to configure?\n');
IDES.forEach(({ key, label }) => console.log(`  ${key}) ${label}`));

const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = (await ask(rl, '\nChoice [1-5]: ')).trim();
rl.close();

const chosen = IDES.find((ide) => ide.key === answer);

if (!chosen) {
  console.error('\nInvalid choice. Run the script again.\n');
  process.exit(1);
}

if (chosen.key === '5') {
  for (const ide of IDES.slice(0, 4)) ide.fn();
} else {
  chosen.fn();
}

hr();
console.log('Next: load the Chrome extension\n');
console.log('  1. Open chrome://extensions');
console.log('  2. Enable Developer mode');
console.log('  3. Load unpacked → select the extension/ folder\n');
console.log('Then start the Mergen server:\n');
console.log(`  cd "${REPO_ROOT}/server" && npm start\n`);

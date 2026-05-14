#!/usr/bin/env node
/**
 * cli.ts — Mergen CLI for easy setup and management
 *
 * Usage:
 *   npx mergen-server setup    # Interactive setup wizard
 *   npx mergen-server test     # Validate installation
 *   npx mergen-server start    # Start server
 *   npx mergen-server --help   # Show help
 */

import { execSync, spawn } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { homedir } from 'os';
import { createInterface } from 'readline';

const VERSION = '1.0.0';

// ── Helpers ────────────────────────────────────────────────────────────────────

function log(msg: string, icon = 'ℹ'): void {
  console.log(`${icon} ${msg}`);
}

function success(msg: string): void {
  console.log(`✓ ${msg}`);
}

function error(msg: string): void {
  console.error(`✗ ${msg}`);
}

function hr(): void {
  console.log('─'.repeat(60));
}

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Commands ───────────────────────────────────────────────────────────────────

async function setupCommand(): Promise<void> {
  console.log('🚀 Mergen Setup Wizard\n');
  hr();

  // 1. Check prerequisites
  log('Checking prerequisites...');

  const nodeVersion = parseInt(process.versions.node.split('.')[0]);
  if (nodeVersion < 18) {
    error(`Node.js 18+ required (you have ${process.versions.node})`);
    log('Install from: https://nodejs.org/');
    process.exit(1);
  }
  success(`Node.js ${process.versions.node}`);

  // 2. Detect IDE
  log('\nDetecting IDE...');
  const ide = await detectIDE();
  success(`Found: ${ide}`);

  // 3. Configure IDE
  log(`\nConfiguring ${ide}...`);
  await configureIDE(ide);
  success(`${ide} configured`);

  // 4. Extension setup
  log('\nBrowser extension setup:');
  console.log('  1. Open chrome://extensions');
  console.log('  2. Enable Developer Mode');
  console.log('  3. Click "Load unpacked"');
  console.log(`  4. Select: ${resolve(__dirname, '../../extension')}`);

  const installed = await ask('\nHave you installed the extension? (y/n): ');
  if (installed.toLowerCase() !== 'y') {
    log('⚠ Extension not installed. You can install it later.', '⚠');
  }

  // 5. Start server
  hr();
  log('\n✨ Setup complete!\n');
  console.log('Next steps:');
  console.log('  1. Start server: mergen-server start');
  console.log('  2. Or run in background: mergen-server start &');
  console.log('  3. Verify setup: mergen-server test\n');

  const startNow = await ask('Start server now? (y/n): ');
  if (startNow.toLowerCase() === 'y') {
    await startCommand();
  }
}

async function testCommand(): Promise<void> {
  console.log('🔍 Testing Mergen installation\n');
  hr();

  const checks = [
    { name: 'Server binary', fn: checkBinary },
    { name: 'Server starts', fn: checkServerStarts },
    { name: 'Health endpoint', fn: checkHealth },
    { name: 'Event ingestion', fn: checkIngest },
    { name: 'IDE configuration', fn: checkIDEConfig },
  ];

  let passed = 0;
  let failed = 0;

  for (const check of checks) {
    process.stdout.write(`${check.name}... `);
    try {
      await check.fn();
      console.log('✓');
      passed++;
    } catch (err) {
      console.log('✗');
      error(`  ${err instanceof Error ? err.message : 'Unknown error'}`);
      failed++;
    }
  }

  hr();
  if (failed === 0) {
    success(`All checks passed (${passed}/${checks.length})`);
    console.log('\n✨ Mergen is ready to use!\n');
  } else {
    error(`${failed} check(s) failed`);
    console.log('\nRun: mergen-server setup');
    process.exit(1);
  }
}

async function startCommand(): Promise<void> {
  const serverPath = resolve(__dirname, 'index.js');

  if (!existsSync(serverPath)) {
    error('Server not found. Run: mergen-server setup');
    process.exit(1);
  }

  log('Starting Mergen server...\n');

  // Start server in foreground
  const server = spawn('node', [serverPath], {
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'production' },
  });

  server.on('error', (err) => {
    error(`Failed to start: ${err.message}`);
    process.exit(1);
  });

  server.on('exit', (code) => {
    if (code !== 0) {
      error(`Server exited with code ${code}`);
    }
    process.exit(code || 0);
  });

  // Handle Ctrl+C
  process.on('SIGINT', () => {
    log('Stopping server...');
    server.kill('SIGINT');
  });
}

// ── IDE Detection & Configuration ──────────────────────────────────────────────

async function detectIDE(): Promise<string> {
  // Check for Claude Code CLI
  try {
    execSync('which claude', { stdio: 'ignore' });
    return 'claude-code';
  } catch {}

  // Check for Cursor config
  const cursorConfig = resolve(homedir(), '.cursor', 'mcp.json');
  if (existsSync(cursorConfig)) {
    return 'cursor';
  }

  // Check for VS Code
  try {
    execSync('which code', { stdio: 'ignore' });
    return 'vscode';
  } catch {}

  // Check for Windsurf
  const windsurfConfig = resolve(homedir(), '.codeium', 'windsurf', 'mcp_config.json');
  if (existsSync(windsurfConfig)) {
    return 'windsurf';
  }

  // Default
  const answer = await ask('Which IDE? (cursor/claude-code/vscode/windsurf): ');
  return answer || 'cursor';
}

async function configureIDE(ide: string): Promise<void> {
  const serverPath = resolve(__dirname, 'index.js');

  switch (ide) {
    case 'claude-code':
      try {
        execSync(`claude mcp add mergen --transport stdio -- node "${serverPath}"`, {
          stdio: 'inherit',
        });
      } catch {
        log('Run manually:', 'ℹ');
        console.log(`  claude mcp add mergen --transport stdio -- node "${serverPath}"`);
      }
      break;

    case 'cursor': {
      const configPath = resolve(homedir(), '.cursor', 'mcp.json');
      const config = {
        mcpServers: {
          mergen: {
            command: 'node',
            args: [serverPath],
          },
        },
      };
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(configPath, JSON.stringify(config, null, 2));
      log(`Config written to: ${configPath}`);
      break;
    }

    case 'vscode': {
      const configPath = resolve(homedir(), '.vscode', 'mcp.json');
      const config = {
        mcpServers: {
          mergen: {
            command: 'node',
            args: [serverPath],
          },
        },
      };
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(configPath, JSON.stringify(config, null, 2));
      log(`Config written to: ${configPath}`);
      break;
    }

    case 'windsurf': {
      const configPath = resolve(homedir(), '.codeium', 'windsurf', 'mcp_config.json');
      const config = {
        mcpServers: {
          mergen: {
            command: 'node',
            args: [serverPath],
          },
        },
      };
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(configPath, JSON.stringify(config, null, 2));
      log(`Config written to: ${configPath}`);
      break;
    }

    default:
      log(`Manual setup required for ${ide}`, '⚠');
      console.log(`  Add this to your IDE config:`);
      console.log(`  { "command": "node", "args": ["${serverPath}"] }`);
  }
}

// ── Validation Checks ──────────────────────────────────────────────────────────

async function checkBinary(): Promise<void> {
  const serverPath = resolve(__dirname, 'index.js');
  if (!existsSync(serverPath)) {
    throw new Error(`Server not found at ${serverPath}`);
  }
}

async function checkServerStarts(): Promise<void> {
  const serverPath = resolve(__dirname, 'index.js');
  const proc = spawn('node', [serverPath], { stdio: 'pipe' });

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error('Server did not start within 5s'));
    }, 5000);

    proc.stderr.on('data', (data: Buffer) => {
      if (data.toString().includes('HTTP ingest listening')) {
        proc.kill();
        clearTimeout(timeout);
        resolve();
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

async function checkHealth(): Promise<void> {
  const serverPath = resolve(__dirname, 'index.js');
  const proc = spawn('node', [serverPath], { stdio: 'pipe' });

  // Wait for server to start
  await sleep(2000);

  try {
    const response = await fetch('http://127.0.0.1:3000/health');
    if (!response.ok) {
      throw new Error(`Health check returned ${response.status}`);
    }
    const data = await response.json() as { status: string };
    if (data.status !== 'ok') {
      throw new Error(`Health status: ${data.status}`);
    }
  } finally {
    proc.kill();
  }
}

async function checkIngest(): Promise<void> {
  const serverPath = resolve(__dirname, 'index.js');
  const proc = spawn('node', [serverPath], { stdio: 'pipe' });

  await sleep(2000);

  try {
    const response = await fetch('http://127.0.0.1:3000/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'console',
        level: 'log',
        args: ['Mergen test'],
        url: 'http://test',
        timestamp: Date.now(),
      }),
    });

    if (!response.ok) {
      throw new Error(`Ingest returned ${response.status}`);
    }
  } finally {
    proc.kill();
  }
}

async function checkIDEConfig(): Promise<void> {
  const ide = await detectIDE();

  let configPath: string;
  switch (ide) {
    case 'cursor':
      configPath = resolve(homedir(), '.cursor', 'mcp.json');
      break;
    case 'vscode':
      configPath = resolve(homedir(), '.vscode', 'mcp.json');
      break;
    case 'windsurf':
      configPath = resolve(homedir(), '.codeium', 'windsurf', 'mcp_config.json');
      break;
    case 'claude-code':
      // Check via CLI
      try {
        const output = execSync('claude mcp list', { encoding: 'utf8' });
        if (!output.includes('mergen')) {
          throw new Error('mergen not in claude mcp list');
        }
        return;
      } catch {
        throw new Error('Claude Code not configured');
      }
    default:
      throw new Error(`Unknown IDE: ${ide}`);
  }

  if (!existsSync(configPath)) {
    throw new Error(`Config not found: ${configPath}`);
  }

  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  if (!config.mcpServers?.mergen) {
    throw new Error('mergen not in IDE config');
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case 'setup':
      await setupCommand();
      break;

    case 'test':
      await testCommand();
      break;

    case 'start':
      await startCommand();
      break;

    case 'version':
    case '--version':
    case '-v':
      console.log(`mergen-server v${VERSION}`);
      break;

    case 'help':
    case '--help':
    case '-h':
    case undefined:
      console.log(`
Mergen — Local-first browser observability for AI

Usage:
  mergen-server setup       Interactive setup wizard
  mergen-server test        Validate installation
  mergen-server start       Start the server
  mergen-server --version   Show version
  mergen-server --help      Show this help

Examples:
  npx mergen-server setup
  mergen-server start &
  mergen-server test

Documentation: https://github.com/omertt27/Mergen
      `);
      break;

    default:
      error(`Unknown command: ${command}`);
      console.log('Run: mergen-server --help');
      process.exit(1);
  }
}

main().catch((err) => {
  error(err.message);
  process.exit(1);
});

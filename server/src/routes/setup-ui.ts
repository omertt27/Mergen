/**
 * setup-ui.ts — Web-based setup wizard
 *
 * Provides a visual alternative to CLI setup at http://127.0.0.1:3000/setup
 */

import { Router } from 'express';
import { execSync } from 'child_process';
import { existsSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { homedir } from 'os';

export function createSetupRouter(): Router {
  const router = Router();

  // ── GET /setup — Setup wizard UI ─────────────────────────────────────────────
  router.get('/setup', (_req, res) => {
    res.send(SETUP_HTML);
  });

  // ── POST /api/setup/ide — Configure IDE ──────────────────────────────────────
  router.post('/api/setup/ide', (req, res) => {
    const { ide } = req.body as { ide: string };

    if (!ide || !['cursor', 'claude-code', 'vscode', 'windsurf'].includes(ide)) {
      res.status(400).json({ error: 'Invalid IDE' });
      return;
    }

    try {
      const serverPath = resolve(__dirname, '../index.js');
      configureIDE(ide, serverPath);
      res.json({ success: true, message: `${ide} configured successfully` });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Configuration failed' });
    }
  });

  // ── GET /api/setup/test — Test pipeline ──────────────────────────────────────
  router.get('/api/setup/test', async (_req, res) => {
    try {
      // Send a test event to ourselves
      const response = await fetch('http://127.0.0.1:3000/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'console',
          level: 'log',
          args: ['✓ Mergen setup test'],
          url: 'http://127.0.0.1:3000/setup',
          timestamp: Date.now(),
        }),
      });

      if (response.ok) {
        res.json({ success: true, message: 'Pipeline working! Test event ingested successfully.' });
      } else {
        res.json({ success: false, message: `Server returned ${response.status}` });
      }
    } catch (err) {
      res.json({ success: false, message: err instanceof Error ? err.message : 'Test failed' });
    }
  });

  // ── GET /api/setup/status — Check setup status ───────────────────────────────
  router.get('/api/setup/status', (_req, res) => {
    const status = {
      server: true, // If we're responding, server is running
      ide: checkIDEConfigured(),
      extension: 'unknown', // Can't detect from server side
    };

    res.json(status);
  });

  return router;
}

// ── Helper Functions ──────────────────────────────────────────────────────────

function configureIDE(ide: string, serverPath: string): void {
  switch (ide) {
    case 'claude-code':
      try {
        execSync(`claude mcp add mergen --transport stdio -- node "${serverPath}"`, {
          stdio: 'ignore',
        });
      } catch {
        throw new Error('Claude Code CLI not found. Install from: https://claude.ai/download');
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
      break;
    }

    default:
      throw new Error(`Unknown IDE: ${ide}`);
  }
}

function checkIDEConfigured(): boolean {
  const paths = [
    resolve(homedir(), '.cursor', 'mcp.json'),
    resolve(homedir(), '.vscode', 'mcp.json'),
    resolve(homedir(), '.codeium', 'windsurf', 'mcp_config.json'),
  ];

  for (const path of paths) {
    if (existsSync(path)) {
      try {
        const content = require('fs').readFileSync(path, 'utf8');
        if (content.includes('mergen')) return true;
      } catch {
        // Ignore
      }
    }
  }

  // Check Claude Code
  try {
    const output = execSync('claude mcp list', { encoding: 'utf8', stdio: 'pipe' });
    if (output.includes('mergen')) return true;
  } catch {
    // Ignore
  }

  return false;
}

// ── HTML Template ─────────────────────────────────────────────────────────────

const SETUP_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Mergen Setup Wizard</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      padding: 20px;
    }
    .container {
      max-width: 800px;
      margin: 0 auto;
      background: white;
      border-radius: 16px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
      overflow: hidden;
    }
    header {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 40px;
      text-align: center;
    }
    header h1 { font-size: 36px; margin-bottom: 10px; }
    header p { font-size: 18px; opacity: 0.95; }
    .content { padding: 40px; }
    .step {
      padding: 30px;
      border: 2px solid #e2e8f0;
      border-radius: 12px;
      margin: 20px 0;
      transition: all 0.3s;
    }
    .step:hover { border-color: #cbd5e0; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08); }
    .step h2 { font-size: 24px; margin-bottom: 15px; display: flex; align-items: center; gap: 10px; }
    .step p { color: #64748b; margin-bottom: 15px; line-height: 1.6; }
    .step.complete { background: #f0fdf4; border-color: #86efac; }
    .step.complete h2 { color: #16a34a; }
    .step.pending { background: #fefce8; border-color: #fde047; }
    .step.pending h2 { color: #ca8a04; }
    .step.error { background: #fef2f2; border-color: #fca5a5; }
    .step.error h2 { color: #dc2626; }
    .icon { font-size: 28px; }
    .btn-group { display: flex; gap: 15px; flex-wrap: wrap; }
    button {
      padding: 12px 24px;
      font-size: 16px;
      font-weight: 600;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.2s;
      flex: 1;
      min-width: 120px;
    }
    button:hover { transform: translateY(-2px); box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15); }
    button.primary { background: #667eea; color: white; }
    button.primary:hover { background: #5568d3; }
    button.secondary { background: #e2e8f0; color: #334155; }
    button.secondary:hover { background: #cbd5e0; }
    button.success { background: #10b981; color: white; }
    button.success:hover { background: #059669; }
    button:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
    pre {
      background: #1e293b;
      color: #e2e8f0;
      padding: 20px;
      border-radius: 8px;
      overflow-x: auto;
      font-size: 14px;
      line-height: 1.6;
      margin: 15px 0;
    }
    .alert { padding: 15px; border-radius: 8px; margin: 15px 0; }
    .alert-success { background: #d1fae5; color: #065f46; border-left: 4px solid #10b981; }
    .alert-error { background: #fee2e2; color: #991b1b; border-left: 4px solid #ef4444; }
    a { color: #667eea; text-decoration: none; font-weight: 600; }
    a:hover { text-decoration: underline; }
    footer { text-align: center; padding: 30px; color: #64748b; font-size: 14px; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>🚀 Mergen Setup Wizard</h1>
      <p>Get your local-first browser observability up and running</p>
    </header>

    <div class="content">
      <div class="step complete" id="step-1">
        <h2><span class="icon">✅</span> Step 1: Server Running</h2>
        <p>Your Mergen server is up and running at <code>http://127.0.0.1:3000</code></p>
      </div>

      <div class="step pending" id="step-2">
        <h2><span class="icon">⏳</span> Step 2: Configure IDE</h2>
        <p>Which AI IDE are you using?</p>
        <div class="btn-group">
          <button class="primary" onclick="configureIDE('cursor')">Cursor</button>
          <button class="primary" onclick="configureIDE('claude-code')">Claude Code</button>
          <button class="primary" onclick="configureIDE('vscode')">VS Code</button>
          <button class="primary" onclick="configureIDE('windsurf')">Windsurf</button>
        </div>
        <div id="ide-result"></div>
      </div>

      <div class="step pending" id="step-3">
        <h2><span class="icon">⏳</span> Step 3: Install Extension</h2>
        <p>Install the Mergen browser extension to capture telemetry:</p>
        <div class="btn-group">
          <button class="primary" onclick="window.open('https://chrome.google.com/webstore', '_blank')">
            Chrome Web Store (Coming Soon)
          </button>
        </div>
        <p style="margin-top: 15px;">Or install manually:</p>
        <pre>1. Open chrome://extensions
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select the extension folder</pre>
      </div>

      <div class="step pending" id="step-4">
        <h2><span class="icon">⏳</span> Step 4: Test Pipeline</h2>
        <p>Verify everything is working:</p>
        <button class="success" onclick="testPipeline()">Run Test</button>
        <div id="test-result"></div>
      </div>
    </div>

    <footer>
      <p>Need help? Check the <a href="https://github.com/omertt27/Mergen" target="_blank">documentation</a></p>
      <p style="margin-top: 10px;">Made with ❤️ by developers, for developers</p>
    </footer>
  </div>

  <script>
    async function configureIDE(ide) {
      const result = document.getElementById('ide-result');
      result.innerHTML = '<div class="alert alert-info">Configuring...</div>';

      try {
        const response = await fetch('/api/setup/ide', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ide }),
        });

        const data = await response.json();

        if (response.ok) {
          result.innerHTML = '<div class="alert alert-success">✓ ' + data.message + ' — Restart your IDE to see Mergen tools.</div>';
          document.getElementById('step-2').className = 'step complete';
          document.getElementById('step-2').querySelector('.icon').textContent = '✅';
        } else {
          result.innerHTML = '<div class="alert alert-error">✗ ' + data.error + '</div>';
        }
      } catch (err) {
        result.innerHTML = '<div class="alert alert-error">✗ Configuration failed: ' + err.message + '</div>';
      }
    }

    async function testPipeline() {
      const result = document.getElementById('test-result');
      result.innerHTML = '<div class="alert alert-info">Testing...</div>';

      try {
        const response = await fetch('/api/setup/test');
        const data = await response.json();

        if (data.success) {
          result.innerHTML = '<div class="alert alert-success">✓ ' + data.message + '<br><br><strong>Next step:</strong> In your IDE, ask: "Get recent logs"</div>';
          document.getElementById('step-4').className = 'step complete';
          document.getElementById('step-4').querySelector('.icon').textContent = '✅';
        } else {
          result.innerHTML = '<div class="alert alert-error">✗ ' + data.message + '</div>';
        }
      } catch (err) {
        result.innerHTML = '<div class="alert alert-error">✗ Test failed: ' + err.message + '</div>';
      }
    }

    // Check status on load
    window.addEventListener('load', async () => {
      try {
        const response = await fetch('/api/setup/status');
        const status = await response.json();

        if (status.ide) {
          document.getElementById('step-2').className = 'step complete';
          document.getElementById('step-2').querySelector('.icon').textContent = '✅';
        }
      } catch (err) {
        console.error('Status check failed:', err);
      }
    });
  </script>
</body>
</html>`;

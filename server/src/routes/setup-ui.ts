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

import logger from '../sensor/logger.js';

export function createSetupRouter(): Router {
  const router = Router();

  // Restrict setup endpoints to localhost loopback to prevent Remote Code Execution
  router.use((req, res, next) => {
    const remoteIp = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
    const isLocalhost = remoteIp === '127.0.0.1' || remoteIp === '::1' || remoteIp === '';

    if (!isLocalhost && process.env.NODE_ENV !== 'test') {
      logger.warn({ remoteIp, path: req.path }, 'setup-ui: blocked remote attempt to access setup wizard');
      res.status(403).send('Forbidden — setup wizard is only accessible via localhost loopback interface (127.0.0.1) for security.');
      return;
    }
    next();
  });

  // ── GET /setup — Setup wizard UI ─────────────────────────────────────────────
  // Accepts ?server=<url>&token=<secret> from mergen invite URLs to pre-fill fields.
  router.get('/setup', (req, res) => {
    const preServer = typeof req.query.server === 'string' ? req.query.server : '';
    const preToken  = typeof req.query.token  === 'string' ? req.query.token  : '';
    const html = preServer
      ? SETUP_HTML.replace('</head>', `<script>window.__MERGEN_PREFILL__={server:${JSON.stringify(preServer)},token:${JSON.stringify(preToken)}};</script></head>`)
      : SETUP_HTML;
    res.send(html);
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
    res.json({
      server: true,
      ide: checkIDEConfigured(),
      slack: !!process.env.MERGEN_SLACK_BOT_TOKEN,
      slackChannel: process.env.MERGEN_SLACK_CHANNEL ?? '',
      autopilot: process.env.MERGEN_AUTOPILOT === 'true',
      pagerdutyWebhookUrl: `${process.env.MERGEN_DASHBOARD_URL ?? 'http://your-server:3000'}/webhooks/pagerduty`,
    });
  });

  // ── POST /api/setup/test-slack — Validate Slack bot token ────────────────────
  router.post('/api/setup/test-slack', async (req, res) => {
    const { token, channel } = (req.body ?? {}) as { token?: string; channel?: string };
    const tok = token?.trim() || process.env.MERGEN_SLACK_BOT_TOKEN;
    if (!tok) { res.json({ ok: false, error: 'No token provided' }); return; }
    try {
      const r = await fetch('https://slack.com/api/auth.test', {
        method: 'POST',
        headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
      const d = await r.json() as { ok: boolean; team?: string; user?: string; error?: string };
      if (!d.ok) { res.json({ ok: false, error: d.error }); return; }
      // Test channel write if provided
      if (channel?.trim()) {
        const ch = await fetch('https://slack.com/api/chat.postMessage', {
          method: 'POST',
          headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ channel: channel.trim(), text: '✅ Mergen connected — autonomous incident triage is active.' }),
          signal: AbortSignal.timeout(5000),
        });
        const cd = await ch.json() as { ok: boolean; error?: string };
        if (!cd.ok) { res.json({ ok: false, error: `Token valid but channel post failed: ${cd.error}` }); return; }
      }
      res.json({ ok: true, team: d.team, user: d.user });
    } catch (err) {
      res.json({ ok: false, error: err instanceof Error ? err.message : 'Network error' });
    }
  });

  // ── POST /api/setup/test-otlp — Check if OTLP events have arrived ────────────
  router.get('/api/setup/test-otlp', async (_req, res) => {
    try {
      const r = await fetch('http://127.0.0.1:3000/health', { signal: AbortSignal.timeout(1000) });
      if (!r.ok) { res.json({ ok: false, receiving: false }); return; }
      const d = await r.json() as { buffered?: number; lastEventAt?: number | null };
      const hasRecent = d.lastEventAt ? Date.now() - d.lastEventAt < 5 * 60 * 1000 : false;
      res.json({ ok: true, receiving: hasRecent, buffered: d.buffered ?? 0, lastEventAt: d.lastEventAt });
    } catch { res.json({ ok: false, receiving: false }); }
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
      <h1>⬡ Mergen Setup</h1>
      <p>AI operations layer for backend &amp; infrastructure</p>
    </header>

    <div class="content">
      <div class="step complete" id="step-1">
        <h2><span class="icon">✅</span> Step 1: Server Running</h2>
        <p>Mergen is running at <code>http://127.0.0.1:3000</code> — ready to receive OpenTelemetry, PagerDuty webhooks, and Docker logs.</p>
      </div>

      <div class="step pending" id="step-2">
        <h2><span class="icon">⏳</span> Step 2: Connect Slack</h2>
        <p>Mergen needs a Slack bot token to own incident threads and post autonomous resolution updates.</p>
        <p style="font-size:13px;color:#64748b;margin-bottom:12px">
          1. Create app at <a href="https://api.slack.com/apps" target="_blank">api.slack.com/apps</a> →
          OAuth &amp; Permissions → add scope <code>chat:write</code> → Install → copy Bot Token
        </p>
        <div style="display:flex;gap:10px;margin-bottom:10px;flex-wrap:wrap">
          <input id="slack-token" type="password" placeholder="xoxb-..." style="flex:1;padding:10px 14px;border:2px solid #e2e8f0;border-radius:8px;font-size:14px;min-width:200px">
          <input id="slack-channel" type="text" placeholder="#incidents" style="width:140px;padding:10px 14px;border:2px solid #e2e8f0;border-radius:8px;font-size:14px">
          <button class="primary" onclick="testSlack()" style="flex:0;min-width:120px">Test &amp; Connect</button>
        </div>
        <div id="slack-result"></div>
        <p style="font-size:12px;color:#94a3b8;margin-top:8px">Token is sent only to Slack's API and your own server — never stored in plaintext.</p>
      </div>

      <div class="step pending" id="step-3">
        <h2><span class="icon">⏳</span> Step 3: PagerDuty Webhook</h2>
        <p>Point PagerDuty at Mergen so it can start the autonomous triage loop when an incident fires.</p>
        <div id="pd-url-box" style="background:#1e293b;color:#e2e8f0;padding:14px 18px;border-radius:8px;font-family:monospace;font-size:13px;margin-bottom:12px;word-break:break-all">
          Loading webhook URL…
        </div>
        <p style="font-size:13px;color:#64748b;margin-bottom:12px">
          In PagerDuty: <strong>Services → [your service] → Integrations → Add Webhook → paste the URL above</strong>
        </p>
        <button class="secondary" onclick="copyWebhookUrl()">Copy URL</button>
        <div id="pd-result"></div>
      </div>

      <div class="step pending" id="step-4">
        <h2><span class="icon">⏳</span> Step 4: Send Telemetry</h2>
        <p>Point your services at Mergen via OpenTelemetry — no code changes needed.</p>
        <pre>OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:3000 \\
OTEL_SERVICE_NAME=api \\
node app.js</pre>
        <p style="margin-top:12px;font-size:13px;color:#64748b">Or run the demo to see it working immediately:</p>
        <button class="success" onclick="runDemo()">Run Demo Incident</button>
        <div id="otlp-result"></div>
      </div>

      <div class="step pending" id="step-5">
        <h2><span class="icon">⏳</span> Step 5: Configure AI IDE</h2>
        <p>Let your AI assistant call Mergen's MCP tools directly — <em>"triage the latest incident"</em></p>
        <div class="btn-group">
          <button class="primary" onclick="configureIDE('claude-code')">Claude Code</button>
          <button class="primary" onclick="configureIDE('cursor')">Cursor</button>
          <button class="primary" onclick="configureIDE('vscode')">VS Code</button>
          <button class="primary" onclick="configureIDE('windsurf')">Windsurf</button>
        </div>
        <div id="ide-result"></div>
      </div>
    </div>

    <footer>
      <p>Need help? <a href="https://github.com/omertt27/Mergen" target="_blank">GitHub</a> · <a href="/dashboard">Dashboard →</a></p>
    </footer>
  </div>

  <script>
    let _webhookUrl = '';

    async function testSlack() {
      const token = document.getElementById('slack-token').value.trim();
      const channel = document.getElementById('slack-channel').value.trim();
      const result = document.getElementById('slack-result');
      if (!token) { result.innerHTML = '<div class="alert alert-error">Paste your bot token first.</div>'; return; }
      result.innerHTML = '<div class="alert alert-info">Testing Slack connection…</div>';
      try {
        const r = await fetch('/api/setup/test-slack', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token, channel }),
        });
        const d = await r.json();
        if (d.ok) {
          result.innerHTML = '<div class="alert alert-success">✓ Connected to workspace <strong>' + (d.team||'') + '</strong>' + (channel ? ' — test message posted to ' + channel : '') + '</div>';
          document.getElementById('step-2').className = 'step complete';
          document.getElementById('step-2').querySelector('.icon').textContent = '✅';
        } else {
          result.innerHTML = '<div class="alert alert-error">✗ ' + d.error + ' — check your token has <code>chat:write</code> scope.</div>';
        }
      } catch(e) { result.innerHTML = '<div class="alert alert-error">✗ ' + e.message + '</div>'; }
    }

    function copyWebhookUrl() {
      if (!_webhookUrl) return;
      navigator.clipboard.writeText(_webhookUrl).then(() => {
        document.getElementById('pd-result').innerHTML = '<div class="alert alert-success">✓ Copied to clipboard</div>';
        document.getElementById('step-3').className = 'step complete';
        document.getElementById('step-3').querySelector('.icon').textContent = '✅';
      });
    }

    async function runDemo() {
      const result = document.getElementById('otlp-result');
      result.innerHTML = '<div class="alert alert-info">Injecting demo incident…</div>';
      try {
        const ts = Date.now();
        await fetch('/ingest', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'console', level: 'error', args: ['[api] database connection pool exhausted — 0 connections available after 30s timeout'], url: 'http://api:8080/health', timestamp: ts }) });
        await fetch('/ingest', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'network', method: 'GET', url: 'http://api:8080/api/users', status: 503, duration: 30421, error: 'upstream connect error', timestamp: ts + 100 }) });
        await new Promise(r => setTimeout(r, 600));
        const h = await fetch('/health').then(r => r.json());
        result.innerHTML = '<div class="alert alert-success">✓ Demo incident injected — ' + (h.buffered||0) + ' events in buffer.<br><strong>In your AI IDE:</strong> "triage the latest incident"<br>Or check the <a href="/dashboard">dashboard →</a></div>';
        document.getElementById('step-4').className = 'step complete';
        document.getElementById('step-4').querySelector('.icon').textContent = '✅';
      } catch(e) { result.innerHTML = '<div class="alert alert-error">✗ ' + e.message + '</div>'; }
    }

    async function configureIDE(ide) {
      const result = document.getElementById('ide-result');
      result.innerHTML = '<div class="alert alert-info">Configuring…</div>';
      try {
        const r = await fetch('/api/setup/ide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ide }) });
        const d = await r.json();
        if (r.ok) {
          result.innerHTML = '<div class="alert alert-success">✓ ' + d.message + ' — restart your IDE, then ask: <strong>"Triage the latest incident"</strong></div>';
          document.getElementById('step-5').className = 'step complete';
          document.getElementById('step-5').querySelector('.icon').textContent = '✅';
        } else {
          result.innerHTML = '<div class="alert alert-error">✗ ' + d.error + '</div>';
        }
      } catch(e) { result.innerHTML = '<div class="alert alert-error">✗ ' + e.message + '</div>'; }
    }

    window.addEventListener('load', async () => {
      try {
        const s = await fetch('/api/setup/status').then(r => r.json());
        if (s.ide) { document.getElementById('step-5').className = 'step complete'; document.getElementById('step-5').querySelector('.icon').textContent = '✅'; }
        if (s.slack) { document.getElementById('step-2').className = 'step complete'; document.getElementById('step-2').querySelector('.icon').textContent = '✅'; }
        if (s.pagerdutyWebhookUrl) {
          _webhookUrl = s.pagerdutyWebhookUrl;
          document.getElementById('pd-url-box').textContent = s.pagerdutyWebhookUrl;
        }
      } catch(e) { console.error('Status load failed:', e); }
    });
  </script>
</body>
</html>`;

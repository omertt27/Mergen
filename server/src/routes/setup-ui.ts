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
      slackEventsWebhookUrl: `${process.env.MERGEN_DASHBOARD_URL ?? 'http://your-server:3000'}/webhooks/slack/events`,
      adrWebhookUrl: `${process.env.MERGEN_DASHBOARD_URL ?? 'http://your-server:3000'}/ci/adr`,
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
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Outfit', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      background: radial-gradient(circle at 50% 50%, #0f172a 0%, #020617 100%);
      color: #f1f5f9;
      min-height: 100vh;
      padding: 40px 20px;
      -webkit-font-smoothing: antialiased;
    }
    .container {
      max-width: 800px;
      margin: 0 auto;
      background: rgba(30, 41, 59, 0.45);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 24px;
      overflow: hidden;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
    }
    header {
      background: linear-gradient(135deg, rgba(99, 102, 241, 0.15) 0%, rgba(139, 92, 246, 0.15) 100%);
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      color: white;
      padding: 50px 40px;
      text-align: center;
      position: relative;
    }
    header::after {
      content: '';
      position: absolute;
      bottom: 0;
      left: 10%;
      right: 10%;
      height: 1px;
      background: linear-gradient(to right, transparent, rgba(99, 102, 241, 0.4), transparent);
    }
    header h1 {
      font-size: 38px;
      font-weight: 800;
      margin-bottom: 10px;
      letter-spacing: -0.03em;
      background: linear-gradient(135deg, #a5b4fc 0%, #c084fc 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    header p {
      font-size: 16px;
      color: #94a3b8;
      font-weight: 400;
      letter-spacing: 0.01em;
    }
    .content { padding: 40px; }
    .step {
      padding: 30px;
      background: rgba(30, 41, 59, 0.2);
      border: 1px solid rgba(255, 255, 255, 0.06);
      border-radius: 16px;
      margin: 24px 0;
      transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .step:hover {
      border-color: rgba(99, 102, 241, 0.3);
      box-shadow: 0 8px 30px rgba(99, 102, 241, 0.1);
      transform: translateY(-2px);
    }
    .step h2 {
      font-size: 20px;
      font-weight: 600;
      margin-bottom: 15px;
      display: flex;
      align-items: center;
      gap: 12px;
      letter-spacing: -0.02em;
    }
    .step p { color: #94a3b8; margin-bottom: 15px; line-height: 1.6; font-size: 14px; }
    .step.complete {
      background: rgba(16, 185, 129, 0.05);
      border-color: rgba(16, 185, 129, 0.2);
    }
    .step.complete h2 { color: #34d399; }
    .step.pending {
      background: rgba(245, 158, 11, 0.03);
      border-color: rgba(245, 158, 11, 0.15);
    }
    .step.pending h2 { color: #fbbf24; }
    .step.error {
      background: rgba(239, 68, 68, 0.05);
      border-color: rgba(239, 68, 68, 0.2);
    }
    .step.error h2 { color: #f87171; }
    .icon { font-size: 22px; display: inline-flex; align-items: center; justify-content: center; }
    .btn-group { display: flex; gap: 12px; flex-wrap: wrap; }
    button {
      padding: 12px 24px;
      font-size: 14px;
      font-weight: 600;
      font-family: 'Outfit', sans-serif;
      border: 1px solid transparent;
      border-radius: 10px;
      cursor: pointer;
      transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
      flex: 1;
      min-width: 120px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
    }
    button:active { transform: scale(0.97); }
    button.primary {
      background: linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%);
      color: white;
      box-shadow: 0 4px 14px rgba(99, 102, 241, 0.3);
    }
    button.primary:hover {
      box-shadow: 0 6px 20px rgba(99, 102, 241, 0.4);
      filter: brightness(1.1);
    }
    button.secondary {
      background: rgba(255, 255, 255, 0.05);
      color: #f1f5f9;
      border-color: rgba(255, 255, 255, 0.08);
    }
    button.secondary:hover {
      background: rgba(255, 255, 255, 0.1);
      border-color: rgba(255, 255, 255, 0.2);
    }
    button.success {
      background: linear-gradient(135deg, #059669 0%, #10b981 100%);
      color: white;
      box-shadow: 0 4px 14px rgba(16, 185, 129, 0.25);
    }
    button.success:hover {
      box-shadow: 0 6px 20px rgba(16, 185, 129, 0.35);
      filter: brightness(1.1);
    }
    button:disabled { opacity: 0.4; cursor: not-allowed; transform: none; box-shadow: none !important; }
    
    input {
      flex: 1;
      padding: 12px 16px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 10px;
      font-size: 14px;
      min-width: 200px;
      background: rgba(15, 23, 42, 0.5);
      color: #f1f5f9;
      font-family: inherit;
      transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
    }
    input:focus {
      outline: none;
      border-color: rgba(99, 102, 241, 0.5);
      box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.25);
      background: rgba(15, 23, 42, 0.85);
    }
    
    pre {
      background: #0b0f19;
      color: #cbd5e1;
      border: 1px solid rgba(255, 255, 255, 0.06);
      padding: 20px;
      border-radius: 12px;
      overflow-x: auto;
      font-family: 'JetBrains Mono', 'Fira Code', monospace;
      font-size: 13px;
      line-height: 1.6;
      margin: 15px 0;
    }
    .alert {
      padding: 16px;
      border-radius: 10px;
      margin: 15px 0;
      font-size: 13px;
      line-height: 1.5;
      display: flex;
      align-items: center;
      gap: 10px;
      border: 1px solid transparent;
    }
    .alert-success {
      background: rgba(16, 185, 129, 0.08);
      color: #a7f3d0;
      border-color: rgba(16, 185, 129, 0.25);
    }
    .alert-error {
      background: rgba(239, 68, 68, 0.08);
      color: #fca5a5;
      border-color: rgba(239, 68, 68, 0.25);
    }
    .alert-info {
      background: rgba(59, 130, 246, 0.08);
      color: #bfdbfe;
      border-color: rgba(59, 130, 246, 0.25);
    }
    a { color: #818cf8; text-decoration: none; font-weight: 600; transition: color 0.15s; }
    a:hover { color: #a5b4fc; text-decoration: underline; }
    footer { text-align: center; padding: 40px 30px; color: #64748b; font-size: 13px; border-top: 1px solid rgba(255, 255, 255, 0.04); }
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
          <input id="slack-token" type="password" placeholder="xoxb-..." style="flex:1;padding:12px 16px;border:1px solid rgba(255,255,255,0.1);border-radius:10px;font-size:14px;min-width:200px;background:rgba(15,23,42,0.5);color:#f1f5f9;outline:none">
          <input id="slack-channel" type="text" placeholder="#incidents" style="width:140px;padding:12px 16px;border:1px solid rgba(255,255,255,0.1);border-radius:10px;font-size:14px;background:rgba(15,23,42,0.5);color:#f1f5f9;outline:none">
          <button class="primary" onclick="testSlack()" style="flex:0;min-width:120px">Test &amp; Connect</button>
        </div>
        <div id="slack-result"></div>
        <p style="font-size:12px;color:#64748b;margin-top:8px">Token is sent only to Slack's API and your own server — never stored in plaintext.</p>
      </div>

      <div class="step pending" id="step-3">
        <h2><span class="icon">⏳</span> Step 3: PagerDuty Webhook</h2>
        <p>Point PagerDuty at Mergen so it can start the autonomous triage loop when an incident fires.</p>
        <div id="pd-url-box" style="background:#0b0f19;color:#cbd5e1;padding:14px 18px;border:1px solid rgba(255,255,255,0.06);border-radius:10px;font-family:'JetBrains Mono',monospace;font-size:13px;margin-bottom:12px;word-break:break-all">
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

      <div class="step complete" id="step-6">
        <h2><span class="icon">✅</span> Step 6: Continuous Flywheel (Compounding Memory)</h2>
        <p>Enable Phase 4 Continuous Flywheel to automatically extract override policies from Slack threads and git decisions.</p>
        <p style="margin-bottom:8px"><strong>Slack Postmortems Webhook:</strong> Point your Slack App's <em>Event Subscriptions</em> to:</p>
        <div id="slack-events-url-box" style="background:#0b0f19;color:#cbd5e1;padding:14px 18px;border:1px solid rgba(255,255,255,0.06);border-radius:10px;font-family:'JetBrains Mono',monospace;font-size:13px;margin-bottom:12px;word-break:break-all">
          Loading slack events URL…
        </div>
        <p style="font-size:13px;color:#64748b;margin-bottom:12px">Subscribe to <code>message.channels</code> events (ensure your bot is added to postmortem channels).</p>
        
        <p style="margin-bottom:8px"><strong>Git ADR Webhook:</strong> Point your repository's commit or ADR webhook to:</p>
        <div id="adr-events-url-box" style="background:#0b0f19;color:#cbd5e1;padding:14px 18px;border:1px solid rgba(255,255,255,0.06);border-radius:10px;font-family:'JetBrains Mono',monospace;font-size:13px;margin-bottom:12px;word-break:break-all">
          Loading ADR webhook URL…
        </div>
        <p style="font-size:13px;color:#64748b;margin-bottom:12px">Submit architectural decisions via JSON to compile override corpus rules automatically.</p>
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
        if (s.slackEventsWebhookUrl) {
          document.getElementById('slack-events-url-box').textContent = s.slackEventsWebhookUrl;
        }
        if (s.adrWebhookUrl) {
          document.getElementById('adr-events-url-box').textContent = s.adrWebhookUrl;
        }
      } catch(e) { console.error('Status load failed:', e); }
    });
  </script>
</body>
</html>`;

import * as vscode from 'vscode';

interface SessionSignal {
  kind: string;
  message: string;
  count: number;
  confidence: number;
  suggestedTool: string;
}

interface HealthResponse {
  ok: boolean;
  buffered: number;
  errors: number;
  warnings: number;
  networkErrors: number;
  signals: SessionSignal[];
  version: string;
}

interface UsageSnapshot {
  planName: string;
  month: string;
  resetsAt: string;
  used: number;
  included: number | null;
  remaining: number | null;
  lowCredits: boolean;
  overage: number;
  billingStatus: 'pending' | 'confirmed';
  overagePendingCredits: number;
  overageCentsPerCredit: number;
  estimatedOverageCents: number;
  toolCallCounts?: Record<string, number>;
}

interface ServerState {
  connected: boolean;
  port: number;
  health: HealthResponse | null;
  usage: UsageSnapshot | null;
  error: string | null;
}

export class MergenPanel implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private _state: ServerState = { connected: false, port: 3000, health: null, usage: null, error: null };
  private _pollTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly _context: vscode.ExtensionContext) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._context.extensionUri],
    };

    webviewView.webview.html = this._getHtml();

    // Handle messages from the webview
    webviewView.webview.onDidReceiveMessage(async (msg: { type: string; tool?: string }) => {
      if (msg.type === 'clear') await this.clearBuffer();
      if (msg.type === 'refresh') await this.refresh();
      if (msg.type === 'ready') await this._poll();
      if (msg.type === 'runTool' && msg.tool) {
        // Open the AI chat panel with the tool name pre-filled (Cursor / Copilot Chat).
        // The tool name is already on the clipboard; user just needs to hit Enter.
        const chatInput = `Run ${msg.tool}`;
        await vscode.commands.executeCommand(
          'workbench.action.chat.open',
          { query: chatInput },
        ).then(undefined, () => {
          // Fallback when chat extension is not present.
          vscode.window.showInformationMessage(
            `Paste into your AI chat: ${msg.tool!}()`,
            'Copy',
          ).then(action => {
            if (action === 'Copy') vscode.env.clipboard.writeText(msg.tool! + '()');
          });
        });
      }
    });

    // Start polling
    this._startPolling();

    webviewView.onDidDispose(() => this._stopPolling());
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  async clearBuffer(): Promise<void> {
    const port = this._getPort();
    try {
      await fetch(`http://127.0.0.1:${port}/clear`, { method: 'POST', signal: AbortSignal.timeout(3000) });
      await this._poll();
    } catch {
      // server not running — panel will show disconnected state
    }
  }

  async refresh(): Promise<void> {
    await this._poll();
  }

  // ── Polling ─────────────────────────────────────────────────────────────────

  private _getPort(): number {
    return vscode.workspace.getConfiguration('mergen').get<number>('serverPort', 3000);
  }

  private _getInterval(): number {
    return vscode.workspace.getConfiguration('mergen').get<number>('pollIntervalMs', 2000);
  }

  private _startPolling(): void {
    this._stopPolling();
    const tick = async () => {
      await this._poll();
      this._pollTimer = setTimeout(tick, this._getInterval());
    };
    tick();
  }

  private _stopPolling(): void {
    if (this._pollTimer) { clearTimeout(this._pollTimer); this._pollTimer = undefined; }
  }

  private async _poll(): Promise<void> {
    const port = this._getPort();
    try {
      const [healthRes, usageRes] = await Promise.all([
        fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) }),
        fetch(`http://127.0.0.1:${port}/usage`,  { signal: AbortSignal.timeout(2000) }),
      ]);
      const health = await healthRes.json() as HealthResponse;
      const usage  = await usageRes.json()  as UsageSnapshot;
      this._state = { connected: true, port, health, usage, error: null };
    } catch {
      // Try adjacent ports (3001–3010)
      const found = await this._discoverPort(port);
      if (!found) {
        this._state = { connected: false, port, health: null, usage: null, error: 'Server not running on port ' + port };
      }
    }
    this._send({ type: 'state', state: this._state });
  }

  private async _discoverPort(basePort: number): Promise<boolean> {
    for (let p = basePort + 1; p <= basePort + 10; p++) {
      try {
        const res = await fetch(`http://127.0.0.1:${p}/health`, { signal: AbortSignal.timeout(500) });
        if (res.ok) {
          const [health, usageRes] = await Promise.all([
            res.json() as Promise<HealthResponse>,
            fetch(`http://127.0.0.1:${p}/usage`, { signal: AbortSignal.timeout(500) }).then(r => r.json() as Promise<UsageSnapshot>),
          ]);
          this._state = { connected: true, port: p, health, usage: usageRes, error: null };
          // Update config so next poll uses the right port
          await vscode.workspace.getConfiguration('mergen').update('serverPort', p, vscode.ConfigurationTarget.Workspace);
          return true;
        }
      } catch { /* try next */ }
    }
    return false;
  }

  private _send(msg: unknown): void {
    this._view?.webview.postMessage(msg);
  }

  // ── HTML ─────────────────────────────────────────────────────────────────────

  private _getHtml(): string {
    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<title>Mergen</title>
<style>
  :root {
    --radius: 6px;
    --gap: 10px;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background);
    padding: 12px 10px;
    line-height: 1.45;
  }

  /* ── Header ── */
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 14px;
  }
  .header-title {
    font-weight: 700;
    font-size: 13px;
    letter-spacing: .03em;
    color: var(--vscode-foreground);
  }
  .dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    display: inline-block;
    margin-right: 6px;
    background: var(--vscode-charts-red);
    transition: background .3s;
  }
  .dot.ok { background: var(--vscode-charts-green); }

  /* ── Cards ── */
  .card {
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-widget-border, rgba(127,127,127,.2));
    border-radius: var(--radius);
    padding: 10px 12px;
    margin-bottom: var(--gap);
  }
  .card-title {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: .08em;
    text-transform: uppercase;
    color: var(--vscode-descriptionForeground);
    margin-bottom: 8px;
  }

  /* ── Stat row ── */
  .stats {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 6px;
  }
  .stat {
    background: var(--vscode-sideBar-background);
    border-radius: 4px;
    padding: 6px 8px;
    text-align: center;
  }
  .stat-value {
    font-size: 20px;
    font-weight: 700;
    line-height: 1;
  }
  .stat-label {
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    margin-top: 2px;
  }
  .stat-value.red   { color: var(--vscode-charts-red); }
  .stat-value.amber { color: var(--vscode-charts-yellow); }
  .stat-value.blue  { color: var(--vscode-charts-blue); }

  /* ── Credit bar ── */
  .credit-bar-wrap {
    background: var(--vscode-sideBar-background);
    border-radius: 4px;
    height: 6px;
    overflow: hidden;
    margin: 8px 0 4px;
  }
  .credit-bar-fill {
    height: 100%;
    border-radius: 4px;
    background: var(--vscode-charts-blue);
    transition: width .4s ease;
  }
  .credit-bar-fill.warn { background: var(--vscode-charts-yellow); }
  .credit-bar-fill.over { background: var(--vscode-charts-red); }
  .credit-meta {
    display: flex;
    justify-content: space-between;
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
  }

  /* ── Row ── */
  .row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 3px 0;
    border-bottom: 1px solid var(--vscode-widget-border, rgba(127,127,127,.1));
  }
  .row:last-child { border-bottom: none; }
  .row-label { color: var(--vscode-descriptionForeground); font-size: 11px; }
  .row-value { font-size: 11px; font-weight: 600; }

  /* ── Notice ── */
  .notice {
    background: rgba(var(--vscode-charts-yellow-rgb, 255,200,0), .12);
    border-left: 3px solid var(--vscode-charts-yellow);
    border-radius: 0 4px 4px 0;
    padding: 6px 10px;
    font-size: 11px;
    margin-bottom: var(--gap);
    display: none;
  }
  .notice.visible { display: block; }

  /* ── Disconnected state ── */
  .disconnected {
    text-align: center;
    padding: 24px 12px;
    color: var(--vscode-descriptionForeground);
  }
  .disconnected .icon { font-size: 32px; margin-bottom: 8px; }
  .disconnected code {
    display: inline-block;
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-widget-border, rgba(127,127,127,.2));
    border-radius: 4px;
    padding: 2px 6px;
    font-family: var(--vscode-editor-font-family);
    font-size: 11px;
    margin-top: 6px;
  }

  /* ── Buttons ── */
  .btn-row {
    display: flex;
    gap: 6px;
    margin-top: 4px;
  }
  button {
    flex: 1;
    padding: 5px 10px;
    border: 1px solid var(--vscode-button-border, transparent);
    border-radius: 4px;
    cursor: pointer;
    font-size: 11px;
    font-family: inherit;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    transition: opacity .15s;
  }
  button:hover { opacity: .85; }
  button.primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }

  /* ── Plan badge ── */
  .badge {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: .04em;
    text-transform: uppercase;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    border-radius: 3px;
    padding: 1px 5px;
  }

  .billing-pending { color: var(--vscode-charts-yellow); }
  .billing-confirmed { color: var(--vscode-charts-green); }

  /* ── Signals / nudge card ── */
  .signal-item {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    padding: 6px 0;
    border-bottom: 1px solid var(--vscode-widget-border, rgba(127,127,127,.1));
    font-size: 11px;
  }
  .signal-item:last-child { border-bottom: none; }
  .signal-icon { flex-shrink: 0; margin-top: 1px; }
  .signal-body { flex: 1; min-width: 0; }
  .signal-msg { color: var(--vscode-foreground); line-height: 1.4; }
  .signal-meta {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 4px;
  }
  /* Confidence bar */
  .conf-bar-wrap {
    flex: 1;
    background: var(--vscode-sideBar-background);
    border-radius: 3px;
    height: 4px;
    overflow: hidden;
  }
  .conf-bar-fill {
    height: 100%;
    border-radius: 3px;
    background: var(--vscode-charts-blue);
  }
  .conf-bar-fill.med  { background: var(--vscode-charts-yellow); }
  .conf-bar-fill.low  { background: var(--vscode-descriptionForeground); }
  .conf-pct {
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    white-space: nowrap;
    flex-shrink: 0;
  }
  /* Run button */
  .signal-run {
    display: inline-block;
    margin-top: 5px;
    padding: 2px 8px;
    font-size: 10px;
    border: 1px solid var(--vscode-button-border, transparent);
    border-radius: 3px;
    cursor: pointer;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    font-family: inherit;
    white-space: nowrap;
  }
  .signal-run:hover { opacity: .85; }
</style>
</head>
<body>

<!-- Header -->
<div class="header">
  <span class="header-title"><span class="dot" id="dot"></span>Mergen</span>
  <span class="badge" id="plan-badge">—</span>
</div>

<!-- Low-credit notice -->
<div class="notice" id="notice"></div>

<!-- Disconnected state -->
<div class="disconnected" id="disconnected" style="display:none">
  <div class="icon">⚡</div>
  <div>Server not running.</div>
  <div style="margin-top:6px">Start it with:</div>
  <code>cd server &amp;&amp; npm start</code>
</div>

<!-- Buffer stats -->
<div class="card" id="card-buffer" style="display:none">
  <div class="card-title">Buffer</div>
  <div class="stats">
    <div class="stat">
      <div class="stat-value red"   id="stat-errors">0</div>
      <div class="stat-label">Errors</div>
    </div>
    <div class="stat">
      <div class="stat-value amber" id="stat-warns">0</div>
      <div class="stat-label">Warnings</div>
    </div>
    <div class="stat">
      <div class="stat-value blue"  id="stat-net">0</div>
      <div class="stat-label">Net Errors</div>
    </div>
  </div>
  <div class="btn-row" style="margin-top:10px">
    <button class="primary" onclick="send('refresh')">↺ Refresh</button>
    <button onclick="send('clear')">✕ Clear</button>
  </div>
</div>

<!-- Proactive signals -->
<div class="card" id="card-signals" style="display:none">
  <div class="card-title">Detected Patterns</div>
  <div id="signals-list"></div>
</div>

<!-- Credits -->
<div class="card" id="card-usage" style="display:none">
  <div class="card-title">Credits — <span id="usage-month"></span></div>
  <div id="usage-unlimited" style="display:none">
    <div class="row">
      <span class="row-label">Used this month</span>
      <span class="row-value" id="usage-used-unlim">0</span>
    </div>
    <div class="row">
      <span class="row-label">Quota</span>
      <span class="row-value">Unlimited ∞</span>
    </div>
  </div>
  <div id="usage-quota" style="display:none">
    <div class="credit-bar-wrap">
      <div class="credit-bar-fill" id="credit-bar"></div>
    </div>
    <div class="credit-meta">
      <span id="usage-used-label">0 / 0 used</span>
      <span id="usage-remaining-label">0 left</span>
    </div>
    <div id="usage-overage" style="display:none; margin-top:8px">
      <div class="row">
        <span class="row-label">Overage calls</span>
        <span class="row-value red" id="overage-count">0</span>
      </div>
      <div class="row">
        <span class="row-label">Estimated charge</span>
        <span class="row-value" id="overage-est">$0.00</span>
      </div>
      <div class="row">
        <span class="row-label">Billing status</span>
        <span class="row-value" id="billing-status">—</span>
      </div>
    </div>
  </div>
  <div class="row" style="margin-top:6px">
    <span class="row-label">Resets</span>
    <span class="row-value" id="usage-resets">—</span>
  </div>
</div>

<!-- Server info -->
<div class="card" id="card-server" style="display:none">
  <div class="card-title">Server</div>
  <div class="row">
    <span class="row-label">Port</span>
    <span class="row-value" id="server-port">—</span>
  </div>
  <div class="row">
    <span class="row-label">Version</span>
    <span class="row-value" id="server-version">—</span>
  </div>
  <div class="row">
    <span class="row-label">Buffer</span>
    <span class="row-value" id="server-buffered">—</span>
  </div>
</div>

<script>
  const vscode = acquireVsCodeApi();

  function send(type) { vscode.postMessage({ type }); }

  function escHtml(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // One-click: copy the MCP tool call to clipboard so the user can paste it
  // into any AI chat (Cursor, Copilot Chat, Claude, etc.) immediately.
  function copyTool(toolName) {
    const cmd = toolName + '()';
    navigator.clipboard?.writeText(cmd).catch(() => {});
    vscode.postMessage({ type: 'runTool', tool: toolName });
  }

  // Signal ready to start polling
  send('ready');

  window.addEventListener('message', ({ data }) => {
    if (data.type === 'state') render(data.state);
  });

  function render(state) {
    const connected = state.connected;
    document.getElementById('dot').className       = 'dot' + (connected ? ' ok' : '');
    document.getElementById('disconnected').style.display  = connected ? 'none' : 'block';
    document.getElementById('card-buffer').style.display   = connected ? 'block' : 'none';
    document.getElementById('card-usage').style.display    = connected ? 'block' : 'none';
    document.getElementById('card-server').style.display   = connected ? 'block' : 'none';

    if (!connected) return;

    const h = state.health;
    const u = state.usage;

    // Plan badge
    document.getElementById('plan-badge').textContent = u?.planName ?? '—';

    // Buffer stats
    document.getElementById('stat-errors').textContent  = h.errors;
    document.getElementById('stat-warns').textContent   = h.warnings;
    document.getElementById('stat-net').textContent     = h.networkErrors;

    // Signals card
    const signals = h.signals ?? [];
    const signalsCard = document.getElementById('card-signals');
    const signalsList = document.getElementById('signals-list');
    if (signals.length > 0) {
      signalsCard.style.display = 'block';
      const ICON = {
        repeated_network_error: '🔁',
        warn_spike: '⚠️',
        repeated_error: '❌',
        slow_requests: '🐢',
      };
      // Map each signal to its suggested free tool, then the paid upsell
      const TOOL_LABEL = {
        quick_check:     '⚡ Run quick_check',
        explain_warning: '⚡ Run explain_warning',
        session_summary: '⚡ Run session_summary',
      };
      signalsList.innerHTML = signals.map(s => {
        const icon      = ICON[s.kind] ?? '🔍';
        const confPct   = Math.round((s.confidence ?? 0) * 100);
        const barClass  = confPct >= 80 ? '' : confPct >= 60 ? ' med' : ' low';
        const toolKey   = s.suggestedTool ?? 'quick_check';
        const toolLabel = TOOL_LABEL[toolKey] ?? '⚡ Run ' + toolKey;
        return '<div class="signal-item">' +
          '<span class="signal-icon">' + icon + '</span>' +
          '<div class="signal-body">' +
            '<div class="signal-msg">' + escHtml(s.message) + '</div>' +
            '<div class="signal-meta">' +
              '<div class="conf-bar-wrap"><div class="conf-bar-fill' + barClass + '" style="width:' + confPct + '%"></div></div>' +
              '<span class="conf-pct">' + confPct + '%</span>' +
            '</div>' +
            '<button class="signal-run" onclick="copyTool(' + JSON.stringify(toolKey) + ')">' + escHtml(toolLabel) + '</button>' +
          '</div>' +
        '</div>';
      }).join('');
    } else {
      signalsCard.style.display = 'none';
    }

    // Server info
    document.getElementById('server-port').textContent     = state.port;
    document.getElementById('server-version').textContent  = h.version;
    document.getElementById('server-buffered').textContent = h.buffered + ' events';

    // Usage
    document.getElementById('usage-month').textContent  = u.month;
    document.getElementById('usage-resets').textContent = fmtDate(u.resetsAt);

    if (u.included === null) {
      // Unlimited
      document.getElementById('usage-unlimited').style.display = 'block';
      document.getElementById('usage-quota').style.display     = 'none';
      document.getElementById('usage-used-unlim').textContent  = u.used;
    } else {
      document.getElementById('usage-unlimited').style.display = 'none';
      document.getElementById('usage-quota').style.display     = 'block';

      const pct = u.included > 0 ? Math.min(1, u.used / u.included) : 1;
      const bar = document.getElementById('credit-bar');
      bar.style.width = (pct * 100) + '%';
      bar.className   = 'credit-bar-fill' + (u.lowCredits ? ' warn' : '') + (u.overage > 0 ? ' over' : '');

      document.getElementById('usage-used-label').textContent      = u.used + ' / ' + u.included + ' used';
      document.getElementById('usage-remaining-label').textContent = (u.remaining ?? 0) + ' left';

      // Low-credit notice
      const notice = document.getElementById('notice');
      if (u.lowCredits) {
        notice.textContent = '⚠ Only ' + u.remaining + ' credits left this month.';
        notice.className   = 'notice visible';
      } else {
        notice.className   = 'notice';
      }

      // Overage
      if (u.overage > 0) {
        document.getElementById('usage-overage').style.display = 'block';
        document.getElementById('overage-count').textContent   = u.overage;
        document.getElementById('overage-est').textContent     = '$' + (u.estimatedOverageCents / 100).toFixed(2);
        const bs = document.getElementById('billing-status');
        bs.textContent = u.billingStatus === 'confirmed' ? '✅ confirmed' : '⏳ pending';
        bs.className   = 'row-value ' + (u.billingStatus === 'confirmed' ? 'billing-confirmed' : 'billing-pending');
      } else {
        document.getElementById('usage-overage').style.display = 'none';
      }
    }
  }

  function fmtDate(iso) {
    try {
      return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
    } catch { return iso; }
  }
</script>
</body>
</html>`;
  }
}

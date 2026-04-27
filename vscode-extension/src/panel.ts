import * as vscode from 'vscode';

interface SessionSignal {
  kind: string;
  message: string;
  action: string;
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
  /** Watcher KPI — automatic causal-chain rebuilds today / 7-day avg. */
  analysesToday?: number;
  analysesAvgPerDay7d?: number;
}

interface Hypothesis {
  tag: string;
  summary: string;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'INSUFFICIENT';
  confidenceScore: number;
  evidence: string[];
  causalPath: string[];
  fixHint: string | null;
}

interface LastPack {
  hasPack: boolean;
  builtAt?: number;
  builtAtIso?: string;
  triggerMessage?: string;
  /** New: why the pack was built — pageload, hmr, error, periodic, … */
  reason?: string;
  topHypothesis?: Hypothesis | null;
  contextPack?: string;
  hypothesesCount?: number;
  errorsCount?: number;
}

interface HistoryEntry {
  builtAt: number;
  builtAtIso: string;
  triggerMessage: string;
  reason?: string;
  topHypothesis: Hypothesis | null;
}

interface ServerState {
  connected: boolean;
  port: number;
  health: HealthResponse | null;
  usage: UsageSnapshot | null;
  lastPack: LastPack | null;
  history: HistoryEntry[];
  error: string | null;
}

export class MergenPanel implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private _state: ServerState = {
    connected: false, port: 3000, health: null, usage: null,
    lastPack: null, history: [], error: null,
  };
  private _pollTimer?: ReturnType<typeof setTimeout>;
  private _statusBar: vscode.StatusBarItem;

  constructor(private readonly _context: vscode.ExtensionContext) {
    // Always-visible status bar item — this is the engagement hook during
    // normal dev flow, not just when things break.
    this._statusBar = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      90,  // priority: right of language selector, left of encoding
    );
    this._statusBar.name = 'Mergen';
    this._statusBar.command = 'mergen.openPanel';
    this._statusBar.text = '$(circle-slash) Mergen';
    this._statusBar.tooltip = 'Mergen — click to open panel';
    this._statusBar.show();
    this._context.subscriptions.push(this._statusBar);
  }

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
    webviewView.webview.onDidReceiveMessage(async (msg: { type: string; tool?: string; text?: string; command?: string }) => {
      if (msg.type === 'clear') await this.clearBuffer();
      if (msg.type === 'refresh') await this.refresh();
      if (msg.type === 'ready') await this._poll();
      if (msg.type === 'runCommand' && msg.command) {
        // Whitelist of commands the webview can trigger. This is the bridge
        // that makes the disconnected card actionable for Marketplace users.
        const ALLOWED = new Set([
          'mergen.startServer',
          'mergen.installExtension',
          'mergen.sendFeedback',
          'mergen.openPanel',
          'mergen.refresh',
          'mergen.clearBuffer',
        ]);
        if (ALLOWED.has(msg.command)) {
          await vscode.commands.executeCommand(msg.command);
        }
      }
      if (msg.type === 'copyPack' && msg.text) {
        await vscode.env.clipboard.writeText(msg.text);
        vscode.window.showInformationMessage('Mergen: Context Pack copied to clipboard.');
      }
      if (msg.type === 'sendToChat' && msg.text) {
        await vscode.commands.executeCommand(
          'workbench.action.chat.open',
          { query: msg.text },
        ).then(undefined, async () => {
          await vscode.env.clipboard.writeText(msg.text!);
          vscode.window.showInformationMessage('Mergen: Context Pack copied — paste into your AI chat.');
        });
      }
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

  private async _fetchAll(port: number, timeoutMs: number): Promise<{
    health: HealthResponse;
    usage: UsageSnapshot;
    lastPack: LastPack;
    history: HistoryEntry[];
  } | null> {
    try {
      const opt = { signal: AbortSignal.timeout(timeoutMs) };
      const [health, usage, lastPack, history] = await Promise.all([
        fetch(`http://127.0.0.1:${port}/health`,    opt).then(r => r.json() as Promise<HealthResponse>),
        fetch(`http://127.0.0.1:${port}/usage`,     opt).then(r => r.json() as Promise<UsageSnapshot>),
        fetch(`http://127.0.0.1:${port}/last-pack`, opt).then(r => r.json() as Promise<LastPack>)
          .catch(() => ({ hasPack: false } as LastPack)),
        fetch(`http://127.0.0.1:${port}/history`,   opt).then(r => r.json() as Promise<{ entries: HistoryEntry[] }>)
          .then(d => d.entries ?? []).catch(() => []),
      ]);
      return { health, usage, lastPack, history };
    } catch {
      return null;
    }
  }

  private async _poll(): Promise<void> {
    const port = this._getPort();
    const result = await this._fetchAll(port, 2000);
    if (result) {
      this._state = {
        connected: true, port,
        health: result.health, usage: result.usage,
        lastPack: result.lastPack, history: result.history,
        error: null,
      };
    } else {
      const found = await this._discoverPort(port);
      if (!found) {
        this._state = {
          connected: false, port,
          health: null, usage: null,
          lastPack: null, history: [],
          error: 'Server not running on port ' + port,
        };
      }
    }
    this._send({ type: 'state', state: this._state });
  }

  private async _discoverPort(basePort: number): Promise<boolean> {
    for (let p = basePort + 1; p <= basePort + 10; p++) {
      const result = await this._fetchAll(p, 500);
      if (result) {
        this._state = {
          connected: true, port: p,
          health: result.health, usage: result.usage,
          lastPack: result.lastPack, history: result.history,
          error: null,
        };
        await vscode.workspace.getConfiguration('mergen').update('serverPort', p, vscode.ConfigurationTarget.Workspace);
        return true;
      }
    }
    return false;
  }

  private _send(msg: unknown): void {
    this._view?.webview.postMessage(msg);
    // Keep the status bar in sync on every state update so it's always live
    // even when the panel is hidden — this is the always-on engagement hook.
    if ((msg as { type?: string }).type === 'state') {
      this._updateStatusBar((msg as { state: ServerState }).state);
    }
  }

  private _updateStatusBar(state: ServerState): void {
    if (!state.connected) {
      this._statusBar.text = '$(circle-slash) Mergen';
      this._statusBar.tooltip = 'Mergen — server not running. Click to open panel.';
      this._statusBar.backgroundColor = undefined;
      return;
    }

    const h = state.health;
    if (!h) return;

    const signals  = h.signals ?? [];
    const errors   = h.errors;
    const warns    = h.warnings;
    const netErrs  = h.networkErrors;

    // Choose the most prominent indicator to surface in the status bar.
    // The goal: developer glances at the bar and knows immediately whether
    // something needs attention — even mid-flow, before anything crashes.
    if (errors > 0) {
      this._statusBar.text = `$(error) Mergen ${errors} err`;
      this._statusBar.tooltip = `Mergen — ${errors} error(s) in buffer. Click to open panel.`;
      this._statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else if (signals.length > 0) {
      // Highest-confidence signal drives the message
      const top = signals[0];
      const confPct = Math.round(top.confidence * 100);
      this._statusBar.text = `$(warning) Mergen ${signals.length} signal${signals.length > 1 ? 's' : ''}`;
      this._statusBar.tooltip = `Mergen — ${top.message} (${confPct}% confidence). Click to open panel.`;
      this._statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else if (warns > 0 || netErrs > 0) {
      this._statusBar.text = `$(bell) Mergen`;
      this._statusBar.tooltip = `Mergen — ${warns} warning(s), ${netErrs} net error(s). Click to open panel.`;
      this._statusBar.backgroundColor = undefined;
    } else {
      this._statusBar.text = '$(check) Mergen';
      this._statusBar.tooltip = 'Mergen — buffer clean. Click to open panel.';
      this._statusBar.backgroundColor = undefined;
    }
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

  /* ── Context Pack card (B2) ── */
  .pack-time {
    font-size: 9px;
    font-weight: 500;
    color: var(--vscode-descriptionForeground);
    margin-left: 6px;
    text-transform: none;
    letter-spacing: 0;
  }
  .pack-trigger {
    font-size: 11px;
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background);
    border-left: 2px solid var(--vscode-charts-red);
    padding: 4px 8px;
    border-radius: 0 3px 3px 0;
    margin-bottom: 8px;
    font-family: var(--vscode-editor-font-family);
    word-break: break-word;
  }
  .hyp { margin-bottom: 8px; }
  .hyp-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 4px;
  }
  .hyp-tag {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: .04em;
    color: var(--vscode-charts-blue);
  }
  .hyp-conf {
    font-size: 10px;
    font-weight: 600;
    padding: 1px 6px;
    border-radius: 3px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
  }
  .hyp-conf.high   { background: var(--vscode-charts-green); color: #fff; }
  .hyp-conf.medium { background: var(--vscode-charts-yellow); color: #000; }
  .hyp-conf.low    { background: var(--vscode-charts-orange); color: #fff; }
  .hyp-summary {
    font-size: 11px;
    line-height: 1.5;
    color: var(--vscode-foreground);
  }
  .hyp-fix {
    margin-top: 6px;
    font-size: 11px;
    line-height: 1.5;
    color: var(--vscode-foreground);
    background: rgba(127,127,127,.08);
    border-radius: 3px;
    padding: 5px 8px;
    font-family: var(--vscode-editor-font-family);
  }
  .pack-meta {
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    margin-top: 4px;
  }

  /* ── History card (C1) ── */
  .history-item {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 0;
    border-bottom: 1px solid var(--vscode-widget-border, rgba(127,127,127,.1));
    font-size: 11px;
  }
  .history-item:last-child { border-bottom: none; }
  .history-reason {
    flex-shrink: 0;
    font-size: 9px;
    font-weight: 600;
    padding: 1px 4px;
    border-radius: 3px;
    background: rgba(120, 160, 220, 0.15);
    color: var(--vscode-textLink-foreground);
    text-transform: lowercase;
  }
  .history-tag {
    flex-shrink: 0;
    font-size: 9px;
    font-weight: 700;
    padding: 1px 5px;
    border-radius: 3px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    text-transform: uppercase;
  }
  .history-msg {
    flex: 1;
    min-width: 0;
    color: var(--vscode-foreground);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .history-time {
    flex-shrink: 0;
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
  }
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
  <div><b>Mergen server isn't running.</b></div>
  <div style="margin-top:8px; opacity:0.85">
    Start it with one click — Mergen will look for the server in your
    workspace, in <code>~/.mergen</code>, or wherever you've set
    <code>mergen.serverPath</code>.
  </div>
  <div style="margin-top:12px; display:flex; gap:6px; flex-wrap:wrap; justify-content:center">
    <button class="signal-run" onclick="runCmd('mergen.startServer')">▶ Start local server</button>
    <button class="signal-run" onclick="runCmd('mergen.installExtension')">📥 Install guide</button>
    <button class="signal-run" onclick="runCmd('mergen.sendFeedback')">💬 Send feedback</button>
  </div>
  <div style="margin-top:10px; font-size:11px; opacity:0.65">
    Or in a terminal: <code>cd server &amp;&amp; npm start</code>
  </div>
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

<!-- Live Context Pack (B2) -->
<div class="card" id="card-pack" style="display:none">
  <div class="card-title">Context Pack <span id="pack-time" class="pack-time"></span></div>
  <div class="pack-trigger" id="pack-trigger"></div>
  <div class="hyp" id="pack-hyp" style="display:none">
    <div class="hyp-head">
      <span class="hyp-tag" id="hyp-tag">—</span>
      <span class="hyp-conf" id="hyp-conf">—</span>
    </div>
    <div class="hyp-summary" id="hyp-summary"></div>
    <div class="hyp-fix" id="hyp-fix" style="display:none"></div>
  </div>
  <div class="pack-meta">
    <span id="pack-counts">—</span>
  </div>
  <div class="btn-row" style="margin-top:8px">
    <button class="primary" id="pack-send">→ Send to AI Chat</button>
    <button id="pack-copy">⧉ Copy Pack</button>
  </div>
</div>

<!-- Hypothesis history (C1) -->
<div class="card" id="card-history" style="display:none">
  <div class="card-title">Recent Diagnoses</div>
  <div id="history-list"></div>
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
  <div class="row" title="Automatic causal-chain rebuilds — Mergen's continuous-watch metric">
    <span class="row-label">Analyses today</span>
    <span class="row-value" id="server-analyses">—</span>
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

  // Generic VS Code command runner — used by the disconnected card and the
  // walkthrough buttons. Whitelisted on the host side.
  function runCmd(commandId) {
    vscode.postMessage({ type: 'runCommand', command: commandId });
  }

  // Cached Context Pack text for the Send/Copy buttons.
  let _currentPackText = '';
  document.getElementById('pack-send').addEventListener('click', () => {
    if (!_currentPackText) return;
    vscode.postMessage({
      type: 'sendToChat',
      text: 'Diagnose this runtime issue using the attached Context Pack:\n\n' + _currentPackText,
    });
  });
  document.getElementById('pack-copy').addEventListener('click', () => {
    if (!_currentPackText) return;
    vscode.postMessage({ type: 'copyPack', text: _currentPackText });
  });

  function fmtRel(ms) {
    const diff = Date.now() - ms;
    if (diff < 60_000)    return Math.max(1, Math.floor(diff / 1000)) + 's ago';
    if (diff < 3_600_000) return Math.floor(diff / 60_000) + 'm ago';
    if (diff < 86_400_000)return Math.floor(diff / 3_600_000) + 'h ago';
    return Math.floor(diff / 86_400_000) + 'd ago';
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
        auth_token_not_stored: '🔑',
        auth_500: '🔥',
        storage_cleared: '🗑️',
      };
      signalsList.innerHTML = signals.map(s => {
        const icon      = ICON[s.kind] ?? '🔍';
        const confPct   = Math.round((s.confidence ?? 0) * 100);
        const barClass  = confPct >= 80 ? '' : confPct >= 55 ? ' med' : ' low';
        const toolKey   = s.suggestedTool ?? 'quick_check';
        // Use s.action (specific, contextual) as the button text.
        // Truncate to 58 chars so it fits on one line in the panel.
        const actionText = s.action
          ? (s.action.length > 58 ? s.action.slice(0, 57) + '…' : s.action)
          : ('▶ Run ' + toolKey);
        return '<div class="signal-item">' +
          '<span class="signal-icon">' + icon + '</span>' +
          '<div class="signal-body">' +
            '<div class="signal-msg">' + escHtml(s.message) + '</div>' +
            '<div class="signal-meta">' +
              '<div class="conf-bar-wrap"><div class="conf-bar-fill' + barClass + '" style="width:' + confPct + '%"></div></div>' +
              '<span class="conf-pct">' + confPct + '%</span>' +
            '</div>' +
            '<button class="signal-run" onclick="copyTool(' + JSON.stringify(toolKey) + ')">▶ ' + escHtml(actionText) + '</button>' +
          '</div>' +
        '</div>';
      }).join('');
    } else {
      signalsCard.style.display = 'none';
    }

    // Context Pack card (B2)
    const pack = state.lastPack;
    const packCard = document.getElementById('card-pack');
    if (pack && pack.hasPack) {
      packCard.style.display = 'block';
      _currentPackText = pack.contextPack || '';
      document.getElementById('pack-time').textContent  = pack.builtAt ? fmtRel(pack.builtAt) : '';
      document.getElementById('pack-trigger').textContent = (pack.reason ? '[' + pack.reason + '] ' : '') + (pack.triggerMessage || '(unknown)');
      document.getElementById('pack-counts').textContent  =
        (pack.hypothesesCount || 0) + ' hypothesis' + ((pack.hypothesesCount || 0) === 1 ? '' : 'es') +
        ' · ' + (pack.errorsCount || 0) + ' error' + ((pack.errorsCount || 0) === 1 ? '' : 's');
      const hyp = pack.topHypothesis;
      const hypBox = document.getElementById('pack-hyp');
      if (hyp) {
        hypBox.style.display = 'block';
        document.getElementById('hyp-tag').textContent     = hyp.tag || '—';
        document.getElementById('hyp-summary').textContent = hyp.summary || '';
        const conf = (hyp.confidence || '').toLowerCase();
        const confEl = document.getElementById('hyp-conf');
        confEl.textContent = (hyp.confidence || '—') + ' ' + Math.round((hyp.confidenceScore || 0) * 100) + '%';
        confEl.className   = 'hyp-conf ' + conf;
        const fixEl = document.getElementById('hyp-fix');
        if (hyp.fixHint) {
          fixEl.style.display = 'block';
          fixEl.textContent   = '💡 ' + hyp.fixHint;
        } else {
          fixEl.style.display = 'none';
        }
      } else {
        hypBox.style.display = 'none';
      }
    } else {
      packCard.style.display = 'none';
      _currentPackText = '';
    }

    // History card (C1)
    const entries = state.history || [];
    const histCard = document.getElementById('card-history');
    const histList = document.getElementById('history-list');
    if (entries.length > 0) {
      histCard.style.display = 'block';
      histList.innerHTML = entries.slice(0, 10).map(e => {
        const tag = e.topHypothesis?.tag || 'baseline';
        const reason = e.reason ? '<span class="history-reason">' + escHtml(e.reason) + '</span>' : '';
        return '<div class="history-item">' +
          reason +
          '<span class="history-tag">' + escHtml(tag) + '</span>' +
          '<span class="history-msg" title="' + escHtml(e.triggerMessage) + '">' + escHtml(e.triggerMessage) + '</span>' +
          '<span class="history-time">' + fmtRel(e.builtAt) + '</span>' +
        '</div>';
      }).join('');
    } else {
      histCard.style.display = 'none';
    }

    // Server info
    document.getElementById('server-port').textContent     = state.port;
    document.getElementById('server-version').textContent  = h.version;
    document.getElementById('server-buffered').textContent = h.buffered + ' events';
    const analysesToday = u.analysesToday ?? 0;
    const avg = u.analysesAvgPerDay7d ?? 0;
    document.getElementById('server-analyses').textContent =
      analysesToday + (avg ? '  (7d avg: ' + avg + ')' : '');

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

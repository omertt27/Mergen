import * as vscode from 'vscode';
import * as http from 'http';

/** Node http.get wrapper that replaces fetch() for VS Code extension host compatibility.
 *  VS Code's Electron Node does not expose the global fetch / AbortSignal.timeout. */
function httpGet(url: string, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (chunk: string) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

/** POST helper using Node http module — fetch() not available in VS Code extension host. */
function httpPost(url: string, body: unknown, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const parsed = new URL(url);
    const options: http.RequestOptions = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: timeoutMs,
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk: string) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { statusCode: res.statusCode, body: data }));
        } else {
          try { resolve(JSON.parse(data)); } catch { resolve(data); }
        }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

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

/** Per-detector accuracy snapshot returned alongside each hypothesis.
 *  Mirrors `TagStats` in `server/src/calibration.ts`. We keep this loose
 *  (all fields optional) so older servers without calibration still render. */
interface CalibrationStats {
  tag: string;
  predictions: number;
  verdicts: number;
  accuracy: number;
  trusted: boolean;
  shouldInterrupt: boolean;
  accuracy7d: number | null;
  trendDelta: number | null;
  commonFailureModes?: Array<{ note: string; count: number }>;
}

interface Hypothesis {
  tag: string;
  summary: string;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'INSUFFICIENT';
  confidenceScore: number;
  evidence: string[];
  causalPath: string[];
  fixHint: string | null;
  /** Stable id for /feedback. Required for the verdict buttons to work. */
  pid?: string;
  /** Empirical accuracy of this detector — drives the inline badge. */
  calibration?: CalibrationStats | null;
}

interface LastPack {
  hasPack: boolean;
  builtAt?: number;
  builtAtIso?: string;
  triggerMessage?: string;
  /** New: why the pack was built — pageload, hmr, error, periodic, … */
  reason?: string;
  topHypothesis?: Hypothesis | null;
  hypotheses?: Hypothesis[];
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

interface CalibrationOverview {
  ok: boolean;
  overallAccuracy: number | null;
  trustedDetectors: number;
  totalDetectors: number;
  perDetector: CalibrationStats[];
}

interface ServerState {
  connected: boolean;
  port: number;
  health: HealthResponse | null;
  usage: UsageSnapshot | null;
  lastPack: LastPack | null;
  history: HistoryEntry[];
  calibration: CalibrationOverview | null;
  error: string | null;
}

export class MergenPanel implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private _state: ServerState = {
    connected: false, port: 3000, health: null, usage: null,
    lastPack: null, history: [], calibration: null, error: null,
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
    webviewView.webview.onDidReceiveMessage(async (msg: { type: string; tool?: string; text?: string; command?: string; pid?: string; verdict?: string }) => {
      if (msg.type === 'clear') await this.clearBuffer();
      if (msg.type === 'refresh') await this.refresh();            if (msg.type === 'ready') {
                // Immediately send current state so the webview hides the loading
                // spinner without waiting for the async poll to complete.
                console.log('[Mergen] ready received, sending state:', JSON.stringify(this._state).slice(0, 200));
                this._send({ type: 'state', state: this._state });
                void this._poll();
            }
      if (msg.type === 'feedback' && msg.pid && msg.verdict) {
        // For 'wrong' / 'partial' verdicts, give the user a single-line
        // input to explain *why* it was wrong. Skipping (Esc) is fine — the
        // verdict is still recorded; the note just isn't. Notes are folded
        // into the detector's `commonFailureModes` so the next time the
        // same detector fires we can show "often incorrect when:" hints.
        let note: string | undefined;
        if (msg.verdict === 'wrong' || msg.verdict === 'partial') {
          note = await vscode.window.showInputBox({
            prompt: msg.verdict === 'wrong'
              ? 'Why was this diagnosis wrong? (one line — optional)'
              : 'What did the diagnosis miss? (one line — optional)',
            placeHolder: 'e.g. API returned 200 but body was empty',
            ignoreFocusOut: false,
          });
        }
        await this.sendFeedback(msg.pid, msg.verdict, note);
      }
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
      await httpPost(`http://127.0.0.1:${port}/clear`, null, 3000);
      await this._poll();
    } catch {
      // server not running — panel will show disconnected state
    }
  }

  async refresh(): Promise<void> {
    await this._poll();
  }

  /**
   * POST a verdict to /feedback. This is the *active* half of the calibration
   * loop: every click here re-trains the trust score for the detector that
   * issued the prediction. We re-poll immediately so the badge updates in
   * place ("0/0" → "1/1 correct") — instant feedback that the click
   * actually changed something is what makes the loop feel real.
   *
   * `note` is an optional one-line explanation captured for `wrong` /
   * `partial` verdicts only. It feeds the panel's "Often incorrect when:"
   * hint, turning silent failures into a visible track record.
   */
  async sendFeedback(pid: string, verdict: string, note?: string): Promise<void> {
    const port = this._getPort();
    try {
      await httpPost(
        `http://127.0.0.1:${port}/feedback`,
        note ? { pid, verdict, note } : { pid, verdict },
        3000,
      );
      // Light, non-modal confirmation. We avoid a popup per click — the
      // badge update is the real confirmation.
      this._statusBar.text = '$(check) Mergen — thanks';
      setTimeout(() => this._poll(), 250);
    } catch (err) {
      const e = err as { statusCode?: number; body?: string } & Error;
      if (e.statusCode) {
        vscode.window.showWarningMessage(`Mergen: feedback rejected (${e.statusCode}) ${e.body ?? ''}`);
      } else {
        vscode.window.showWarningMessage(`Mergen: could not send feedback — ${e.message ?? String(err)}`);
      }
    }
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
    calibration: CalibrationOverview | null;
  } | null> {
    try {
      const base = `http://127.0.0.1:${port}`;
      const [health, usage, lastPack, history, calibration] = await Promise.all([
        httpGet(`${base}/health`,    timeoutMs) as Promise<HealthResponse>,
        httpGet(`${base}/usage`,     timeoutMs) as Promise<UsageSnapshot>,
        httpGet(`${base}/last-pack`, timeoutMs).catch(() => ({ hasPack: false } as LastPack)) as Promise<LastPack>,
        (httpGet(`${base}/history`,  timeoutMs) as Promise<{ entries: HistoryEntry[] }>)
          .then(d => d.entries ?? []).catch(() => [] as HistoryEntry[]),
        (httpGet(`${base}/calibration`, timeoutMs) as Promise<CalibrationOverview>)
          .catch(() => null),
      ]);
      return { health, usage, lastPack, history, calibration };
    } catch {
      return null;
    }
  }

  private async _poll(): Promise<void> {
    const port = this._getPort();
    const result = await this._fetchAll(port, 1500);
    if (result) {
      this._state = {
        connected: true, port,
        health: result.health, usage: result.usage,
        lastPack: result.lastPack, history: result.history,
        calibration: result.calibration,
        error: null,
      };
    } else {
      const found = await this._discoverPort(port);
      if (!found) {
        this._state = {
          connected: false, port,
          health: null, usage: null,
          lastPack: null, history: [],
          calibration: null,
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
          calibration: result.calibration,
          error: null,
        };
        await vscode.workspace.getConfiguration('mergen').update('serverPort', p, vscode.ConfigurationTarget.Workspace);
        return true;
      }
    }
    return false;
  }

  private _send(msg: unknown): void {
    const hasView = !!this._view;
    console.log('[Mergen] _send called, hasView:', hasView, JSON.stringify(msg).slice(0, 150));
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

    // Calibration gate: a "trusted" detector with sub-60% accuracy should
    // NOT be allowed to grab user attention. We still surface it in the
    // panel — but the status bar stays calm. This is the difference between
    // "we have an opinion" and "we will interrupt your flow with it".
    const top = state.lastPack?.topHypothesis ?? null;
    const cal = top?.calibration ?? null;
    const hypothesisCanInterrupt = !cal || !cal.trusted || cal.shouldInterrupt;

    // Choose the most prominent indicator to surface in the status bar.
    // The goal: developer glances at the bar and knows immediately whether
    // something needs attention — even mid-flow, before anything crashes.
    if (errors > 0) {
      this._statusBar.text = `$(error) Mergen ${errors} err`;
      this._statusBar.tooltip = `Mergen — ${errors} error(s) in buffer. Click to open panel.`;
      this._statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else if (signals.length > 0 && hypothesisCanInterrupt) {
      // Highest-confidence signal drives the message
      const topSig = signals[0];
      const confPct = Math.round(topSig.confidence * 100);
      this._statusBar.text = `$(warning) Mergen ${signals.length} signal${signals.length > 1 ? 's' : ''}`;
      this._statusBar.tooltip = `Mergen — ${topSig.message} (${confPct}% confidence). Click to open panel.`;
      this._statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else if (warns > 0 || netErrs > 0) {
      this._statusBar.text = `$(bell) Mergen`;
      this._statusBar.tooltip = `Mergen — ${warns} warning(s), ${netErrs} net error(s). Click to open panel.`;
      this._statusBar.backgroundColor = undefined;
    } else if (signals.length > 0) {
      // We have signals but the top hypothesis hasn't earned interrupt-rights
      // yet. Show a quiet indicator so the panel still feels "live".
      this._statusBar.text = `$(eye) Mergen`;
      this._statusBar.tooltip = `Mergen — ${signals.length} low-confidence signal(s). Click to review.`;
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

  /* ── Loading placeholder ── */
  .loading {
    text-align: center;
    padding: 32px 12px;
    color: var(--vscode-descriptionForeground);
    font-size: 12px;
    opacity: 0.7;
  }
  .loading-spinner {
    font-size: 22px;
    display: block;
    margin-bottom: 10px;
    animation: spin 1.2s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

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
    /* Demoted: model belief is now secondary to empirical accuracy. The
       big number on the row is the calibration badge below; this just
       tells you which signal *we* thought was strongest. */
    font-size: 9px;
    font-weight: 500;
    padding: 1px 5px;
    border-radius: 3px;
    background: transparent;
    color: var(--vscode-descriptionForeground);
    border: 1px solid var(--vscode-widget-border, rgba(127,127,127,.25));
    text-transform: lowercase;
    letter-spacing: .02em;
  }
  .hyp-conf.high   { color: var(--vscode-charts-green); border-color: var(--vscode-charts-green); }
  .hyp-conf.medium { color: var(--vscode-charts-yellow); border-color: var(--vscode-charts-yellow); }
  .hyp-conf.low    { color: var(--vscode-charts-orange); border-color: var(--vscode-charts-orange); }
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

  /* ── Calibration / accountability row ──
     Shows the empirical accuracy of the detector that produced this
     hypothesis, plus three feedback buttons. The badge colour mirrors the
     trust state: green when the detector has earned interrupt-rights,
     amber when it's trusted-but-mediocre, grey when n is too small.
     Accuracy is the *primary* number — confidence is intentionally
     downgraded to a secondary 9px tag, because what matters is what's
     actually been right, not what we *believe* might be right. */
  .calib {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 6px;
    font-size: 10px;
    flex-wrap: wrap;
  }
  .calib-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 7px;
    border-radius: 3px;
    font-weight: 700;
    font-size: 11px;       /* larger than confidence — promoted */
    background: rgba(127,127,127,.18);
    color: var(--vscode-descriptionForeground);
  }
  .calib-badge.good   { background: var(--vscode-charts-green); color: #fff; }
  .calib-badge.mid    { background: var(--vscode-charts-yellow); color: #000; }
  .calib-badge.poor   { background: var(--vscode-charts-red); color: #fff; }
  .calib-trend {
    color: var(--vscode-descriptionForeground);
    font-weight: 500;
  }
  .calib-trend.up   { color: var(--vscode-charts-green); }
  .calib-trend.down { color: var(--vscode-charts-red); }
  .calib-spacer { flex: 1; min-width: 6px; }
  /* "Often incorrect when:" hint — shown for any detector below the trust
     threshold whose users have explained their wrong verdicts. This is
     the system's own admission of its blind spots. */
  .calib-failmodes {
    width: 100%;
    margin-top: 4px;
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    background: rgba(255, 200, 0, 0.06);
    border-left: 2px solid var(--vscode-charts-yellow);
    border-radius: 0 3px 3px 0;
    padding: 4px 8px;
    line-height: 1.45;
  }
  .calib-failmodes b { color: var(--vscode-foreground); font-weight: 600; }
  .calib-failmodes ul { margin: 2px 0 0 14px; padding: 0; }
  .calib-failmodes li { margin: 1px 0; }

  /* ── Detector health row (global calibration table) ── */
  .det-row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 0;
    border-bottom: 1px solid var(--vscode-widget-border, rgba(127,127,127,.1));
    font-size: 11px;
  }
  .det-row:last-child { border-bottom: none; }
  .det-tag {
    flex: 1;
    min-width: 0;
    color: var(--vscode-foreground);
    font-family: var(--vscode-editor-font-family);
    font-size: 11px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .det-n {
    flex-shrink: 0;
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    min-width: 36px;
    text-align: right;
  }
  .feedback-btns {
    display: inline-flex;
    gap: 4px;
  }
  .fb-btn {
    padding: 1px 6px;
    border: 1px solid var(--vscode-widget-border, rgba(127,127,127,.3));
    border-radius: 3px;
    background: transparent;
    color: var(--vscode-descriptionForeground);
    cursor: pointer;
    font-size: 10px;
    font-family: inherit;
    line-height: 1.3;
  }
  .fb-btn:hover { background: rgba(127,127,127,.15); }
  .fb-btn.fb-correct:hover { border-color: var(--vscode-charts-green); color: var(--vscode-charts-green); }
  .fb-btn.fb-wrong:hover   { border-color: var(--vscode-charts-red);   color: var(--vscode-charts-red); }
  .fb-btn.fb-partial:hover { border-color: var(--vscode-charts-yellow); color: var(--vscode-charts-yellow); }
  .fb-prompt {
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
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

<!-- Loading state (shown until first render) -->
<div class="loading" id="loading">
  <span class="loading-spinner">⟳</span>
  Connecting to Mergen server…
</div>

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
    <div class="calib" id="hyp-calib" style="display:none"></div>
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

<!-- Detector health (the global calibration view) -->
<div class="card" id="card-detectors" style="display:none">
  <div class="card-title">
    Detector Health
    <span class="pack-time" id="detector-summary"></span>
  </div>
  <div id="detector-list"></div>
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
  // We route through the extension host (postMessage) rather than calling
  // navigator.clipboard directly — the webview sandbox blocks clipboard
  // access without the clipboardWrite permission, so direct calls fail silently.
  function copyTool(toolName) {
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
    if (diff < 60000)    return Math.max(1, Math.floor(diff / 1000)) + 's ago';
    if (diff < 3600000)  return Math.floor(diff / 60000) + 'm ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
    return Math.floor(diff / 86400000) + 'd ago';
  }

  // Render the calibration strip + feedback buttons for a hypothesis.
  // Two halves: a left-side "track record" badge (so users can verify our
  // claim before they trust it) and a right-side three-button verdict row
  // (so they can teach the engine in one click). Both are essential —
  // showing the badge without a way to challenge it is just marketing.
  function renderCalibrationHtml(hyp) {
    const cal = hyp && hyp.calibration;
    const pid = hyp && hyp.pid;
    let badgeHtml = '';
    if (cal) {
      if (!cal.trusted) {
        badgeHtml =
          '<span class="calib-badge" title="Need ≥5 verdicts before this score is trusted.">' +
          'New detector · ' + cal.verdicts + '/' + cal.predictions + ' rated' +
          '</span>';
      } else {
        const pct = Math.round(cal.accuracy * 100);
        const cls = pct >= 75 ? 'good' : pct >= 50 ? 'mid' : 'poor';
        const correct = Math.round(cal.accuracy * cal.verdicts);
        badgeHtml =
          '<span class="calib-badge ' + cls + '" title="Empirical accuracy across ' + cal.verdicts + ' user verdicts.">' +
          pct + '% · ' + correct + '/' + cal.verdicts + ' correct' +
          '</span>';
        if (typeof cal.trendDelta === 'number') {
          const delta = Math.round(cal.trendDelta * 100);
          if (delta !== 0) {
            const arrow = delta > 0 ? '▲' : '▼';
            const trendCls = delta > 0 ? 'up' : 'down';
            badgeHtml +=
              '<span class="calib-trend ' + trendCls + '" title="7-day trend vs older verdicts.">' +
              arrow + ' ' + Math.abs(delta) + '% (7d)' +
              '</span>';
          }
        }
      }
    } else {
      badgeHtml = '<span class="calib-badge" title="No verdicts recorded yet.">Unrated</span>';
    }
    let buttonsHtml = '';
    if (pid) {
      // We use single-quoted attributes so JSON.stringify(pid) (which emits
      // double quotes) doesn't terminate the attribute. Verdict literals
      // are intentionally inlined as JS strings — no user input here.
      buttonsHtml =
        '<span class="fb-prompt">Was this right?</span>' +
        '<span class="feedback-btns">' +
          "<button class='fb-btn fb-correct' title='Yes — diagnosis was correct' onclick='sendFeedback(" + JSON.stringify(pid) + ",\"correct\")'>✓ Yes</button>" +
          "<button class='fb-btn fb-partial' title='Partially right' onclick='sendFeedback(" + JSON.stringify(pid) + ",\"partial\")'>◐ Sort of</button>" +
          "<button class='fb-btn fb-wrong'   title='No — wrong diagnosis' onclick='sendFeedback(" + JSON.stringify(pid) + ",\"wrong\")'>✕ No</button>" +
        '</span>';
    }
    // Failure-mode hint: surfaces the top user-supplied "why was this wrong"
    // notes for this detector. Only meaningful when accuracy is poor enough
    // that we should warn — and only when we actually have notes to show.
    let failHtml = '';
    if (cal && cal.commonFailureModes && cal.commonFailureModes.length > 0 && cal.accuracy < 0.75) {
      const items = cal.commonFailureModes
        .slice(0, 3)
        .map(m => '<li>' + escHtml(m.note) + (m.count > 1 ? ' <span style="opacity:.6">(×' + m.count + ')</span>' : '') + '</li>')
        .join('');
      failHtml =
        '<div class="calib-failmodes">' +
          '<b>Often incorrect when:</b>' +
          '<ul>' + items + '</ul>' +
        '</div>';
    }
    return badgeHtml + '<span class="calib-spacer"></span>' + buttonsHtml + failHtml;
  }

  function sendFeedback(pid, verdict) {
    vscode.postMessage({ type: 'feedback', pid: pid, verdict: verdict });
  }

  // Register the message listener BEFORE sending 'ready', so we never
  // miss the host's immediate state reply.
  window.addEventListener('message', ({ data }) => {
    console.log('[Mergen webview] message received', JSON.stringify(data).slice(0, 200));
    if (data.type === 'state') render(data.state);
  });

  console.log('[Mergen webview] listener registered, sending ready');
  // Signal ready to start polling — host will reply with current state immediately.
  send('ready');
  console.log('[Mergen webview] ready sent');

  function render(state) {
    // Hide the loading spinner on the very first render
    const loadingEl = document.getElementById('loading');
    if (loadingEl) loadingEl.style.display = 'none';

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
        // Visually demoted — prefixed "belief:" so users mentally distinguish
        // it from the headline accuracy badge below. Belief is what the
        // model thinks; accuracy is what's actually been true.
        confEl.textContent = 'belief: ' + (hyp.confidence || '—').toLowerCase();
        confEl.className   = 'hyp-conf ' + conf;
        const fixEl = document.getElementById('hyp-fix');
        if (hyp.fixHint) {
          fixEl.style.display = 'block';
          fixEl.textContent   = '💡 ' + hyp.fixHint;
        } else {
          fixEl.style.display = 'none';
        }
        // Calibration strip — accuracy badge + verdict buttons. Always
        // shown for any hypothesis (even unrated ones), so users learn
        // from day one that they can challenge what we say.
        const calEl = document.getElementById('hyp-calib');
        calEl.innerHTML     = renderCalibrationHtml(hyp);
        calEl.style.display = 'flex';
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
        const cal = e.topHypothesis?.calibration;
        // Tiny accuracy chip on each row — same source of truth as the
        // big badge on the active hypothesis card. Surfaces "this detector
        // has a 78% track record" everywhere it's relevant.
        let chip = '';
        if (cal && cal.trusted) {
          const pct = Math.round(cal.accuracy * 100);
          const cls = pct >= 75 ? 'good' : pct >= 50 ? 'mid' : 'poor';
          chip = '<span class="calib-badge ' + cls + '" style="font-size:9px; padding:0 4px" title="Detector accuracy across ' + cal.verdicts + ' verdicts">' + pct + '%</span>';
        }
        return '<div class="history-item">' +
          reason +
          '<span class="history-tag">' + escHtml(tag) + '</span>' +
          chip +
          '<span class="history-msg" title="' + escHtml(e.triggerMessage) + '">' + escHtml(e.triggerMessage) + '</span>' +
          '<span class="history-time">' + fmtRel(e.builtAt) + '</span>' +
        '</div>';
      }).join('');
    } else {
      histCard.style.display = 'none';
    }

    // Detector Health (global calibration view) — sorted accuracy-desc.
    // This is the system's own scoreboard: every detector that has fired,
    // its track record, and its trust state. Infra engineers will look
    // here first to decide whether the engine is worth wiring in.
    const cal = state.calibration;
    const detCard = document.getElementById('card-detectors');
    const detList = document.getElementById('detector-list');
    if (cal && Array.isArray(cal.perDetector) && cal.perDetector.length > 0) {
      detCard.style.display = 'block';
      const overallTxt = cal.overallAccuracy !== null
        ? 'overall ' + Math.round(cal.overallAccuracy * 100) + '% · ' + cal.trustedDetectors + '/' + cal.totalDetectors + ' trusted'
        : cal.totalDetectors + ' detector' + (cal.totalDetectors === 1 ? '' : 's') + ' · awaiting verdicts';
      document.getElementById('detector-summary').textContent = overallTxt;
      const sorted = [...cal.perDetector].sort((a, b) => {
        // Trusted first, then accuracy desc, then sample-size desc.
        if (a.trusted !== b.trusted) return a.trusted ? -1 : 1;
        if (b.accuracy !== a.accuracy) return b.accuracy - a.accuracy;
        return b.verdicts - a.verdicts;
      });
      detList.innerHTML = sorted.map(s => {
        let badge;
        if (!s.trusted) {
          badge = '<span class="calib-badge" title="Need ≥5 verdicts before trusted.">new</span>';
        } else {
          const pct = Math.round(s.accuracy * 100);
          const cls = pct >= 75 ? 'good' : pct >= 50 ? 'mid' : 'poor';
          badge = '<span class="calib-badge ' + cls + '">' + pct + '%</span>';
        }
        let trend = '';
        if (typeof s.trendDelta === 'number' && s.trendDelta !== 0) {
          const delta = Math.round(s.trendDelta * 100);
          const arrow = delta > 0 ? '▲' : '▼';
          const trendCls = delta > 0 ? 'up' : 'down';
          trend = '<span class="calib-trend ' + trendCls + '">' + arrow + Math.abs(delta) + '%</span>';
        }
        return '<div class="det-row">' +
          badge + trend +
          '<span class="det-tag" title="' + escHtml(s.tag) + '">' + escHtml(s.tag) + '</span>' +
          '<span class="det-n">' + s.verdicts + '/' + s.predictions + '</span>' +
        '</div>';
      }).join('');
    } else {
      detCard.style.display = 'none';
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
    } catch (_) { return iso; }
  }
</script>
</body>
</html>`;
  }
}

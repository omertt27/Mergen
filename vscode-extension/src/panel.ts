
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

interface TimelineRow {
  ts: number;
  isoTs: string;
  kind: 'log' | 'warn' | 'error' | 'request' | 'context' | 'terminal' | 'process_exit' | 'ci_failure' | 'ci_success' | 'deployment';
  summary: string;
  source?: 'browser' | 'backend' | 'ci' | 'deploy';
  sha?: string;
}

interface RootCause {
  hypothesis: string;
  tag: string;
  confidence: number;
  fixHint: string | null;
  builtAt?: number;
}

interface ServerState {
  connected: boolean;
  port: number;
  health: HealthResponse | null;
  usage: UsageSnapshot | null;
  lastPack: LastPack | null;
  history: HistoryEntry[];
  calibration: CalibrationOverview | null;
  timeline: TimelineRow[];
  rootCause: RootCause | null;
  error: string | null;
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

export class MergenPanel implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private _state: ServerState = {
    connected: false, port: 3000, health: null, usage: null,
    lastPack: null, history: [], calibration: null, timeline: [], rootCause: null, error: null,
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
      enableCommandUris: true,
      localResourceRoots: [this._context.extensionUri],
    };

    webviewView.webview.html = this._getHtml(webviewView.webview);

    // Handle messages from the webview
    webviewView.webview.onDidReceiveMessage(async (msg: { type: string; tool?: string; text?: string; command?: string; pid?: string; verdict?: string }) => {
      if (msg.type === 'clear') await this.clearBuffer();
      if (msg.type === 'refresh') await this.refresh();
      if (msg.type === 'startCapture') await this.startCapture();
      if (msg.type === 'ready') {
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

    // Push the current state immediately so the webview never gets stuck on the
    // loading screen while waiting for the first HTTP poll to complete.
    // VS Code queues postMessage calls and delivers them once the webview is ready.
    this._send({ type: 'state', state: this._state });

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

  async startCapture(): Promise<void> {
    const port = this._getPort();
    try {
      const result = await httpPost(`http://127.0.0.1:${port}/mark`, null, 3000) as { timestamp: number; iso: string };
      this._view?.webview.postMessage({ type: 'captureStarted', timestamp: result.timestamp });
      vscode.window.showInformationMessage(
        'Mergen: Capture started — reproduce your bug, then ask your AI: "What happened since capture?"',
      );
    } catch {
      vscode.window.showWarningMessage('Mergen: Could not start capture — is the server running?');
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
    timeline: TimelineRow[];
    rootCause: RootCause | null;
  } | null> {
    try {
      const base = `http://127.0.0.1:${port}`;
      const [health, usage, lastPack, history, calibration, unifiedData] = await Promise.all([
        httpGet(`${base}/health`,    timeoutMs) as Promise<HealthResponse>,
        httpGet(`${base}/usage`,     timeoutMs) as Promise<UsageSnapshot>,
        httpGet(`${base}/last-pack`, timeoutMs).catch(() => ({ hasPack: false } as LastPack)) as Promise<LastPack>,
        (httpGet(`${base}/history`,  timeoutMs) as Promise<{ entries: HistoryEntry[] }>)
          .then(d => d.entries ?? []).catch(() => [] as HistoryEntry[]),
        (httpGet(`${base}/calibration`, timeoutMs) as Promise<CalibrationOverview>)
          .catch(() => null),
        (httpGet(`${base}/timeline/unified?seconds=300&limit=12`, timeoutMs) as Promise<{ rows: TimelineRow[]; rootCause: RootCause | null }>)
          .catch(() => ({ rows: [] as TimelineRow[], rootCause: null })),
      ]);
      return { health, usage, lastPack, history, calibration, timeline: unifiedData.rows ?? [], rootCause: unifiedData.rootCause ?? null };
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
        calibration: result.calibration, timeline: result.timeline, rootCause: result.rootCause,
        error: null,
      };
    } else {
      const found = await this._discoverPort(port);
      if (!found) {
        this._state = {
          connected: false, port,
          health: null, usage: null,
          lastPack: null, history: [],
          calibration: null, timeline: [], rootCause: null,
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
          calibration: result.calibration, timeline: result.timeline, rootCause: result.rootCause,
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

  private _getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._context.extensionUri, 'media', 'panel.js'),
    );
    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src ${webview.cspSource}; connect-src http://127.0.0.1:*;">
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
    grid-template-columns: repeat(auto-fit, minmax(60px, 1fr));
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
  a.signal-run { text-decoration: none; }

  /* ── Activity Feed ── */
  .activity-row {
    display: flex;
    align-items: baseline;
    gap: 6px;
    padding: 4px 0;
    border-bottom: 1px solid var(--vscode-widget-border, rgba(127,127,127,.1));
    font-size: 11px;
    line-height: 1.4;
  }
  .activity-row:last-child { border-bottom: none; }
  .activity-kind {
    flex-shrink: 0;
    font-size: 9px;
    font-weight: 700;
    letter-spacing: .04em;
    text-transform: uppercase;
    width: 42px;
  }
  .activity-kind.error   { color: var(--vscode-charts-red); }
  .activity-kind.warn    { color: var(--vscode-charts-yellow); }
  .activity-kind.request { color: var(--vscode-charts-blue); }
  .activity-kind.context { color: var(--vscode-descriptionForeground); }
  .activity-kind.log          { color: var(--vscode-descriptionForeground); }
  .activity-kind.ci_failure   { color: var(--vscode-charts-red); }
  .activity-kind.ci_success   { color: var(--vscode-charts-green); }
  .activity-kind.deployment   { color: var(--vscode-charts-blue); }
  .activity-kind.process_exit { color: var(--vscode-charts-red); }
  .activity-source {
    flex-shrink: 0;
    font-size: 8px;
    font-weight: 600;
    letter-spacing: .05em;
    text-transform: uppercase;
    padding: 1px 4px;
    border-radius: 3px;
    background: rgba(127,127,127,.12);
    color: var(--vscode-descriptionForeground);
  }
  .activity-source.ci     { background: rgba(0,120,200,.12); color: var(--vscode-charts-blue); }
  .activity-source.deploy { background: rgba(0,200,100,.12); color: var(--vscode-charts-green); }
  .activity-source.backend{ background: rgba(200,100,0,.12); color: var(--vscode-charts-orange, #e07000); }
  .activity-summary {
    flex: 1;
    min-width: 0;
    color: var(--vscode-foreground);
    word-break: break-word;
    overflow-wrap: anywhere;
  }
  .activity-time {
    flex-shrink: 0;
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    padding-left: 4px;
  }

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

<!-- JS diagnostic — shows if the script block ever executes -->
<div id="js-diag" style="font-size:10px;text-align:center;padding:4px;opacity:0.5">JS: not running</div>

<!-- Loading state (hidden by default — disconnected card is the safe default) -->
<div class="loading" id="loading" style="display:none">
  <span class="loading-spinner">⟳</span>
  Loading Mergen v2…
</div>

<!-- Disconnected state — shown by default so the panel never gets stuck -->
<div class="disconnected" id="disconnected">
  <div class="icon">⚡</div>
  <div><b>Mergen server isn't running.</b></div>
  <div style="margin-top:8px; opacity:0.85">
    Start it with one click — Mergen will look for the server in your
    workspace, in <code>~/.mergen</code>, or wherever you've set
    <code>mergen.serverPath</code>.
  </div>
  <div style="margin-top:12px; display:flex; gap:6px; flex-wrap:wrap; justify-content:center">
    <a class="signal-run" href="command:mergen.startServer" title="Start the Mergen local server">▶ Start local server</a>
    <a class="signal-run" href="command:mergen.installExtension" title="Open setup guide">📖 Setup guide</a>
  </div>
  <div style="margin-top:10px; font-size:11px; opacity:0.65">
    Or in a terminal: <code>mergen-server start</code>
  </div>
</div>

<!-- Live Context Pack — promoted to first: root cause is the primary question -->
<div class="card" id="card-pack" style="display:none">
  <div class="card-title">Context Pack <span id="pack-time" class="pack-time"></span></div>
  <div style="font-size:10px;color:var(--vscode-descriptionForeground);margin-bottom:6px">Live snapshot of errors, root cause, and traces — send directly to AI Chat.</div>
  <div class="pack-trigger" id="pack-trigger"></div>
  <div class="hyp" id="pack-hyp" style="display:none">
    <div class="hyp-head">
      <span class="hyp-tag" id="hyp-tag">—</span>
      <span class="hyp-conf" id="hyp-conf">—</span>
    </div>
    
    <!-- Causal Chain Breadcrumbs -->
    <div id="causal-chain" style="display:flex; flex-direction:column; gap:6px; margin:12px 0; font-family:var(--vscode-editor-font-family); font-size:10px;">
      <!-- JS will populate breadcrumbs here e.g. [Deploy] -> [Spike] -> [Crash] -->
    </div>
    
    <div class="hyp-summary" id="hyp-summary"></div>
    <div class="hyp-fix" id="hyp-fix" style="display:none"></div>
    
    <!-- Blast Radius UI -->
    <div id="blast-radius-box" style="margin-top:10px; padding:8px 10px; border:1px solid var(--vscode-charts-yellow); border-radius:4px; background:rgba(255,200,0,0.05); display:none">
      <div style="font-size:10px; font-weight:700; color:var(--vscode-charts-yellow); margin-bottom:4px; letter-spacing:0.05em">BLAST RADIUS</div>
      <div id="blast-radius-risk" style="font-size:11px; color:var(--vscode-foreground); line-height:1.4">Risk: 12% (No DB migrations involved, low traffic window)</div>
    </div>

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

<!-- Unified Timeline -->
<div class="card" id="card-activity" style="display:none">
  <div class="card-title">Unified Timeline</div>
  <div id="root-cause-box" style="display:none;margin-bottom:8px;padding:8px 10px;border-radius:4px;background:rgba(255,100,100,.08);border-left:3px solid var(--vscode-charts-red)">
    <div style="font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--vscode-charts-red);margin-bottom:3px">
      Root Cause · <span id="rc-confidence"></span>
    </div>
    <div id="rc-hypothesis" style="font-size:11px;color:var(--vscode-foreground);line-height:1.4"></div>
    <div id="rc-fix" style="display:none;font-size:10px;color:var(--vscode-descriptionForeground);margin-top:4px"></div>
  </div>
  <div id="activity-list"></div>
</div>

<!-- Proactive signals -->
<div class="card" id="card-signals" style="display:none">
  <div class="card-title">Detected Patterns</div>
  <div id="signals-list"></div>
</div>

<!-- Confidence Milestone Dashboard -->
<div class="card" id="card-milestone" style="display:none">
  <div class="card-title">Autopilot Milestone</div>
  <div style="font-size:11px;color:var(--vscode-foreground);margin-bottom:8px">
    Mergen is learning to resolve <b id="milestone-tag">api-service</b> issues automatically.
  </div>
  <div class="credit-bar-wrap" style="height:8px; background:rgba(127,127,127,0.2);">
    <div class="credit-bar-fill" id="milestone-bar" style="width:82%; background:var(--vscode-charts-green)"></div>
  </div>
  <div class="credit-meta" style="margin-top:4px; justify-content:space-between;">
    <span id="milestone-progress" style="font-weight:600">82% Confidence reached</span>
    <a href="#" id="milestone-action" style="color:var(--vscode-textLink-foreground);text-decoration:none;">Promote to Autopilot?</a>
  </div>
</div>

<!-- Buffer stats — moved after signals; raw counts are secondary to explanations -->
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
    <button id="btn-capture" onclick="send('startCapture')" title="Mark a start point — reproduce your bug — then ask your AI what happened since capture">⏺ Capture</button>
    <button onclick="send('clear')">✕ Clear</button>
  </div>
  <div id="capture-status" style="display:none;margin-top:6px;font-size:10px;color:var(--vscode-charts-green)"></div>
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

<script src="${scriptUri}"></script>
</body>
</html>`;
  }
}

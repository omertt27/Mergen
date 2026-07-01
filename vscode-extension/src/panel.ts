
import * as vscode from 'vscode';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type {
  ActivityEvent, SessionSignal, HealthResponse, UsageSnapshot,
  CalibrationStats, Hypothesis, LastPack, HistoryEntry,
  CalibrationOverview, TimelineRow, RootCause, FilePRContext,
  AccountState, ServiceInfo, ServiceInteractions, PendingBypass,
  UnifiedDashboardResponse,
} from '@mergen/types';

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
function httpPost(url: string, body: unknown, timeoutMs: number, customHeaders?: Record<string, string>): Promise<unknown> {
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
        ...(customHeaders || {}),
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

/** PATCH helper using Node http module */
function httpPatch(url: string, body: unknown, timeoutMs: number, customHeaders?: Record<string, string>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const parsed = new URL(url);
    const options: http.RequestOptions = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...(customHeaders || {}),
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

// SessionSignal, HealthResponse, UsageSnapshot, CalibrationStats, Hypothesis,
// LastPack, HistoryEntry, CalibrationOverview, TimelineRow, RootCause,
// FilePRContext, AccountState, ServiceInfo, ServiceInteractions, PendingBypass
// are imported from '@mergen/types' above — single source of truth.

interface ServerState {
  connected:      boolean;
  port:           number;
  health:         HealthResponse | null;
  usage:          UsageSnapshot | null;
  lastPack:       LastPack | null;
  history:        HistoryEntry[];
  calibration:    CalibrationOverview | null;
  timeline:       TimelineRow[];
  rootCause:      RootCause | null;
  account:        AccountState | null;
  fileIntent:     { file: string; contexts: FilePRContext[] } | null;
  error:          string | null;
  services:       Record<string, ServiceInfo> | null;
  interactions:   ServiceInteractions | null;
  pendingBypasses: PendingBypass[] | null;
  activity:       ActivityEvent[] | null;
  policies:       UnifiedDashboardResponse['policies'] | null;
  gateCovers:     UnifiedDashboardResponse['gateCovers'] | null;
  securityMetrics: UnifiedDashboardResponse['securityMetrics'] | null;
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
    lastPack: null, history: [], calibration: null, timeline: [], rootCause: null,
    account: null, fileIntent: null, error: null,
    services: null, interactions: null,
    pendingBypasses: null,
    activity: null,
    policies: null,
    gateCovers: null,
    securityMetrics: null,
  };
  private _pollTimer?: ReturnType<typeof setTimeout>;
  private _activeFile: string | null = null;

  // Backoff: consecutive failure count — reset on success, increments on miss.
  private _failCount = 0;

  // Account data (plan, email, capabilities) is cached to skip the /license
  // round-trip on every 2s poll tick, but revalidated on a short TTL so a plan
  // upgrade mid-session is reflected without a reconnect.
  private _cachedAccount: AccountState | null = null;
  private _cachedAccountPort: number | null = null;
  private _cachedAccountAt = 0;
  private static readonly ACCOUNT_TTL_MS = 30_000;

  // SSE: persistent connection to /activity-feed/stream for push events
  // (HOLD/BLOCK verdicts surface instantly without waiting for the next poll).
  private _sseReq: http.ClientRequest | null = null;
  private _ssePort: number | null = null;

  constructor(private readonly _context: vscode.ExtensionContext) {}

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
    webviewView.webview.onDidReceiveMessage(async (msg: { type: string; tool?: string; text?: string; command?: string; pid?: string; verdict?: string; token?: string; remember?: boolean; id?: string; action?: string }) => {
      if (msg.type === 'clear') await this.clearBuffer();
      if (msg.type === 'refresh') await this.refresh();
      if (msg.type === 'startCapture') await this.startCapture();
      if (msg.type === 'approveBypass' && msg.token) {
        await this.approveBypass(msg.token, !!msg.remember);
      }
      if (msg.type === 'toggleRule' && msg.id && msg.action) {
        await this.toggleRule(msg.id, msg.action as 'block' | 'warn' | 'pass');
      }
      if (msg.type === 'connectAccount') {
        await vscode.commands.executeCommand('mergen.connectAccount');
      }
      if (msg.type === 'enterKey') {
        await vscode.commands.executeCommand('mergen.enterLicenseKey');
      }
      if (msg.type === 'signOut') {
        await vscode.commands.executeCommand('mergen.signOut');
      }
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
          'mergen.whyThisFile',
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

  /** Called by extension.ts whenever the active editor changes. Pushes the
   *  new file path to the webview so the intent card can refresh. */
  onActiveFileChanged(relPath: string): void {
    this._activeFile = relPath;
    // Push immediately (webview JS will fetch /explain-why/file itself)
    this._send({ type: 'activeFile', relPath });
  }

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
      // Exponential backoff when disconnected: 2s → 4s → 8s → 16s → 30s cap.
      // Reset to normal interval the moment the server responds.
      const delay = this._state.connected
        ? this._getInterval()
        : Math.min(2 ** Math.min(this._failCount, 5) * 1000, 30_000);
      this._pollTimer = setTimeout(tick, delay);
    };
    tick();
  }

  private _stopPolling(): void {
    if (this._pollTimer) { clearTimeout(this._pollTimer); this._pollTimer = undefined; }
    this._disconnectSSE();
  }

  private async _fetchAll(port: number, timeoutMs: number): Promise<{
    health:          HealthResponse;
    usage:           UsageSnapshot;
    lastPack:        LastPack;
    history:         HistoryEntry[];
    calibration:     CalibrationOverview | null;
    timeline:        TimelineRow[];
    rootCause:       RootCause | null;
    account:         AccountState | null;
    services:        Record<string, ServiceInfo> | null;
    interactions:    ServiceInteractions | null;
    pendingBypasses: PendingBypass[] | null;
    activity:        ActivityEvent[] | null;
    policies:        UnifiedDashboardResponse['policies'] | null;
    gateCovers:      UnifiedDashboardResponse['gateCovers'] | null;
    securityMetrics: UnifiedDashboardResponse['securityMetrics'] | null;
  } | null> {
    try {
      const base = `http://127.0.0.1:${port}`;

      // Re-fetch /license on port change, first fetch, or after the TTL — so a
      // mid-session plan upgrade is reflected without waiting for a reconnect.
      const accountStale = Date.now() - this._cachedAccountAt > MergenPanel.ACCOUNT_TTL_MS;
      const needsAccount = this._cachedAccountPort !== port || this._cachedAccount === null || accountStale;

      const [dashData, licenseData] = await Promise.all([
        httpGet(`${base}/unified-dashboard`, timeoutMs) as Promise<UnifiedDashboardResponse>,
        needsAccount
          ? (httpGet(`${base}/license`, timeoutMs) as Promise<{
              plan: {
                id: string; name: string;
                capabilities?: AccountState['capabilities']; ctaUrl?: string | null;
              };
              nextPlan: AccountState['nextPlan'];
              license: { status: string; email: string | null; name: string | null } | null;
            }>).catch(() => null)
          : Promise.resolve(null),
      ]);

      if (licenseData) {
        this._cachedAccount = {
          email:        licenseData.license?.email ?? null,
          name:         licenseData.license?.name  ?? null,
          planId:       licenseData.plan?.id   ?? 'free',
          planName:     licenseData.plan?.name ?? 'Free',
          status:       (licenseData.license?.status as AccountState['status']) ?? null,
          capabilities: licenseData.plan?.capabilities ?? null,
          ctaUrl:       licenseData.plan?.ctaUrl ?? null,
          nextPlan:     licenseData.nextPlan ?? null,
        };
        this._cachedAccountPort = port;
        this._cachedAccountAt   = Date.now();
      }

      return {
        health:          dashData.health,
        usage:           dashData.usage,
        lastPack:        dashData.lastPack,
        history:         dashData.history,
        calibration:     dashData.calibration,
        timeline:        dashData.timelineUnified.rows ?? [],
        rootCause:       dashData.timelineUnified.rootCause ?? null,
        account:         this._cachedAccount,
        services:        dashData.services,
        interactions:    dashData.interactions,
        pendingBypasses: dashData.pendingBypasses ?? [],
        activity:        dashData.activity ?? null,
        policies:        dashData.policies ?? null,
        gateCovers:      dashData.gateCovers ?? null,
        securityMetrics: dashData.securityMetrics ?? null,
      };
    } catch {
      return null;
    }
  }

  private async _poll(): Promise<void> {
    const port = this._getPort();
    const result = await this._fetchAll(port, 1500);
    if (result) {
      this._failCount = 0;
      this._connectSSE(port);
      this._state = {
        connected: true, port,
        health: result.health, usage: result.usage,
        lastPack: result.lastPack, history: result.history,
        calibration: result.calibration, timeline: result.timeline, rootCause: result.rootCause,
        account: result.account,
        fileIntent: this._state.fileIntent,
        error: null,
        services: result.services,
        interactions: result.interactions,
        pendingBypasses: result.pendingBypasses,
        activity: result.activity ?? [],
        policies: result.policies ?? null,
        gateCovers: result.gateCovers ?? null,
        securityMetrics: result.securityMetrics ?? null,
      };
    } else {
      const found = await this._discoverPort(port);
      if (!found) {
        this._failCount++;
        this._state = {
          connected: false, port,
          health: null, usage: null,
          lastPack: null, history: [],
          calibration: null, timeline: [], rootCause: null,
          account: null,
          fileIntent: this._state.fileIntent,
          error: 'Server not running on port ' + port,
          services: null,
          interactions: null,
          pendingBypasses: null,
          activity: [],
          policies: null,
          gateCovers: null,
          securityMetrics: null,
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
          account: result.account,
          fileIntent: this._state.fileIntent,
          error: null,
          services: result.services,
          interactions: result.interactions,
          pendingBypasses: result.pendingBypasses,
          activity: result.activity ?? [],
          policies: result.policies ?? null,
          gateCovers: result.gateCovers ?? null,
          securityMetrics: result.securityMetrics ?? null,
        };
        await vscode.workspace.getConfiguration('mergen').update('serverPort', p, vscode.ConfigurationTarget.Workspace);
        return true;
      }
    }
    return false;
  }

  // ── SSE connection ───────────────────────────────────────────────────────────

  /** Open a persistent SSE connection to /activity-feed/stream.
   *  HOLD and BLOCK events trigger an immediate poll so the HITL card and
   *  blunder log appear in the sidebar without waiting for the next tick. */
  private _connectSSE(port: number): void {
    if (this._ssePort === port && this._sseReq) return; // already connected
    this._disconnectSSE();
    this._ssePort = port;

    const req = http.get(
      {
        hostname: '127.0.0.1',
        port,
        path: '/activity-feed/stream',
        headers: { Accept: 'text/event-stream' },
      },
      (res) => {
        if (res.statusCode !== 200) { req.destroy(); return; }
        let buf = '';
        res.on('data', (chunk: Buffer) => {
          buf += chunk.toString('utf8');
          const parts = buf.split('\n\n');
          buf = parts.pop() ?? '';
          for (const part of parts) {
            for (const line of part.split('\n')) {
              if (!line.startsWith('data: ')) continue;
              try {
                const ev = JSON.parse(line.slice(6)) as ActivityEvent;
                if (ev.verdict === 'HOLD' || ev.verdict === 'BLOCK') {
                  // Immediately surface the HITL card / blunder entry.
                  void this._poll();
                }
              } catch { /* ignore malformed events */ }
            }
          }
        });
        res.on('end', () => {
          // Server closed the stream — retry after a short delay.
          if (this._ssePort === port) {
            this._sseReq = null;
            setTimeout(() => this._connectSSE(port), 5_000);
          }
        });
      },
    );
    req.on('error', () => {
      // Connection refused or reset — polling will handle reconnect.
      if (this._ssePort === port) this._sseReq = null;
    });
    req.setTimeout(0); // disable timeout — keep-alive stream
    this._sseReq = req;
  }

  private _disconnectSSE(): void {
    if (this._sseReq) { this._sseReq.destroy(); this._sseReq = null; }
    this._ssePort = null;
  }

  private _getSharedSecret(): string | null {
    try {
      const secretPath = path.join(os.homedir(), '.mergen', 'secret');
      if (fs.existsSync(secretPath)) {
        return fs.readFileSync(secretPath, 'utf8').trim() || null;
      }
    } catch {}
    return null;
  }

  private async approveBypass(token: string, remember = false): Promise<void> {
    const port = this._getPort();
    const secret = this._getSharedSecret();
    const base = `http://127.0.0.1:${port}`;
    try {
      const res = await httpPost(
        `${base}/hitl/approve`,
        { token, remember },
        2000,
        secret ? { 'x-mergen-secret': secret } : undefined
      ) as { ok: boolean; error?: string; toolName?: string; commandArg?: string };
      
      if (res && res.ok) {
        if (remember) {
          vscode.window.showInformationMessage(`Bypass approved and remembered as policy!`);
        } else {
          vscode.window.showInformationMessage(`Bypass approved! ${res.commandArg ? `Execution of "${res.commandArg}"` : `Tool call to ${res.toolName}`} is allowed.`);
        }
        await this._poll();
      } else {
        vscode.window.showErrorMessage(`Failed to approve bypass: ${res?.error || 'unknown error'}`);
      }
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to approve bypass: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async toggleRule(id: string, action: 'block' | 'warn' | 'pass'): Promise<void> {
    const port = this._getPort();
    const secret = this._getSharedSecret();
    const base = `http://127.0.0.1:${port}`;
    try {
      const res = await httpPatch(
        `${base}/policies/rules/${id}`,
        { action },
        3000,
        secret ? { 'x-mergen-secret': secret } : undefined
      ) as { ok: boolean; error?: string };
      
      if (res && res.ok) {
        vscode.window.showInformationMessage(`Rule '${id}' action updated to ${action.toUpperCase()}!`);
        await this._poll();
      } else {
        vscode.window.showErrorMessage(`Failed to update rule: ${res?.error || 'unknown error'}`);
      }
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to update rule: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private _send(msg: unknown): void {
    this._view?.webview.postMessage(msg);
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
  @keyframes pulse {
    0% { opacity: 0.5; transform: scale(0.9); }
    70% { opacity: 1; transform: scale(1.1); }
    100% { opacity: 0.5; transform: scale(0.9); }
  }

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

  .adv-section {
    margin-bottom: 12px;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--vscode-widget-border, rgba(127,127,127,.15));
  }
  .adv-section:last-child {
    margin-bottom: 0;
    padding-bottom: 0;
    border-bottom: none;
  }

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

  /* ── Intent card ── */
  .intent-item {
    padding: 6px 0;
    border-bottom: 1px solid var(--vscode-widget-border, rgba(127,127,127,.1));
    font-size: 11px;
    line-height: 1.45;
  }
  .intent-item:last-child { border-bottom: none; }
  .intent-pr {
    color: var(--vscode-foreground);
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .intent-meta {
    color: var(--vscode-descriptionForeground);
    font-size: 10px;
    margin-top: 2px;
  }
  .intent-issues {
    color: var(--vscode-textLink-foreground);
    font-size: 10px;
    margin-top: 2px;
  }
  .intent-ai-tag {
    display: inline-block;
    font-size: 9px;
    font-weight: 700;
    padding: 0 4px;
    border-radius: 3px;
    background: rgba(0,120,200,.15);
    color: var(--vscode-charts-blue);
    margin-left: 4px;
    letter-spacing: .03em;
  }
</style>
</head>
<body>

<!-- Header -->
<div class="header" style="flex-direction: column; align-items: stretch; gap: 8px;">
  <div style="display: flex; align-items: center; justify-content: space-between; width: 100%;">
    <span class="header-title"><span class="dot" id="dot"></span>Mergen Gateway</span>
    <span class="badge" id="plan-badge">—</span>
  </div>
  <div class="gateway-status-bar" style="display: flex; justify-content: space-between; font-size: 10px; color: var(--vscode-descriptionForeground); border-top: 1px solid var(--vscode-widget-border, rgba(127,127,127,.15)); padding-top: 6px; margin-top: 4px; width: 100%;">
    <span>Status: <span id="gateway-status" style="color: var(--vscode-charts-green); font-weight: 600;">Protected ✓</span></span>
    <span>Latency: <span id="gateway-latency">0.84ms</span></span>
    <span>Policies: <span id="gateway-policies-active">0 active</span></span>
  </div>
</div>

<!-- Low-credit notice -->
<div class="notice" id="notice"></div>

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
  <div style="margin-top:14px; border-top:1px solid var(--vscode-widget-border,rgba(127,127,127,.2)); padding-top:12px">
    <div style="font-size:11px; opacity:0.75; margin-bottom:8px">Have a Mergen account?</div>
    <div style="display:flex; gap:6px; flex-wrap:wrap; justify-content:center">
      <button class="primary" onclick="send('connectAccount')" style="flex:none">→ Connect Account</button>
      <button onclick="send('enterKey')" style="flex:none">Enter license key…</button>
    </div>
  </div>
</div>

<!-- Account card -->
<div class="card" id="card-account" style="display:none">
  <div class="card-title" style="display:flex;align-items:center;justify-content:space-between">
    <span>Account</span>
    <span id="account-plan-badge" class="badge" style="display:none"></span>
  </div>
  <div id="account-signed-in" style="display:none">
    <div class="row">
      <span class="row-label">Signed in as</span>
      <span class="row-value" id="account-email" style="font-size:11px;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></span>
    </div>
    <div class="btn-row" style="margin-top:8px">
      <button onclick="send('signOut')">Sign out</button>
      <a class="signal-run" href="https://mergen.dev/dashboard" title="Open dashboard" style="text-align:center">↗ Dashboard</a>
    </div>
  </div>
  <div id="account-signed-out">
    <div style="font-size:11px;color:var(--vscode-descriptionForeground);margin-bottom:8px">
      Connect your Mergen account to unlock your plan and sync credits.
    </div>
    <div class="btn-row">
      <button class="primary" onclick="send('connectAccount')">→ Connect Account</button>
      <button onclick="send('enterKey')">Enter key…</button>
    </div>
  </div>
  <!-- Contextual upgrade CTA — shown when a higher plan is available -->
  <div id="account-upgrade" style="display:none; margin-top:10px; border-top:1px solid var(--vscode-widget-border,rgba(127,127,127,.2)); padding-top:10px">
    <div style="font-size:11px; font-weight:600; margin-bottom:2px" id="account-upgrade-title"></div>
    <div style="font-size:11px; opacity:0.75; margin-bottom:8px" id="account-upgrade-tagline"></div>
    <a class="signal-run primary" id="account-upgrade-link" href="#" title="Upgrade your Mergen plan" style="text-align:center; display:block">↑ Upgrade</a>
  </div>
</div>

<!-- Security Metrics -->
<div class="card" id="card-security-metrics" style="display:none">
  <div class="card-title">Security Metrics</div>
  <div class="stats-grid" style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 6px;">
    <div class="stat-box" style="background: var(--vscode-sideBar-background); border: 1px solid var(--vscode-widget-border, rgba(127,127,127,.15)); border-radius: 4px; padding: 8px; text-align: center; border-left: 3px solid var(--vscode-charts-blue);">
      <div style="font-size: 15px; font-weight: 700; color: var(--vscode-charts-blue);" id="metric-protected-actions">—</div>
      <div style="font-size: 9px; color: var(--vscode-descriptionForeground); text-transform: uppercase; margin-top: 2px;">Protected Actions</div>
    </div>
    <div class="stat-box" style="background: var(--vscode-sideBar-background); border: 1px solid var(--vscode-widget-border, rgba(127,127,127,.15)); border-radius: 4px; padding: 8px; text-align: center; border-left: 3px solid var(--vscode-charts-red);">
      <div style="font-size: 15px; font-weight: 700; color: var(--vscode-charts-red);" id="metric-blocked-actions">—</div>
      <div style="font-size: 9px; color: var(--vscode-descriptionForeground); text-transform: uppercase; margin-top: 2px;">Blocked Actions</div>
    </div>
    <div class="stat-box" style="background: var(--vscode-sideBar-background); border: 1px solid var(--vscode-widget-border, rgba(127,127,127,.15)); border-radius: 4px; padding: 8px; text-align: center; border-left: 3px solid var(--vscode-charts-yellow);">
      <div style="font-size: 15px; font-weight: 700; color: var(--vscode-charts-yellow);" id="metric-approvals-requested">—</div>
      <div style="font-size: 9px; color: var(--vscode-descriptionForeground); text-transform: uppercase; margin-top: 2px;">Approvals Req</div>
    </div>
    <div class="stat-box" style="background: var(--vscode-sideBar-background); border: 1px solid var(--vscode-widget-border, rgba(127,127,127,.15)); border-radius: 4px; padding: 8px; text-align: center; border-left: 3px solid var(--vscode-charts-orange, #d18616);">
      <div style="font-size: 15px; font-weight: 700; color: var(--vscode-charts-orange, #d18616);" id="metric-shadow-violations">—</div>
      <div style="font-size: 9px; color: var(--vscode-descriptionForeground); text-transform: uppercase; margin-top: 2px;">Shadow Violations</div>
    </div>
  </div>
</div>

<!-- Policies & Coverage -->
<div class="card" id="card-policies-coverage" style="display:none">
  <div class="card-title" style="display:flex;justify-content:space-between;align-items:center">
    <span>Active Policies</span>
    <span id="policy-coverage-badge" style="font-size:10px;font-weight:700;background:var(--vscode-charts-green);color:#fff;border-radius:3px;padding:1px 5px">— Coverage</span>
  </div>
  <div style="font-size:10px;color:var(--vscode-descriptionForeground);margin-bottom:8px">Safety policies enforced on all autonomous agents.</div>
  
  <div id="policies-list" style="display:flex;flex-direction:column;gap:5px;margin-bottom:10px">
    <!-- Active policies list -->
  </div>

  <div style="border-top:1px solid var(--vscode-widget-border, rgba(127,127,127,.15));padding-top:8px;margin-top:8px">
    <div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:4px">
      <span style="color:var(--vscode-descriptionForeground)">Critical Actions Protected</span>
      <span style="font-weight:600" id="critical-actions-count">—</span>
    </div>
    <div class="credit-bar-wrap" style="height:6px; background:rgba(127,127,127,0.2);">
      <div class="credit-bar-fill" id="coverage-bar" style="width:0%; background:var(--vscode-charts-green)"></div>
    </div>
  </div>
</div>

<!-- Execution Timeline -->
<div class="card" id="card-execution-timeline" style="display:none">
  <div class="card-title">Execution Timeline</div>
  <div style="font-size:10px;color:var(--vscode-descriptionForeground);margin-bottom:8px">Real-time log of agent decisions and safety checks.</div>
  <div id="execution-timeline-list" style="display:flex;flex-direction:column;gap:6px"></div>
</div>

<!-- Pending Bypasses -->
<div class="card" id="card-bypasses" style="display:none">
  <div class="card-title" style="display:flex;align-items:center;justify-content:space-between">
    <span>Pending Bypasses</span>
    <span style="font-size:10px;font-weight:700;background:var(--vscode-charts-red);color:#fff;border-radius:3px;padding:1px 5px" id="bypasses-count">0</span>
  </div>
  <div style="font-size:10px;color:var(--vscode-descriptionForeground);margin-bottom:8px">AI agent tool executions requiring manual approval.</div>
  <div id="bypasses-list" style="display:flex;flex-direction:column;gap:6px"></div>
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
    
    <!-- Causal Chain Breadcrumbs — populated by JS from hyp.causalPath -->
    <div id="causal-chain" style="display:none"></div>
    
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

<!-- Service Map (Execution Visualizer) -->
<div class="card" id="card-services" style="display:none">
  <div class="card-title" style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
    <span>Execution Visualizer</span>
    <span id="service-filter-badge" style="display:none; font-size:10px; font-weight:700; background:var(--vscode-charts-blue); color:#fff; border-radius:3px; padding:1px 5px; cursor:pointer" onclick="onClearServiceFilter()" title="Clear filter">
      Filter: <span id="service-filter-name"></span> ✕
    </span>
  </div>
  <div style="font-size:10px;color:var(--vscode-descriptionForeground);margin-bottom:8px">Active SDK connections and co-occurrence topology.</div>
  
  <div id="service-map-container" style="position:relative; width:100%; height:160px; background:var(--vscode-sideBar-background); border: 1px solid var(--vscode-widget-border, rgba(127,127,127,.1)); border-radius:4px; overflow:hidden">
    <svg id="service-map-svg" width="100%" height="100%" style="display:block; overflow:visible; cursor:grab"></svg>
    <div id="service-map-tooltip" style="position:absolute; display:none; background:var(--vscode-editor-background); color:var(--vscode-foreground); padding:4px 8px; border-radius:3px; font-size:10px; font-family:var(--vscode-editor-font-family); pointer-events:none; z-index:10; border:1px solid var(--vscode-widget-border, rgba(127,127,127,.25))"></div>
  </div>
  <div id="service-map-summary" style="font-size:9px; color:var(--vscode-descriptionForeground); margin-top:4px; text-align:right"></div>
</div>

<!-- Unified Timeline -->
<div class="card" id="card-activity" style="display:none">
  <div class="card-title">Diagnostics Timeline</div>
  <div id="root-cause-box" style="display:none;margin-bottom:8px;padding:8px 10px;border-radius:4px;background:rgba(255,100,100,.08);border-left:3px solid var(--vscode-charts-red)">
    <div style="font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--vscode-charts-red);margin-bottom:3px">
      Root Cause · <span id="rc-confidence"></span>
    </div>
    <div id="rc-hypothesis" style="font-size:11px;color:var(--vscode-foreground);line-height:1.4"></div>
    <div id="rc-fix" style="display:none;font-size:10px;color:var(--vscode-descriptionForeground);margin-top:4px"></div>
    <div id="rc-recurrence" style="display:none;margin-top:6px;padding:6px 8px;background:rgba(255,200,0,0.08);border-left:2px solid var(--vscode-charts-yellow);font-size:10px;border-radius:0 4px 4px 0"></div>
  </div>
  <div id="activity-list"></div>
</div>

<!-- Proactive signals -->
<div class="card" id="card-signals" style="display:none">
  <div class="card-title">Detected Patterns</div>
  <div id="signals-list"></div>
</div>

<!-- Intent card — PR context for the currently active file -->
<div class="card" id="card-intent" style="display:none">
  <div class="card-title" style="display:flex;align-items:center;justify-content:space-between">
    <span>Why This File? <span id="intent-file" style="font-weight:400;text-transform:none;letter-spacing:0;font-size:10px;color:var(--vscode-descriptionForeground)"></span></span>
    <button style="flex:0;padding:2px 8px;font-size:10px" onclick="runCmd('mergen.whyThisFile')">↗ AI Chat</button>
  </div>
  <div id="intent-list"></div>
</div>

<!-- Collapsible Advanced Section -->
<div class="card" id="card-advanced" style="display:none">
  <div class="card-title" style="display:flex;justify-content:space-between;align-items:center;cursor:pointer;user-select:none" onclick="toggleAdvanced()">
    <span>Advanced Diagnostics</span>
    <span id="advanced-toggle-icon">▶</span>
  </div>
  <div id="advanced-content" style="display:none;margin-top:10px;border-top:1px solid var(--vscode-widget-border, rgba(127,127,127,.15));padding-top:10px">
    
    <!-- Detector Health -->
    <div class="adv-section" id="card-detectors" style="display:none">
      <div style="font-size:11px;font-weight:600;margin-bottom:6px;display:flex;justify-content:space-between">
        <span>Detector Health</span>
        <span id="detector-summary" style="font-size:9px;color:var(--vscode-descriptionForeground)"></span>
      </div>
      <div id="detector-list"></div>
    </div>
    
    <!-- Buffer stats -->
    <div class="adv-section" id="card-buffer" style="display:none">
      <div style="font-size:11px;font-weight:600;margin-bottom:6px">Buffer Diagnostics</div>
      <div class="stats" style="margin-bottom:8px">
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
      <div class="btn-row">
        <button class="primary" id="btn-refresh" onclick="onRefresh()">
          <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" style="margin-right:4px;vertical-align:middle;"><path d="M13.6 4.6A7 7 0 1 0 15 8h-2a5 5 0 1 1-1-3l2.2-2.2v4.8h-4.8z"/></svg>Refresh
        </button>
        <button id="btn-capture" onclick="send('startCapture')" title="Mark a start point — reproduce your bug — then ask your AI what happened since capture">
          <span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--vscode-charts-red);margin-right:4px;vertical-align:middle;"></span>Capture
        </button>
        <button id="btn-clear" onclick="onClear()">
          <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" style="margin-right:4px;vertical-align:middle;"><line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/></svg>Clear
        </button>
      </div>
      <div id="capture-status" style="display:none;margin-top:6px;font-size:10px;color:var(--vscode-charts-green)"></div>
    </div>

    <!-- Server info -->
    <div class="adv-section" id="card-server" style="display:none">
      <div style="font-size:11px;font-weight:600;margin-bottom:6px">Server Details</div>
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
  </div>
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

<!-- Hypothesis history (C1) -->
<div class="card" id="card-history" style="display:none">
  <div class="card-title">Recent Diagnoses</div>
  <div id="history-list"></div>
</div>

<script src="${scriptUri}"></script>
</body>
</html>`;
  }
}

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as net from 'net';
import { spawn } from 'child_process';
import { MergenPanel } from './panel.js';

const FEEDBACK_URL = 'https://github.com/omertt27/Mergen/discussions/new?category=feedback';
const INSTALL_GUIDE_URL = 'https://github.com/omertt27/Mergen#install-in-60-seconds';

export function activate(context: vscode.ExtensionContext): void {
  // Register the sidebar webview provider
  const provider = new MergenPanel(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('mergen.panel', provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  // ── Commands ───────────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('mergen.openPanel', () => {
      void vscode.commands.executeCommand('mergen.panel.focus');
    }),
    vscode.commands.registerCommand('mergen.clearBuffer', () => provider.clearBuffer()),
    vscode.commands.registerCommand('mergen.refresh', () => provider.refresh()),
    vscode.commands.registerCommand('mergen.startServer', () => startServer(context, /*explicit*/ true)),
    vscode.commands.registerCommand('mergen.installExtension', () =>
      vscode.env.openExternal(vscode.Uri.parse(INSTALL_GUIDE_URL)),
    ),
    vscode.commands.registerCommand('mergen.sendFeedback', () =>
      vscode.env.openExternal(vscode.Uri.parse(FEEDBACK_URL)),
    ),
    vscode.commands.registerCommand('mergen.openCalibration', () => openCalibration()),
  );

  // ── First-run: open the walkthrough automatically ──────────────────────────
  // The first 20–50 installs are our most valuable feedback signal. Surfacing
  // the walkthrough on first activation (and never again) is the cheapest way
  // to make sure new users see the three concrete steps to get value.
  const FIRST_RUN_KEY = 'mergen.firstRunComplete';
  if (!context.globalState.get(FIRST_RUN_KEY)) {
    void context.globalState.update(FIRST_RUN_KEY, true);
    void vscode.commands.executeCommand(
      'workbench.action.openWalkthrough',
      'mergen.mergen#mergen.getStarted',
      false,
    );
  }

  // ── Auto-start the server if the user opts in (default: true) ──────────────
  const cfg = vscode.workspace.getConfiguration('mergen');
  if (cfg.get<boolean>('autoStartServer', true)) {
    void startServer(context, /*explicit*/ false);
  }
}

export function deactivate(): void {
  // nothing — webview lifecycle is managed by VS Code
}

// ── Detector Health quick-pick ───────────────────────────────────────────────
//
// Power users live in the Command Palette. `Mergen: Show Detector Accuracy`
// fetches /calibration and renders every detector as a row in a quick-pick:
//
//   $(check) auth_token_not_persisted    82% · 23/28 correct
//   $(warning) schema_drift                48% · 12/25 correct  ▼ 14% (7d)
//   $(circle-outline) dom_mismatch         new · 0/3 rated
//
// Selecting a row opens the README anchor for that detector tag (if it
// exists), otherwise the panel. This makes the "is Mergen telling me the
// truth?" question answerable in two keystrokes — Cmd-Shift-P, "merg cal".

interface PerDetector {
  tag: string;
  predictions: number;
  verdicts: number;
  accuracy: number;
  trusted: boolean;
  shouldInterrupt: boolean;
  accuracy7d: number | null;
  trendDelta: number | null;
}

async function openCalibration(): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('mergen');
  const port = cfg.get<number>('serverPort', 3000);
  let payload: { perDetector?: PerDetector[]; overallAccuracy?: number | null; trustedDetectors?: number; totalDetectors?: number } | null = null;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/calibration`, { signal: AbortSignal.timeout(2000) });
    if (r.ok) payload = await r.json();
  } catch { /* server down — handled below */ }

  if (!payload) {
    const action = await vscode.window.showWarningMessage(
      'Mergen: server not reachable on :' + port + '. Start it to view detector accuracy.',
      'Start Local Server',
    );
    if (action === 'Start Local Server') {
      await vscode.commands.executeCommand('mergen.startServer');
    }
    return;
  }

  const list = payload.perDetector ?? [];
  if (list.length === 0) {
    vscode.window.showInformationMessage(
      'Mergen: no detectors have fired yet. Use the app for a bit, then come back — the scoreboard fills itself.',
    );
    return;
  }

  // Trusted-first, accuracy-desc — same order as the panel's Detector Health card.
  const sorted = [...list].sort((a, b) => {
    if (a.trusted !== b.trusted) return a.trusted ? -1 : 1;
    if (b.accuracy !== a.accuracy) return b.accuracy - a.accuracy;
    return b.verdicts - a.verdicts;
  });

  const items: vscode.QuickPickItem[] = sorted.map((s) => {
    let icon: string, label: string;
    if (!s.trusted) {
      icon = '$(circle-outline)';
      label = `new · ${s.verdicts}/${s.predictions} rated`;
    } else {
      const pct = Math.round(s.accuracy * 100);
      icon = pct >= 75 ? '$(check)' : pct >= 50 ? '$(warning)' : '$(error)';
      label = `${pct}% · ${Math.round(s.accuracy * s.verdicts)}/${s.verdicts} correct`;
    }
    let trend = '';
    if (typeof s.trendDelta === 'number' && s.trendDelta !== 0) {
      const delta = Math.round(s.trendDelta * 100);
      trend = delta > 0 ? `  ▲ ${delta}% (7d)` : `  ▼ ${Math.abs(delta)}% (7d)`;
    }
    return {
      label: `${icon} ${s.tag}`,
      description: label + trend,
      detail: s.shouldInterrupt
        ? 'Trusted enough to interrupt your flow.'
        : s.trusted
          ? 'Trusted but quiet — won\'t grab attention.'
          : 'Not trusted yet — needs more verdicts.',
    };
  });

  const overall = payload.overallAccuracy != null
    ? `Overall: ${Math.round(payload.overallAccuracy * 100)}% across ${payload.trustedDetectors}/${payload.totalDetectors} trusted detectors`
    : `${payload.totalDetectors ?? list.length} detector(s) · awaiting verdicts`;

  const picked = await vscode.window.showQuickPick(items, {
    title: `Mergen — Detector Accuracy   (${overall})`,
    placeHolder: 'Pick a detector to open the panel for details',
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (picked) {
    await vscode.commands.executeCommand('mergen.openPanel');
  }
}

// ── Server boot helpers ──────────────────────────────────────────────────────
//
// Goal: zero-config first-run for a Marketplace install. The first 20–50
// installs *will* be Marketplace users without the repo cloned — they need
// the panel to light up by itself, or with one click.
//
// Resolution order for `dist/index.js`:
//   1. `mergen.serverPath` setting (file or directory)
//   2. `<workspace>/server/dist/index.js`     — repo clone
//   3. `<workspace>/../server/dist/index.js`  — sibling clone
//   4. `~/.mergen/server/dist/index.js`       — installed by setup script
//
// If we can't find one, we don't autostart — the panel's disconnected card
// already shows the install instructions.

function resolveServerEntry(): string | null {
  const cfg = vscode.workspace.getConfiguration('mergen');
  const explicit = (cfg.get<string>('serverPath') ?? '').trim();
  const candidates: string[] = [];

  if (explicit) {
    candidates.push(explicit, path.join(explicit, 'dist', 'index.js'), path.join(explicit, 'index.js'));
  }
  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (workspace) {
    candidates.push(
      path.join(workspace, 'server', 'dist', 'index.js'),
      path.join(workspace, '..', 'server', 'dist', 'index.js'),
    );
  }
  candidates.push(path.join(os.homedir(), '.mergen', 'server', 'dist', 'index.js'));

  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) return path.resolve(c); } catch { /* keep looking */ }
  }
  return null;
}

async function isServerRunning(port: number, timeoutMs = 600): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok;
  } catch { return false; }
}

async function isPortOpen(port: number, timeoutMs = 300): Promise<boolean> {
  return new Promise((resolve) => {
    const s = new net.Socket();
    s.setTimeout(timeoutMs);
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('timeout', () => { s.destroy(); resolve(false); });
    s.once('error',   () => { s.destroy(); resolve(false); });
    s.connect(port, '127.0.0.1');
  });
}

async function discoverRunningPort(start: number, end: number): Promise<number | null> {
  for (let p = start; p <= end; p++) {
    if (await isPortOpen(p)) {
      if (await isServerRunning(p)) return p;
    }
  }
  return null;
}

async function startServer(
  context: vscode.ExtensionContext,
  explicit: boolean,
): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('mergen');
  const port = cfg.get<number>('serverPort', 3000);

  // Already up? Done.
  if (await isServerRunning(port)) {
    if (explicit) vscode.window.showInformationMessage(`Mergen: server already running on :${port}.`);
    return;
  }
  const found = await discoverRunningPort(3000, 3010);
  if (found) {
    if (found !== port) {
      await cfg.update('serverPort', found, vscode.ConfigurationTarget.Workspace);
    }
    if (explicit) vscode.window.showInformationMessage(`Mergen: server already running on :${found}.`);
    return;
  }

  const entry = resolveServerEntry();
  if (!entry) {
    if (explicit) {
      const action = await vscode.window.showWarningMessage(
        'Mergen: could not find the local server. Install it first.',
        'Open install guide',
        'Set server path…',
      );
      if (action === 'Open install guide') {
        void vscode.env.openExternal(vscode.Uri.parse(INSTALL_GUIDE_URL));
      } else if (action === 'Set server path…') {
        void vscode.commands.executeCommand('workbench.action.openSettings', 'mergen.serverPath');
      }
    }
    return;
  }

  try {
    const child = spawn(process.execPath, [entry], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
    });
    child.unref();
    context.subscriptions.push({
      dispose: () => { /* leave the daemon running across reloads */ },
    });
    if (explicit) {
      vscode.window.showInformationMessage(
        `Mergen: server starting (${path.basename(path.dirname(path.dirname(entry)))})…`,
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Mergen: failed to start server — ${msg}`);
  }
}

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as net from 'net';
import * as http from 'http';
import { spawn } from 'child_process';
import { MergenPanel } from './panel.js';

const FEEDBACK_URL = 'https://github.com/omertt27/Mergen/discussions/new?category=feedback';
const INSTALL_GUIDE_URL = 'https://github.com/omertt27/Mergen#install-in-60-seconds';
const SECRET_FILE = path.join(os.homedir(), '.mergen', 'secret');

let cachedSecret: string | null = null;

function getSharedSecret(): string | null {
  if (cachedSecret) return cachedSecret;
  try {
    cachedSecret = fs.readFileSync(SECRET_FILE, 'utf8').trim() || null;
  } catch {
    cachedSecret = null;
  }
  return cachedSecret;
}

function postToIngest(port: number, payload: Record<string, unknown>): Promise<void> {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const secret = getSharedSecret();
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/ingest',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          ...(secret ? { 'x-mergen-secret': secret } : {}),
        },
      },
      (res) => { res.resume(); resolve(); },
    );
    req.on('error', () => resolve()); // best-effort, never throw
    req.write(body);
    req.end();
  });
}

// ── Inline gutter annotations ────────────────────────────────────────────────
// Shows a warning gutter icon on the suspect file + line identified by the
// causal engine via git blame. Updated every 30 seconds — frequently enough
// to track an active incident, infrequently enough to not hammer the server.

const mergenDiagnostics = vscode.languages.createDiagnosticCollection('mergen');
let _annotationTimer: ReturnType<typeof setInterval> | null = null;

async function refreshAnnotations(port: number): Promise<void> {
  try {
    const data = await new Promise<{ hasPack?: boolean; errors?: Array<{ primaryFrame?: { file?: string; line?: number; column?: number } | null; message?: string }> } | null>((resolve) => {
      const req = http.get(
        { hostname: '127.0.0.1', port, path: '/last-pack', timeout: 1000 },
        (res) => {
          let d = ''; res.on('data', (c: string) => { d += c; });
          res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
        },
      );
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.on('error',   () => resolve(null));
    });

    if (!data?.hasPack || !data?.errors?.length) { mergenDiagnostics.clear(); return; }

    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const newDiags  = new Map<string, vscode.Diagnostic[]>();

    for (const err of data.errors ?? []) {
      const frame = err.primaryFrame;
      if (!frame?.file || frame.line == null) continue;

      const absPath = path.isAbsolute(frame.file)
        ? frame.file
        : workspace ? path.join(workspace, frame.file) : frame.file;

      const line = Math.max(0, (frame.line ?? 1) - 1);
      const col  = Math.max(0, (frame.column ?? 0));
      const range = new vscode.Range(line, col, line, col + 80);

      const diag = new vscode.Diagnostic(
        range,
        `Mergen: ${err.message ?? 'flagged by causal engine'} — see panel for details`,
        vscode.DiagnosticSeverity.Warning,
      );
      diag.source = 'Mergen';

      const key = absPath;
      if (!newDiags.has(key)) newDiags.set(key, []);
      newDiags.get(key)!.push(diag);
    }

    mergenDiagnostics.clear();
    for (const [filePath, diags] of newDiags) {
      try {
        mergenDiagnostics.set(vscode.Uri.file(filePath), diags);
      } catch { /* file not found or not in workspace */ }
    }
  } catch { /* server down — clear annotations */ mergenDiagnostics.clear(); }
}

async function checkMcpConfiguration(): Promise<void> {
  const home = os.homedir();
  const mcpConfigPaths = [
    path.join(home, '.cursor', 'mcp.json'),
    path.join(home, '.codeium', 'windsurf', 'mcp_config.json'),
  ];
  const workspaceMcpPaths = vscode.workspace.workspaceFolders?.flatMap((f) => [
    path.join(f.uri.fsPath, '.vscode', 'mcp.json'),
    path.join(f.uri.fsPath, '.cursor', 'mcp.json'),
  ]) ?? [];

  const allPaths = [...mcpConfigPaths, ...workspaceMcpPaths];
  const anyExists = allPaths.some((p) => { try { return fs.existsSync(p); } catch { return false; } });

  if (anyExists) return;

  const MCP_DETECTED_KEY = 'mergen.mcpConfigOffered';
  const ctx = (global as { __mergenContext?: vscode.ExtensionContext }).__mergenContext;
  if (ctx?.globalState.get(MCP_DETECTED_KEY)) return;

  const action = await vscode.window.showInformationMessage(
    'Mergen is running! To let your AI agent call Mergen tools, register it as an MCP server.',
    'Configure for Cursor',
    'Configure for VS Code',
    'Later',
  );

  if (action === 'Configure for Cursor') {
    const cursorPath = path.join(home, '.cursor', 'mcp.json');
    try {
      const entry = resolveServerEntry();
      if (!entry) {
        vscode.window.showWarningMessage('Mergen: build the server first (cd server && npm run build).');
        return;
      }
      const dir = path.dirname(cursorPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      let existing: Record<string, unknown> = {};
      try { existing = JSON.parse(fs.readFileSync(cursorPath, 'utf8')) as Record<string, unknown>; } catch { /* new file */ }
      const existingMcpServers = typeof existing.mcpServers === 'object' && existing.mcpServers !== null
        ? existing.mcpServers as Record<string, unknown>
        : {};
      const merged = {
        ...existing,
        mcpServers: {
          ...existingMcpServers,
          mergen: { command: 'node', args: [entry] },
        },
      };
      fs.writeFileSync(cursorPath, JSON.stringify(merged, null, 2) + '\n', 'utf8');
      vscode.window.showInformationMessage(`Mergen: MCP config written to ${cursorPath}. Restart Cursor to apply.`);
    } catch (err) {
      vscode.window.showErrorMessage(`Mergen: could not write Cursor config — ${(err as Error).message}`);
    }
  } else if (action === 'Configure for VS Code') {
    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspace) {
      vscode.window.showWarningMessage('Mergen: open a workspace folder first.');
      return;
    }
    const vscodePath = path.join(workspace, '.vscode', 'mcp.json');
    try {
      const entry = resolveServerEntry();
      if (!entry) {
        vscode.window.showWarningMessage('Mergen: build the server first (cd server && npm run build).');
        return;
      }
      const dir = path.dirname(vscodePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      let existing: Record<string, unknown> = {};
      try { existing = JSON.parse(fs.readFileSync(vscodePath, 'utf8')) as Record<string, unknown>; } catch { /* new file */ }
      const existingServers = typeof existing.servers === 'object' && existing.servers !== null
        ? existing.servers as Record<string, unknown>
        : {};
      const merged = {
        ...existing,
        servers: {
          ...existingServers,
          mergen: { type: 'stdio', command: 'node', args: [entry] },
        },
      };
      fs.writeFileSync(vscodePath, JSON.stringify(merged, null, 2) + '\n', 'utf8');
      vscode.window.showInformationMessage(`Mergen: MCP config written to ${vscodePath}. Reload VS Code to apply.`);
    } catch (err) {
      vscode.window.showErrorMessage(`Mergen: could not write VS Code config — ${(err as Error).message}`);
    }
  }

  await ctx?.globalState.update(MCP_DETECTED_KEY, true);
}

export function activate(context: vscode.ExtensionContext): void {
  (global as { __mergenContext?: vscode.ExtensionContext }).__mergenContext = context;
  console.log('[Mergen] activate() called');
  context.subscriptions.push(mergenDiagnostics);

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
  setTimeout(() => {
    const port = vscode.workspace.getConfiguration('mergen').get<number>('serverPort', 3000);
    void isServerRunning(port).then((running) => {
      if (running) void checkMcpConfiguration();
    });
  }, 5000);

  // ── Inline gutter annotations — refresh every 30s ─────────────────────────
  const annotationPort = () => vscode.workspace.getConfiguration('mergen').get<number>('serverPort', 3000);
  _annotationTimer = setInterval(() => { void refreshAnnotations(annotationPort()); }, 30_000);
  context.subscriptions.push({ dispose: () => { if (_annotationTimer) clearInterval(_annotationTimer); } });
  // Initial annotation on activate (after a short delay so server has time to start)
  setTimeout(() => { void refreshAnnotations(annotationPort()); }, 3000);

  let diagDebounce: ReturnType<typeof setTimeout> | null = null;
  const pendingUris = new Set<string>();

  context.subscriptions.push(
    vscode.languages.onDidChangeDiagnostics((event) => {
      for (const uri of event.uris) pendingUris.add(uri.toString());
      if (diagDebounce) clearTimeout(diagDebounce);
      diagDebounce = setTimeout(() => {
        diagDebounce = null;
        const uris = [...pendingUris];
        pendingUris.clear();
        const cfg2 = vscode.workspace.getConfiguration('mergen');
        const port2 = cfg2.get<number>('serverPort', 3000);
        const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
        for (const uriStr of uris) {
          const uri2 = vscode.Uri.parse(uriStr);
          const diags = vscode.languages.getDiagnostics(uri2);
          const relPath = workspace ? path.relative(workspace, uri2.fsPath) : uri2.fsPath;
          for (const d of diags) {
            if (d.severity > vscode.DiagnosticSeverity.Warning) continue;
            const sevMap: Record<number, string> = {
              [vscode.DiagnosticSeverity.Error]: 'error',
              [vscode.DiagnosticSeverity.Warning]: 'warning',
              [vscode.DiagnosticSeverity.Information]: 'info',
              [vscode.DiagnosticSeverity.Hint]: 'hint',
            };
            const payload = {
              type: 'diagnostic',
              source: typeof d.source === 'string' ? d.source : 'unknown',
              file: relPath,
              severity: sevMap[d.severity] ?? 'warning',
              message: d.message,
              code: d.code != null ? (typeof d.code === 'object' ? String(d.code.value) : d.code) : undefined,
              line: d.range.start.line,
              column: d.range.start.character,
              timestamp: Date.now(),
            };
            void postToIngest(port2, payload);
          }
        }
      }, 500);
    }),
  );

  context.subscriptions.push(
    ((vscode.window as any).onDidWriteTerminalData?.((e: { terminal: vscode.Terminal; data: string }) => {
      const cfg2 = vscode.workspace.getConfiguration('mergen');
      const port2 = cfg2.get<number>('serverPort', 3000);
      void postToIngest(port2, {
        type: 'terminal',
        terminalName: e.terminal.name,
        data: e.data.slice(0, 2000),
        timestamp: Date.now(),
      });
    }) as vscode.Disposable | undefined) ?? { dispose: () => {} },
  );

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const fp = doc.uri.fsPath;
      if (/\.(test|spec)\.[jt]sx?$/.test(fp)) return;
      if (!/\.[jt]sx?$/.test(fp)) return;

      const dir = path.dirname(fp);
      const base = path.basename(fp).replace(/\.[^.]+$/, '');
      const candidates = ['.test.ts', '.spec.ts', '.test.tsx', '.spec.tsx', '.test.js', '.spec.js']
        .map((s) => path.join(dir, base + s));
      const now = new Date();
      for (const c of candidates) {
        try { if (fs.existsSync(c)) fs.utimesSync(c, now, now); } catch { /* non-fatal */ }
      }
    }),
    {
      dispose: () => {
        if (diagDebounce) {
          clearTimeout(diagDebounce);
          diagDebounce = null;
        }
      },
    },
  );
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
    payload = await new Promise((resolve, reject) => {
      const req = http.get(
        { hostname: '127.0.0.1', port, path: '/calibration', timeout: 2000 },
        (res) => {
          let d = ''; res.on('data', (c: string) => d += c);
          res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
        },
      );
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.on('error', reject);
    });
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
  return new Promise((resolve) => {
    const req = http.get(
      { hostname: '127.0.0.1', port, path: '/health', timeout: timeoutMs },
      (res) => { resolve(res.statusCode === 200); res.resume(); },
    );
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
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

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as net from 'net';
import * as http from 'http';
import { spawn } from 'child_process';
import { MergenPanel } from './panel.js';

const FEEDBACK_URL    = 'https://github.com/omertt27/Mergen/discussions/new?category=feedback';
const INSTALL_GUIDE_URL = 'https://github.com/omertt27/Mergen#install-in-60-seconds';
const CONNECT_URL     = 'https://mergen.dev/signup?source=vscode';
const SECRET_FILE     = path.join(os.homedir(), '.mergen', 'secret');

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

// ── Status bar — always-on error counter ─────────────────────────────────────
// Visible at the bottom of every VS Code window. Shows live error/warning counts
// from the Mergen buffer. The developer sees it turn red without opening any panel.
// Click → opens GitHub Copilot / AI chat with context pre-filled.

let _statusBar: vscode.StatusBarItem | null = null;
let _statusPollTimer: ReturnType<typeof setInterval> | null = null;
let _prevErrorCount = 0;
let _notifiedThisSession = false;
const _pendingSaveChecks = new Set<string>(); // debounce: one HMR check per file at a time

interface HealthPayload {
  ok?: boolean;
  errors?: number;
  warnings?: number;
  networkErrors?: number;
  buffered?: number;
  pendingBypassesCount?: number;
  blockedActionsCount?: number;
}

async function fetchHealth(port: number): Promise<HealthPayload | null> {
  return new Promise((resolve) => {
    const req = http.get(
      { hostname: '127.0.0.1', port, path: '/health', timeout: 1500 },
      (res) => {
        let d = '';
        res.on('data', (c: string) => { d += c; });
        res.on('end', () => { try { resolve(JSON.parse(d) as HealthPayload); } catch { resolve(null); } });
      },
    );
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

async function refreshStatusBar(): Promise<void> {
  if (!_statusBar) return;
  const cfg  = vscode.workspace.getConfiguration('mergen');
  const port = cfg.get<number>('serverPort', 3000);
  const health = await fetchHealth(port);

  if (!health?.ok) {
    _statusBar.text    = '$(shield) Gateway Offline';
    _statusBar.tooltip = 'Mergen gateway server not running — click to start';
    _statusBar.backgroundColor = undefined;
    _statusBar.command = 'mergen.startServer';
    _prevErrorCount    = 0;
    _notifiedThisSession = false;
    return;
  }

  const pending = health.pendingBypassesCount ?? 0;
  const blocked = health.blockedActionsCount ?? 0;

  if (pending > 0) {
    _statusBar.text    = `$(shield) Gateway: ${pending} Pending`;
    _statusBar.tooltip = `${pending} AI agent action${pending !== 1 ? 's' : ''} requiring approval · Click to open panel`;
    _statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    _statusBar.command = 'mergen.openPanel';
  } else if (blocked > 0) {
    _statusBar.text    = `$(shield) Gateway: ${blocked} Blocked`;
    _statusBar.tooltip = `${blocked} hazardous action${blocked !== 1 ? 's' : ''} blocked by safety policy · Click to open panel`;
    _statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    _statusBar.command = 'mergen.openPanel';
  } else {
    _statusBar.text    = `$(shield) Gateway: Active`;
    _statusBar.tooltip = 'Agent Execution Gateway is active and enforcing policies · Click to open panel';
    _statusBar.backgroundColor = undefined;
    _statusBar.command = 'mergen.openPanel';
  }

  const totalAlerts = pending + blocked;

  // Proactive notification: first time an interception (pending or blocked) occurs this session
  if (totalAlerts > 0 && _prevErrorCount === 0 && !_notifiedThisSession) {
    _notifiedThisSession = true;
    const msg = pending > 0
      ? `Mergen intercepted ${pending} AI agent action${pending !== 1 ? 's' : ''} requiring manual approval.`
      : `Mergen blocked a dangerous AI agent action matching your local safety policy.`;
    const action = await vscode.window.showWarningMessage(msg, 'Open Panel', 'Dismiss');
    if (action === 'Open Panel') {
      await vscode.commands.executeCommand('mergen.openPanel');
    }
  }
  
  // Reset notification gate when alerts are cleared
  if (totalAlerts === 0 && _prevErrorCount > 0) _notifiedThisSession = false;
  _prevErrorCount = totalAlerts;
}

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

async function checkMcpConfiguration(ctx: vscode.ExtensionContext): Promise<void> {
  const home = os.homedir();
  const mcpConfigPaths = [
    path.join(home, '.cursor',   'mcp.json'),
    path.join(home, '.codeium',  'windsurf', 'mcp_config.json'),
    path.join(home, '.claude',   'mcp.json'),
  ];
  const workspaceMcpPaths = vscode.workspace.workspaceFolders?.flatMap((f) => [
    path.join(f.uri.fsPath, '.vscode', 'mcp.json'),
    path.join(f.uri.fsPath, '.cursor', 'mcp.json'),
  ]) ?? [];

  const allPaths = [...mcpConfigPaths, ...workspaceMcpPaths];
  const anyExists = allPaths.some((p) => { try { return fs.existsSync(p); } catch { return false; } });
  if (anyExists) return;

  const MCP_DETECTED_KEY = 'mergen.mcpConfigOffered';
  if (ctx.globalState.get(MCP_DETECTED_KEY)) return;

  const action = await vscode.window.showInformationMessage(
    'Mergen is running! Register it as an MCP server so your AI agent can call Mergen tools directly.',
    'Cursor',
    'VS Code / Copilot',
    'Claude Code',
    'Later',
  );

  const entry = resolveServerEntry();
  if (!entry && action !== 'Later' && action !== undefined) {
    vscode.window.showWarningMessage('Mergen: build the server first (cd server && npm run build).');
    return;
  }

  if (action === 'Cursor') {
    const configPath = path.join(home, '.cursor', 'mcp.json');
    writeMcpConfig(configPath, 'mcpServers', { command: 'node', args: [entry!] });
    vscode.window.showInformationMessage(`Mergen: MCP registered in ${configPath}. Restart Cursor to apply.`);
  } else if (action === 'VS Code / Copilot') {
    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspace) { vscode.window.showWarningMessage('Mergen: open a workspace folder first.'); return; }
    const configPath = path.join(workspace, '.vscode', 'mcp.json');
    writeMcpConfig(configPath, 'servers', { type: 'stdio', command: 'node', args: [entry!] });
    vscode.window.showInformationMessage(`Mergen: MCP registered in ${configPath}. Reload VS Code to apply.`);
  } else if (action === 'Claude Code') {
    const configPath = path.join(home, '.claude', 'mcp.json');
    writeMcpConfig(configPath, 'mcpServers', { command: 'node', args: [entry!] });
    vscode.window.showInformationMessage(`Mergen: MCP registered in ${configPath}. Restart Claude Code to apply.`);
  }

  await ctx.globalState.update(MCP_DETECTED_KEY, true);
}

function writeMcpConfig(configPath: string, serversKey: string, serverEntry: Record<string, unknown>): void {
  try {
    const dir = path.dirname(configPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    let existing: Record<string, unknown> = {};
    try { existing = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>; } catch { /* new file */ }
    const existingServers = typeof existing[serversKey] === 'object' && existing[serversKey] !== null
      ? existing[serversKey] as Record<string, unknown>
      : {};
    fs.writeFileSync(configPath, JSON.stringify({
      ...existing,
      [serversKey]: { ...existingServers, mergen: serverEntry },
    }, null, 2) + '\n', 'utf8');
  } catch (err) {
    vscode.window.showErrorMessage(`Mergen: could not write MCP config — ${(err as Error).message}`);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  console.log('[Mergen] activate() called');
  context.subscriptions.push(mergenDiagnostics);

  // Register the sidebar webview provider
  const provider = new MergenPanel(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('mergen.panel', provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  // ── Status bar — always-on, high-contrast error counter ───────────────────
  _statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  _statusBar.text    = '$(debug-disconnect) Mergen';
  _statusBar.tooltip = 'Mergen — browser observability for AI debugging';
  _statusBar.command = 'mergen.openPanel';
  _statusBar.show();
  context.subscriptions.push(_statusBar);
  context.subscriptions.push({ dispose: () => { if (_statusPollTimer) clearInterval(_statusPollTimer); } });

  // Poll every 5 s — fast enough to feel live, slow enough to be invisible
  _statusPollTimer = setInterval(() => { void refreshStatusBar(); }, 5_000);
  setTimeout(() => { void refreshStatusBar(); }, 2_000); // initial read after server boot

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
    vscode.commands.registerCommand('mergen.openPolicies', () => {
      const cfg = vscode.workspace.getConfiguration('mergen');
      const port = cfg.get<number>('serverPort', 3000);
      vscode.env.openExternal(vscode.Uri.parse(`http://127.0.0.1:${port}/policies`));
    }),

    // ── mergen.askAI — one-click: error → AI chat pre-filled with context ──
    // Works with GitHub Copilot, Cursor, or any AI chat that responds to
    // the workbench chat open command. Falls back to opening the Mergen panel.
    vscode.commands.registerCommand('mergen.askAI', async () => {
      const cfg  = vscode.workspace.getConfiguration('mergen');
      const port = cfg.get<number>('serverPort', 3000);
      const health = await fetchHealth(port);
      const errors  = health?.errors  ?? 0;
      const netErrs = health?.networkErrors ?? 0;
      const warns   = health?.warnings ?? 0;

      let query: string;
      if (errors > 0 || netErrs > 0) {
        query = `Mergen captured ${errors + netErrs} error${errors + netErrs !== 1 ? 's' : ''} in the browser. ` +
          `Use get_unified_timeline and analyze_runtime to show me the root cause and fix. ` +
          `Start with EXACT confidence joins first.`;
      } else if (warns > 0) {
        query = `Mergen captured ${warns} warning${warns !== 1 ? 's' : ''} in the browser. ` +
          `Use get_recent_logs and explain_warning to diagnose before this escalates to an error.`;
      } else {
        query = `Use quick_check to see the current buffer state, then summarize what's happening in the app.`;
      }

      // Try VS Code Copilot Chat, then Cursor Chat, then clipboard fallback
      let opened = false;
      for (const cmd of ['workbench.action.chat.open', 'aichat.newchataction']) {
        try {
          await vscode.commands.executeCommand(cmd, { query, isPartialQuery: false });
          opened = true;
          break;
        } catch { /* try next */ }
      }
      if (!opened) {
        await vscode.env.clipboard.writeText(query);
        void vscode.window.showInformationMessage(
          'Mergen: query copied to clipboard — paste it into your AI chat.',
          'Open Panel',
        ).then((a) => { if (a === 'Open Panel') vscode.commands.executeCommand('mergen.openPanel'); });
      }
    }),

    // ── mergen.whyThisFile — "why was this code written this way?" ──────────
    // Fetches PR context for the active file from the commit intent archive
    // (GET /explain-why/file). Shows a quick-pick of matching PRs so the
    // developer can understand business reasoning without digging through git log.
    vscode.commands.registerCommand('mergen.whyThisFile', async () => {
      const editor    = vscode.window.activeTextEditor;
      const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
      const absPath   = editor?.document.uri.fsPath;

      if (!absPath) {
        vscode.window.showWarningMessage('Mergen: open a file first to look up its PR intent.');
        return;
      }

      const relPath = workspace ? path.relative(workspace, absPath) : path.basename(absPath);
      const cfg2  = vscode.workspace.getConfiguration('mergen');
      const port2 = cfg2.get<number>('serverPort', 3000);

      let data: { ok?: boolean; count?: number; contexts?: Array<{
        sha: string; prNumber: number | null; prTitle: string | null; prBody: string | null;
        author: string | null; approvers: string[]; linkedIssues: Array<{ ref: string }>;
        aiGenerated: boolean; aiTool: string | null; mergedAt: number | null; capturedAt: number;
      }> } | null = null;

      try {
        data = await new Promise((resolve, reject) => {
          const encodedPath = encodeURIComponent(relPath);
          const req = http.get(
            { hostname: '127.0.0.1', port: port2, path: `/explain-why/file?path=${encodedPath}`, timeout: 3000 },
            (res) => {
              let d = '';
              res.on('data', (c: string) => { d += c; });
              res.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error('parse')); } });
            },
          );
          req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
          req.on('error', reject);
        });
      } catch {
        vscode.window.showWarningMessage('Mergen: server not reachable — start it first.');
        return;
      }

      if (!data?.contexts?.length) {
        vscode.window.showInformationMessage(
          `Mergen: no PR context captured for ${path.basename(relPath)} yet. ` +
          `Connect POST /webhooks/github in your GitHub repo settings to start capturing PR intent.`,
        );
        return;
      }

      interface PRContext {
        sha: string; prNumber: number | null; prTitle: string | null; prBody: string | null;
        author: string | null; approvers: string[]; linkedIssues: Array<{ ref: string }>;
        aiGenerated: boolean; aiTool: string | null; mergedAt: number | null; capturedAt: number;
      }
      interface PRItem extends vscode.QuickPickItem { ctx: PRContext; }

      const items: PRItem[] = data.contexts.map((c) => {
        const issueRefs = c.linkedIssues?.map((i: { ref: string }) => i.ref).join(', ');
        const dateStr   = c.mergedAt ? new Date(c.mergedAt).toLocaleDateString() : (c.capturedAt ? new Date(c.capturedAt).toLocaleDateString() : '');
        const aiTag     = c.aiGenerated ? ` [${c.aiTool ?? 'AI'}]` : '';
        return {
          label:       c.prTitle ? `#${c.prNumber ?? c.sha}  ${c.prTitle}` : `#${c.prNumber ?? c.sha}`,
          description: [c.author ? `by ${c.author}` : '', dateStr].filter(Boolean).join(' · ') + aiTag,
          detail:      [issueRefs, c.prBody?.slice(0, 140)].filter(Boolean).join(' · ') || undefined,
          ctx:         c as PRContext,
        };
      });

      const picked = await vscode.window.showQuickPick(items, {
        title:       `Why was ${path.basename(relPath)} written this way?`,
        placeHolder: 'Select a PR to send its intent to AI Chat',
        matchOnDescription: true,
        matchOnDetail:      true,
      });

      if (!picked) return;
      const c = picked.ctx;

      const intentSummary = [
        `PR #${c.prNumber ?? c.sha}: ${c.prTitle ?? '(no title)'}`,
        c.author      ? `Author: ${c.author}`                               : '',
        c.approvers?.length ? `Approved by: ${c.approvers.join(', ')}`     : '',
        c.linkedIssues?.length ? `Issues: ${c.linkedIssues.map((i: { ref: string }) => i.ref).join(', ')}` : '',
        c.aiGenerated ? `AI-assisted: yes (${c.aiTool ?? 'unknown tool'})` : '',
        c.prBody      ? `\nDescription:\n${c.prBody}`                      : '',
      ].filter(Boolean).join('\n');

      const query = `I am debugging ${relPath}. Here is the PR intent context for the last change to this file:\n\n${intentSummary}\n\nBased on this intent, help me understand if the current runtime error is a regression or expected behaviour.`;

      try {
        await vscode.commands.executeCommand('workbench.action.chat.open', { query, isPartialQuery: false });
      } catch {
        await vscode.env.clipboard.writeText(query);
        vscode.window.showInformationMessage('Mergen: PR intent copied — paste into your AI chat.');
      }
    }),

    // ── mergen.connectAccount — opens mergen.dev signup in browser ─────────
    vscode.commands.registerCommand('mergen.connectAccount', () => {
      void vscode.env.openExternal(vscode.Uri.parse(CONNECT_URL));
    }),

    // ── mergen.enterLicenseKey — manual key entry fallback ─────────────────
    vscode.commands.registerCommand('mergen.enterLicenseKey', async () => {
      const key = await vscode.window.showInputBox({
        title:       'Mergen: Enter License Key',
        prompt:      'Paste your license key from mergen.dev/dashboard',
        placeHolder: 'mrgn_live_...',
        ignoreFocusOut: true,
        validateInput: (v) => v.trim().length < 8 ? 'Key looks too short' : null,
      });
      if (!key) return;
      await activateLicenseKey(key.trim(), provider);
    }),

    // ── mergen.signOut — deactivate license on local server ────────────────
    vscode.commands.registerCommand('mergen.signOut', async () => {
      const confirm = await vscode.window.showWarningMessage(
        'Sign out of Mergen? Your local server will revert to the free plan.',
        { modal: true },
        'Sign Out',
      );
      if (confirm !== 'Sign Out') return;
      const cfg  = vscode.workspace.getConfiguration('mergen');
      const port = cfg.get<number>('serverPort', 3000);
      await new Promise<void>((resolve) => {
        const req = http.request(
          { hostname: '127.0.0.1', port, path: '/license', method: 'DELETE', timeout: 3000 },
          (res) => { res.resume(); resolve(); },
        );
        req.on('error', () => resolve());
        req.on('timeout', () => { req.destroy(); resolve(); });
        req.end();
      });
      void provider.refresh();
      vscode.window.showInformationMessage('Mergen: signed out — now on the Free plan.');
    }),
  );

  // ── Intent card: notify panel when active file changes ─────────────────────
  // The panel sidebar shows PR context for whatever file the developer is looking
  // at. Fires on every editor switch so the card stays in sync with focus.
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (!editor) return;
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
      const absPath = editor.document.uri.fsPath;
      const relPath = workspaceRoot ? path.relative(workspaceRoot, absPath) : path.basename(absPath);
      provider.onActiveFileChanged(relPath);
    }),
  );
  // Seed the intent card with whatever is open when the extension activates.
  if (vscode.window.activeTextEditor) {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const absPath = vscode.window.activeTextEditor.document.uri.fsPath;
    const relPath = workspaceRoot ? path.relative(workspaceRoot, absPath) : path.basename(absPath);
    provider.onActiveFileChanged(relPath);
  }

  // ── URI handler: vscode://mergen.mergen/auth?token=mrgn_live_... ──────────
  // mergen.dev redirects here after Clerk auth + LemonSqueezy checkout.
  // VS Code prompts the user to confirm before we receive the URI.
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      handleUri(uri: vscode.Uri): void {
        if (uri.path !== '/auth') return;
        const params = new URLSearchParams(uri.query);
        const token = params.get('token');
        if (!token) {
          vscode.window.showErrorMessage('Mergen: no token in auth URI');
          return;
        }
        void activateLicenseKey(token, provider);
      },
    }),
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
      if (running) void checkMcpConfiguration(context);
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
    vscode.workspace.onDidSaveTextDocument(async (doc) => {
      const fp = doc.uri.fsPath;
      if (!/\.[jt]sx?$|\.py$|\.java$|\.cs$|\.go$|\.rb$/.test(fp)) return;
      if (/\.(test|spec)\.[jt]sx?$/.test(fp)) return;

      // ── Test file touch (existing behaviour) ──────────────────────────────
      if (/\.[jt]sx?$/.test(fp)) {
        const dir  = path.dirname(fp);
        const base = path.basename(fp).replace(/\.[^.]+$/, '');
        const candidates = ['.test.ts', '.spec.ts', '.test.tsx', '.spec.tsx', '.test.js', '.spec.js']
          .map((s) => path.join(dir, base + s));
        const now = new Date();
        for (const c of candidates) {
          try { if (fs.existsSync(c)) fs.utimesSync(c, now, now); } catch { /* non-fatal */ }
        }
      }

      // ── Regression detection: snapshot errors before → wait for HMR → compare ──
      // Debounced per-file: if the same file is saved again within 3.5s, skip
      // the pending check so concurrent saves don't stack up async waits.
      const cfg2  = vscode.workspace.getConfiguration('mergen');
      const port2 = cfg2.get<number>('serverPort', 3000);

      if (_pendingSaveChecks.has(fp)) return;
      _pendingSaveChecks.add(fp);

      // Capture baseline — what was broken BEFORE this save
      const before = await fetchHealth(port2);
      if (!before?.ok) { _pendingSaveChecks.delete(fp); return; }
      const errsBefore = (before.errors ?? 0) + (before.networkErrors ?? 0);

      // Wait for HMR / hot-reload (typically 1-3 s)
      await new Promise<void>((r) => setTimeout(r, 3500));
      _pendingSaveChecks.delete(fp);

      const after = await fetchHealth(port2);
      if (!after?.ok) return;
      const errsAfter = (after.errors ?? 0) + (after.networkErrors ?? 0);
      const delta = errsAfter - errsBefore;

      const fileName = path.basename(fp);

      if (delta > 0) {
        // New errors appeared after saving this file — tell the developer immediately
        const action = await vscode.window.showWarningMessage(
          `Mergen: saving ${fileName} introduced ${delta} new error${delta !== 1 ? 's' : ''}. Fix before continuing?`,
          'Analyze with AI',
          'Why this code?',
          'Ignore',
        );
        if (action === 'Analyze with AI') {
          await vscode.commands.executeCommand('mergen.askAI');
        } else if (action === 'Why this code?') {
          await vscode.commands.executeCommand('mergen.whyThisFile');
        }
      } else if (errsBefore > 0 && errsAfter < errsBefore) {
        // Errors went DOWN — the save fixed something. Positive reinforcement.
        const fixed = errsBefore - errsAfter;
        void vscode.window.showInformationMessage(
          `Mergen: ${fileName} resolved ${fixed} error${fixed !== 1 ? 's' : ''}. ${errsAfter > 0 ? `${errsAfter} remain.` : 'Buffer clean.'}`,
        );
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

// ── License activation helper ────────────────────────────────────────────────
// Shared by the URI handler (deep link) and the manual-entry command.
// POSTs to the local server, then refreshes the panel.
async function activateLicenseKey(key: string, provider: MergenPanel): Promise<void> {
  const cfg  = vscode.workspace.getConfiguration('mergen');
  const port = cfg.get<number>('serverPort', 3000);

  try {
    const result = await new Promise<{ ok?: boolean; plan?: string; email?: string; error?: string }>(
      (resolve, reject) => {
        const body = JSON.stringify({ key });
        const req  = http.request(
          {
            hostname: '127.0.0.1', port, path: '/license', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
            timeout: 8000,
          },
          (res) => {
            let d = '';
            res.on('data', (c: string) => { d += c; });
            res.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error('parse')); } });
          },
        );
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        req.write(body);
        req.end();
      },
    );

    if (result.error) {
      vscode.window.showErrorMessage(`Mergen: activation failed — ${result.error}`);
      return;
    }

    void provider.refresh();
    const planLabel = result.plan ? ` (${result.plan})` : '';
    const emailLabel = result.email ? ` as ${result.email}` : '';
    vscode.window.showInformationMessage(`Mergen: connected${emailLabel}${planLabel} ✓`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === 'timeout' || msg.includes('ECONNREFUSED')) {
      vscode.window.showErrorMessage('Mergen: server not running — start it first, then try again.');
    } else {
      vscode.window.showErrorMessage(`Mergen: activation error — ${msg}`);
    }
  }
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
  let payload: { perDetector?: PerDetector[]; overallAccuracy?: number | null; trustedDetectors?: number; totalDetectors?: number; corpusSeeded?: boolean } | null = null;
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

  const isWarmingUp = !!payload.corpusSeeded;

  const items: vscode.QuickPickItem[] = sorted.map((s) => {
    let icon: string, label: string;
    if (isWarmingUp) {
      // All detectors appear "trusted" during warm-up because seeds exceed MIN_SAMPLES.
      // Show prior accuracy as a calibration baseline, not as live performance.
      const pct = Math.round(s.accuracy * 100);
      icon = '$(circle-outline)';
      label = `prior: ${pct}% · warming up`;
    } else if (!s.trusted) {
      icon = '$(circle-outline)';
      label = `new · ${s.verdicts}/${s.predictions} rated`;
    } else {
      const pct = Math.round(s.accuracy * 100);
      icon = pct >= 75 ? '$(check)' : pct >= 50 ? '$(warning)' : '$(error)';
      label = `${pct}% · ${Math.round(s.accuracy * s.verdicts)}/${s.verdicts} correct`;
    }
    let trend = '';
    if (!isWarmingUp && typeof s.trendDelta === 'number' && s.trendDelta !== 0) {
      const delta = Math.round(s.trendDelta * 100);
      trend = delta > 0 ? `  ▲ ${delta}% (7d)` : `  ▼ ${Math.abs(delta)}% (7d)`;
    }
    return {
      label: `${icon} ${s.tag}`,
      description: label + trend,
      detail: isWarmingUp
        ? 'Calibration prior — rate analyses to build live accuracy.'
        : s.shouldInterrupt
          ? 'Trusted enough to interrupt your flow.'
          : s.trusted
            ? 'Trusted but quiet — won\'t grab attention.'
            : 'Not trusted yet — needs more verdicts.',
    };
  });

  const overall = isWarmingUp
    ? `${payload.totalDetectors ?? list.length} detector(s) · collecting real verdicts`
    : payload.overallAccuracy != null
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

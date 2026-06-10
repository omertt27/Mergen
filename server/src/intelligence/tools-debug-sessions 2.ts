import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { store } from '../sensor/buffer.js';
import {
  startDebugSession, checkpointSession, endDebugSession,
  getSession, listActiveSessions, captureSnapshot,
} from './debug-sessions.js';

export function registerDebugSessionTools(server: McpServer): void {
  // ── start_debug_session ────────────────────────────────────────────────────
  server.registerTool(
    'start_debug_session',
    {
      description:
        '⚡ FREE · Start an iterative debugging session. Fingerprints every current error/warning/' +
        'network failure as a baseline. After each fix attempt, call checkpoint_debug_session to get ' +
        'a precise 3-way diff: ✅ resolved | ❌ persisted | ⚠️ new regressions. ' +
        'Closes the loop — no more manually describing what changed between iterations.',
      inputSchema: {
        hypothesis: z.string().min(10).max(500)
          .describe('What you think is broken (e.g. "JWT token expires before refresh fires")'),
        target_component: z.string().optional()
          .describe('Optional component/file to focus on (e.g. "LoginForm", "auth.ts")'),
      },
    },
    async ({ hypothesis, target_component }) => {
      const errors   = store.getLogs(200, 'error');
      const warns    = store.getLogs(200, 'warn');
      const netFail  = store.getNetwork(200).filter(n => n.status >= 400 || n.status === 0 || n.error);
      const baseline = captureSnapshot(errors, warns, netFail);
      const session  = startDebugSession(hypothesis, baseline, target_component);

      const lines: string[] = [
        '## 🔬 Debug Session Started', '',
        `**Session ID:** \`${session.id}\``,
        `**Hypothesis:** ${hypothesis}`,
        ...(target_component ? [`**Target:** ${target_component}`] : []),
        '',
        '### Baseline Fingerprinted',
        `| | Count |`, `|---|---|`,
        `| Errors           | ${baseline.errors.length} |`,
        `| Warnings         | ${baseline.warnings.length} |`,
        `| Network failures | ${baseline.networkFailures.length} |`,
      ];

      if (baseline.errors.length > 0) {
        lines.push('', '**Errors to resolve:**', '```');
        for (const e of baseline.errors.slice(0, 5))
          lines.push(`[${e.level.toUpperCase()}] ${e.message.slice(0, 150)}`);
        if (baseline.errors.length > 5) lines.push(`... +${baseline.errors.length - 5} more`);
        lines.push('```');
      } else {
        lines.push('', '> ✅ No errors at baseline — session will track any NEW errors that appear.');
      }

      lines.push(
        '', '### Workflow',
        '1. Apply your fix to the code',
        '2. Reproduce the scenario in the browser',
        `3. Call \`checkpoint_debug_session\` with \`session_id: "${session.id}"\` + a short note`,
        '4. See what resolved, what persisted, and any regressions',
        `5. Repeat until clean, then call \`end_debug_session("${session.id}")\``,
      );

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  // ── checkpoint_debug_session ───────────────────────────────────────────────
  server.registerTool(
    'checkpoint_debug_session',
    {
      description:
        '⚡ FREE · Record a fix attempt and see the exact diff vs baseline. ' +
        'Call this after every code change + browser reproduction — no credit cost. ' +
        'Returns: ✅ resolved (gone) | ❌ persisted (still broken) | ⚠️ new (regression). ' +
        'Use end_debug_session when satisfied.',
      inputSchema: {
        session_id: z.string()
          .describe('Session ID from start_debug_session'),
        note: z.string().max(300).optional()
          .describe('What you just changed (e.g. "added null check before token read")'),
      },
    },
    async ({ session_id, note }) => {
      const session = getSession(session_id);
      if (!session) {
        const active = listActiveSessions()
          .map(s => `"${s.id.slice(0, 8)}…" (${s.description.slice(0, 40)})`).join(', ');
        return {
          content: [{ type: 'text', text: `❌ Session \`${session_id}\` not found.\nActive: ${active || 'none'}` }],
          isError: true,
        };
      }

      const errors   = store.getLogs(200, 'error',   session.baseline.capturedAt);
      const warns    = store.getLogs(200, 'warn',    session.baseline.capturedAt);
      const netFail  = store.getNetwork(200, undefined, session.baseline.capturedAt)
        .filter(n => n.status >= 400 || n.status === 0 || n.error);
      const current  = captureSnapshot(errors, warns, netFail);
      const iterNote = note ?? `Fix attempt ${session.iterations.length + 1}`;
      const result   = checkpointSession(session_id, current, iterNote);
      if (!result) return { content: [{ type: 'text', text: '❌ Session expired.' }], isError: true };

      const { diff, session: s } = result;
      const lines: string[] = [
        `## 🔬 Checkpoint — Iteration ${s.iterations.length}`,
        `**Fix applied:** ${iterNote}`,
        '', '### Diff vs Baseline', '',
      ];

      if (diff.resolved.length > 0) {
        lines.push(`✅ **Resolved (${diff.resolved.length}) — gone:**`);
        diff.resolved.forEach(e => lines.push(`  - \`${e.message.slice(0, 120)}\``));
        lines.push('');
      }
      if (diff.persisted.length > 0) {
        lines.push(`❌ **Persisted (${diff.persisted.length}) — fix didn't work:**`);
        diff.persisted.forEach(e => lines.push(`  - \`${e.message.slice(0, 120)}\``));
        lines.push('');
      }
      if (diff.newErrors.length > 0) {
        lines.push(`⚠️ **New regressions (${diff.newErrors.length}):**`);
        diff.newErrors.forEach(e => lines.push(`  - \`${e.message.slice(0, 120)}\``));
        lines.push('');
      }
      if (diff.resolvedNetworkFailures.length > 0) {
        lines.push(`✅ **Network failures fixed (${diff.resolvedNetworkFailures.length}):**`);
        diff.resolvedNetworkFailures.forEach(n => lines.push(`  - \`${n.summary}\``));
        lines.push('');
      }
      if (diff.newNetworkFailures.length > 0) {
        lines.push(`⚠️ **New network failures (${diff.newNetworkFailures.length}):**`);
        diff.newNetworkFailures.forEach(n => lines.push(`  - \`${n.summary}\``));
        lines.push('');
      }
      if (!diff.resolved.length && !diff.persisted.length && !diff.newErrors.length &&
          !diff.resolvedNetworkFailures.length && !diff.newNetworkFailures.length) {
        lines.push('> ⚠️ No events since session start. Reproduce the scenario in the browser first.');
      }

      lines.push('---');
      if (diff.isFixed) {
        lines.push(`✅ **All baseline errors resolved!** Call \`end_debug_session("${session_id}")\`.`);
      } else {
        const rem = diff.persisted.length + diff.newErrors.length;
        lines.push(`❌ **${rem} error(s) remain.** Apply another fix, reproduce, then checkpoint again.`);
        lines.push(`> 💡 \`analyze_runtime(since: ${session.baseline.capturedAt})\` for root-cause + fix.`);
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  // ── end_debug_session ──────────────────────────────────────────────────────
  server.registerTool(
    'end_debug_session',
    {
      description:
        '⚡ FREE · Close a debugging session with a final resolved/persisted/new diff. ' +
        'Use when the bug is fixed or you are done. ' +
        'For mid-session progress checks without closing, use checkpoint_debug_session.',
      inputSchema: {
        session_id: z.string()
          .describe('Session ID from start_debug_session'),
      },
    },
    async ({ session_id }) => {
      const session = getSession(session_id);
      if (!session) {
        const active = listActiveSessions().map(s => `"${s.id.slice(0, 8)}…"`).join(', ');
        return {
          content: [{ type: 'text', text: `❌ Session \`${session_id}\` not found. Active: ${active || 'none'}` }],
          isError: true,
        };
      }

      const errors   = store.getLogs(200, 'error',   session.baseline.capturedAt);
      const warns    = store.getLogs(200, 'warn',    session.baseline.capturedAt);
      const netFail  = store.getNetwork(200, undefined, session.baseline.capturedAt)
        .filter(n => n.status >= 400 || n.status === 0 || n.error);
      const current = captureSnapshot(errors, warns, netFail);
      const result  = endDebugSession(session_id, current);
      if (!result) return { content: [{ type: 'text', text: '❌ Session already closed.' }], isError: true };

      const { session: s, diff } = result;
      const duration = Math.round(((s.endedAt ?? Date.now()) - s.startedAt) / 1000);

      const lines: string[] = [
        '## 🔬 Debug Session Closed', '',
        `**Hypothesis:** ${s.description}`,
        ...(s.targetComponent ? [`**Target:** ${s.targetComponent}`] : []),
        `**Duration:** ${duration}s  |  **Iterations:** ${s.iterations.length}`,
        '', '### Final Diff vs Baseline', '',
      ];

      if (diff.resolved.length > 0) {
        lines.push(`✅ **Resolved (${diff.resolved.length}):**`);
        diff.resolved.forEach(e => lines.push(`  - \`${e.message.slice(0, 120)}\``));
        lines.push('');
      }
      if (diff.persisted.length > 0) {
        lines.push(`❌ **Still broken (${diff.persisted.length}):**`);
        diff.persisted.forEach(e => lines.push(`  - \`${e.message.slice(0, 120)}\``));
        lines.push('');
      }
      if (diff.newErrors.length > 0) {
        lines.push(`⚠️ **New regressions (${diff.newErrors.length}):**`);
        diff.newErrors.forEach(e => lines.push(`  - \`${e.message.slice(0, 120)}\``));
        lines.push('');
      }
      if (diff.resolvedNetworkFailures.length > 0) {
        lines.push(`✅ **Network failures fixed (${diff.resolvedNetworkFailures.length}):**`);
        diff.resolvedNetworkFailures.forEach(n => lines.push(`  - \`${n.summary}\``));
        lines.push('');
      }

      lines.push('---');
      if (diff.isFixed) {
        lines.push('✅ **Bug resolved.** All baseline errors gone, no regressions.');
      } else if (diff.persisted.length > 0 || diff.newErrors.length > 0) {
        const rem = diff.persisted.length + diff.newErrors.length;
        lines.push(`⚠️ Closed with **${rem} unresolved error(s)**. Start a new session to continue.`);
      } else {
        lines.push('ℹ️ No events since session start — scenario may not have been reproduced.');
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );
}

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { store } from '../sensor/buffer.js';
import { getRecords, recordVerdict } from './calibration.js';
import { layer4Store } from '../sensor/layer4-store.js';
import { closeSession } from './session-metrics.js';
import { trackCall } from './tools-state.js';

function _registerValidateFix(server: McpServer): void {
  server.registerTool(
    'validate_fix',
    {
      description:
        'Check whether a code fix actually resolved the issue. ' +
        'Pass the pid from reconstruct_context and the Unix ms timestamp from just before the fix was applied. ' +
        'Compares console error counts and network error counts before vs after. ' +
        'Returns RESOLVED (0 errors after), PARTIAL (≥50% reduction), REGRESSED (more errors), or UNRESOLVED. ' +
        'Automatically records the verdict to the calibration corpus so future diagnoses improve. ' +
        'ALWAYS call this after applying a fix — even if you are confident it worked.',
      inputSchema: {
        pid: z.string()
          .describe('Prediction id (pid) from reconstruct_context — identifies the hypothesis being validated'),
        since: z.number().int()
          .describe('Unix ms timestamp from just before the fix was applied — used as the before/after boundary'),
        window_ms: z.number().int().min(5_000).max(300_000).optional()
          .describe('How many ms of pre-fix history to compare against (default 60000 = 1 minute)'),
      },
    },
    async ({ pid, since, window_ms = 60_000 }) => {
      trackCall('validate_fix');

      const windowStart = since - window_ms;
      const records = getRecords();
      const prediction = records.find((r) => r.pid === pid);

      const logsBefore = store.getLogs(200, 'error', windowStart).filter((e) => e.timestamp < since);
      const netBefore  = store.getNetwork(200, undefined, windowStart).filter(
        (e) => e.timestamp < since && (e.status >= 400 || !!e.error),
      );
      const logsAfter = store.getLogs(200, 'error', since);
      const netAfter  = store.getNetwork(200, undefined, since).filter((e) => e.status >= 400 || !!e.error);

      const errsBefore = logsBefore.length + netBefore.length;
      const errsAfter  = logsAfter.length  + netAfter.length;

      let verdict: 'correct' | 'partial' | 'wrong';
      let status: string;

      if (errsAfter === 0 && errsBefore > 0) {
        verdict = 'correct'; status = 'RESOLVED';
      } else if (errsAfter === 0 && errsBefore === 0) {
        verdict = 'correct'; status = 'CLEAN — no errors before or after';
      } else if (errsBefore > 0 && errsAfter < errsBefore * 0.5) {
        verdict = 'partial'; status = 'PARTIAL';
      } else {
        verdict = 'wrong';
        status = errsAfter > errsBefore ? 'REGRESSED' : 'UNRESOLVED';
      }

      if (prediction && !prediction.verdict) {
        recordVerdict(pid, verdict);

        if (prediction.errorFingerprint) {
          layer4Store.linkFix(prediction.errorFingerprint, pid, prediction.tag, verdict);
        }

        const outcome = verdict === 'correct' ? 'resolved' : verdict === 'partial' ? 'partial' : 'unresolved';
        closeSession(pid, outcome);
      }

      const tag = prediction?.tag ?? 'unknown';
      const lines = [
        `## Fix Validation — \`${tag}\``,
        '',
        `**Status: ${status}**`,
        '',
        `| | Before fix | After fix |`,
        `|---|---|---|`,
        `| Console errors | ${logsBefore.length} | ${logsAfter.length} |`,
        `| Network errors | ${netBefore.length}  | ${netAfter.length}  |`,
        `| **Total** | **${errsBefore}** | **${errsAfter}** |`,
        '',
        prediction
          ? `Verdict \`${verdict}\` recorded for detector \`${prediction.tag}\`.`
          : `No prediction record found for pid \`${pid}\` — calibration not updated.`,
      ];

      if (logsAfter.length > 0) {
        lines.push('', '### Remaining console errors:');
        for (const e of logsAfter.slice(0, 5)) {
          const msg = e.args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ').slice(0, 150);
          lines.push(`- \`${new Date(e.timestamp).toISOString().slice(11, 19)}\` ${msg}`);
        }
      }
      if (netAfter.length > 0) {
        lines.push('', '### Remaining network errors:');
        for (const n of netAfter.slice(0, 5)) {
          lines.push(`- \`${new Date(n.timestamp).toISOString().slice(11, 19)}\` ${n.method} ${n.url} → ${n.status || 'ERR'}`);
        }
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );
}

/** Registers only `validate_fix` — used by slim (5-tool) MCP mode. */
export function registerValidateFix(server: McpServer): void {
  _registerValidateFix(server);
}

export function registerValidateTools(server: McpServer): void {
  _registerValidateFix(server);

  // ── watch_for_fix ────────────────────────────────────────────────────────────
  server.registerTool(
    'watch_for_fix',
    {
      description:
        'Start watching source files for changes so validate_fix runs automatically on each save. ' +
        'Returns immediately — validation happens in the background 2 seconds after any file changes. ' +
        'Results appear in the dashboard at http://127.0.0.1:3000/dashboard and in the next validate_fix call. ' +
        'Best practice: call right after reconstruct_context, before editing any files. ' +
        'Only one watch is active at a time — starting a new one stops the previous.',
      inputSchema: {
        pid: z.string()
          .describe('Prediction id from reconstruct_context'),
        since: z.number().int()
          .describe('Unix ms timestamp from just before you started editing — the before/after boundary'),
        paths: z.array(z.string()).min(1).max(50)
          .describe('File or directory paths to watch for changes (e.g. ["src/auth/token.ts", "src/api/"])'),
      },
    },
    async ({ pid, since, paths }) => {
      trackCall('watch_for_fix');
      const { startFileWatch } = await import('../sensor/fs-watcher.js');
      startFileWatch({ pid, since, paths });
      return {
        content: [{
          type: 'text',
          text: [
            `Watching ${paths.length} path${paths.length !== 1 ? 's' : ''} for changes.`,
            '',
            `Paths: ${paths.slice(0, 5).join(', ')}${paths.length > 5 ? ` +${paths.length - 5} more` : ''}`,
            `Prediction: \`${pid}\``,
            '',
            `**Next steps:**`,
            `1. Tell the user: "Apply your fix and save the file."`,
            `2. After they save, call \`validate_fix(pid: "${pid}", since: ${since})\` to get the RESOLVED/PARTIAL/REGRESSED verdict.`,
            `3. Report the verdict clearly: "✅ RESOLVED — 0 errors after fix" or "❌ UNRESOLVED — N errors remain".`,
            `4. If RESOLVED, call \`stop_file_watch()\`. If not, show remaining errors and suggest next steps.`,
            '',
            `Dashboard: http://127.0.0.1:3000/dashboard (shows live validation state)`,
          ].join('\n'),
        }],
      };
    },
  );

  // ── stop_file_watch ──────────────────────────────────────────────────────────
  server.registerTool(
    'stop_file_watch',
    {
      description:
        'Stop the active file watch. ' +
        'Called automatically when a fix is confirmed resolved. ' +
        'Call manually when switching to a different issue or ending a debug session.',
      inputSchema: {},
    },
    async () => {
      trackCall('stop_file_watch');
      const { stopFileWatch, getWatchState } = await import('../sensor/fs-watcher.js');
      const state = getWatchState();
      stopFileWatch();
      return {
        content: [{
          type: 'text',
          text: state
            ? `Stopped watching ${state.paths.length} path${state.paths.length !== 1 ? 's' : ''}.`
            : 'No active file watch.',
        }],
      };
    },
  );
}

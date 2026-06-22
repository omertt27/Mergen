import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { store } from '../sensor/buffer.js';
import type { ConsoleEvent, NetworkEvent } from '../sensor/buffer-schemas.js';
import { getRecords, recordVerdict, updateCalibrationNote, getRealVerdictCount, isCorpusSeeded, classifyVerdict } from './calibration.js';
import { layer4Store } from '../sensor/layer4-store.js';
import { closeSession } from './session-metrics.js';
import { trackCall } from './tools-state.js';

function _registerValidateFix(server: McpServer): void {
  // @ts-ignore — TS2589: MCP SDK's deep generic inference hits the recursion limit
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

      const logsBefore: ConsoleEvent[] = store.getLogs(200, 'error', windowStart).filter((e) => e.timestamp < since);
      const netBefore: NetworkEvent[]  = store.getNetwork(200, undefined, windowStart).filter(
        (e) => e.timestamp < since && (e.status >= 400 || !!e.error),
      );
      const logsAfter: ConsoleEvent[] = store.getLogs(200, 'error', since);
      const netAfter: NetworkEvent[]  = store.getNetwork(200, undefined, since).filter((e) => e.status >= 400 || !!e.error);

      const errsBefore = logsBefore.length + netBefore.length;
      const errsAfter  = logsAfter.length  + netAfter.length;

      const verdict = classifyVerdict(errsBefore, errsAfter);
      let status: string;
      if (verdict === 'correct') {
        status = errsBefore === 0 ? 'CLEAN — no errors before or after' : 'RESOLVED';
      } else if (verdict === 'partial') {
        status = 'PARTIAL';
      } else {
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

      // tag and lines must be declared before the verdict-specific push blocks below
      const tag = prediction?.tag ?? 'unknown';
      const verdictEmoji = verdict === 'correct' ? '✅' : verdict === 'partial' ? '⚠️' : '❌';
      const lines = [
        `## Fix Validation — \`${tag}\``,
        '',
        `**Status: ${verdictEmoji} ${status}**`,
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

      // Surface verdict meaning explicitly, especially on wrong/partial
      if (verdict === 'wrong') {
        lines.push(
          '',
          '### ❌ Diagnosis was incorrect',
          '',
          `The fix did not reduce errors — the \`${tag}\` hypothesis appears to have been wrong.`,
          '',
          '**What this means:**',
          '- This verdict has been recorded. Future diagnoses for this pattern will be recalibrated downward.',
          '- The causal chain may have been incomplete — only the first hypothesis was tested.',
          '',
          '**Next steps:**',
          '1. Call `reconstruct_context` again — the wrong-verdict feedback improves the next analysis.',
          '2. Check if errors changed in character (new error type appearing post-fix may reveal the real cause).',
          '3. If you know what the actual root cause was, the calibration record is already saved — no additional action needed.',
        );
      } else if (verdict === 'partial') {
        lines.push(
          '',
          '> ⚠️ **Partial resolution** — errors reduced but not eliminated. The hypothesis may be correct but the fix incomplete, or there are multiple overlapping causes. Call `reconstruct_context` to check remaining signals.',
        );
      }

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

      // ── Combined feedback moment (Items 3 + 4) ────────────────────────────
      // One interaction, not two — stacking prompts back-to-back feels naggy.
      //
      // Item 3 (implicit rationale): invite the dev to note why, skippable.
      // Item 4 (verdict count): surface local verdict count so the dev knows
      //   whether the 94% accuracy figure is proven in their environment yet.
      const realVerdicts = getRealVerdictCount();
      const provisional  = isCorpusSeeded() || realVerdicts < 10;

      if (prediction && verdict !== 'wrong') {
        lines.push(
          '',
          '---',
          '',
          '### 📝 Optional: record why (for future reference)',
          '',
          `Root cause \`${tag}\` is recorded. If you know *why* this pattern occurred — a constraint, a workaround, or context that would help future-you — call:`,
          '',
          `\`\`\``,
          `record_fix_rationale(pid: "${pid}", rationale: "your note here")`,
          `\`\`\``,
          '',
          'This is skippable at zero cost — ignore it and nothing breaks. If answered, the note surfaces wherever past incidents for this detector are shown.',
        );
      }

      if (provisional) {
        const countLabel = realVerdicts === 0
          ? 'no local verdicts yet'
          : `${realVerdicts} local verdict${realVerdicts !== 1 ? 's' : ''} recorded`;
        lines.push(
          '',
          `> ⚠️ **Provisional accuracy** — ${countLabel} in this environment. The published 94% figure is from built-in priors, not measurements on your stack. Treat confidence scores as estimates until you have 10+ real verdicts. Autopilot applies a more conservative effective threshold during this period (the untrained classifier holds blended confidence below the execution gate).`,
        );
      } else {
        lines.push(
          '',
          `> ✅ **${realVerdicts} local verdicts recorded** — confidence estimates are calibrated from your environment's actual incident history.`,
        );
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

  // ── record_fix_rationale ─────────────────────────────────────────────────
  // Item 3: implicit rationale capture — called at the moment the dev is already
  // in context (right after validate_fix), so friction is minimal.
  server.registerTool(
    'record_fix_rationale',
    {
      description:
        'Record WHY a root cause was correct — the constraint, workaround, or context that would help future-you. ' +
        'Call this immediately after validate_fix returns RESOLVED or PARTIAL. ' +
        'The note is stored on the calibration record and surfaced wherever past incidents for this detector are shown. ' +
        'Completely optional — if skipped, nothing breaks and you will not be reminded again for this incident.',
      inputSchema: {
        pid: z.string()
          .describe('Prediction id (pid) from reconstruct_context / validate_fix'),
        rationale: z.string().min(1).max(500)
          .describe('Free-text note: why did this root cause occur? What constraint or context is worth remembering?'),
      },
    },
    async ({ pid, rationale }) => {
      trackCall('record_fix_rationale');
      const saved = updateCalibrationNote(pid, rationale);
      return {
        content: [{
          type: 'text',
          text: saved
            ? `✅ Rationale recorded for prediction \`${pid}\`. It will appear in \`get_detector_calibration\` output for future incidents of the same type.`
            : `❌ Prediction \`${pid}\` not found — rationale not saved. Check that the pid is from a recent \`reconstruct_context\` call.`,
        }],
      };
    },
  );

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
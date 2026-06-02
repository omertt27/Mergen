import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { store } from '../sensor/buffer.js';
import { layer2Store } from '../sensor/layer2-store.js';
import { layer3Store } from '../sensor/layer3-store.js';
import { layer4Store } from '../sensor/layer4-store.js';

export function registerLayerTools(server: McpServer): void {
  // ── Layer 1: get_component_tree ───────────────────────────────────────────────
  server.registerTool(
    'get_component_tree',
    {
      description:
        'Returns full React/Vue component tree with props and state at error time. ' +
        'Much more detailed than the simple component name in get_dom_context. ' +
        'Use this when you need to understand the entire component hierarchy and state at crash time.',
      inputSchema: {
        since: z.number().int().optional()
          .describe('Only return trees captured after this Unix timestamp in ms'),
      },
    },
    async ({ since }) => {
      const contexts = store.getContext(10, since);

      // Filter contexts that have componentTree data (Layer 1 extended schema)
      const withTrees = contexts.filter((c: any) => c.componentTree);

      if (withTrees.length === 0) {
        return {
          content: [{
            type: 'text',
            text: '⚠️ No component trees captured yet. This feature requires the extension to send enhanced context snapshots.',
          }],
        };
      }

      const lines: string[] = ['## Component Trees'];
      for (const ctx of withTrees) {
        const ts = new Date(ctx.timestamp).toISOString();
        lines.push('');
        lines.push(`### ${ts} — ${ctx.url}`);
        lines.push('');
        lines.push('```json');
        lines.push(JSON.stringify((ctx as any).componentTree, null, 2));
        lines.push('```');
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  // ── Layer 1: get_state_diff ───────────────────────────────────────────────────
  server.registerTool(
    'get_state_diff',
    {
      description:
        'Returns Redux/Zustand/Jotai state snapshots showing before/after changes that led to errors. ' +
        'Critical for understanding state corruption bugs. Shows exact field mutations.',
      inputSchema: {
        since: z.number().int().optional()
          .describe('Only return state diffs after this Unix timestamp in ms'),
      },
    },
    async ({ since }) => {
      const contexts = store.getContext(20, since);
      const withDiffs = contexts.filter((c: any) => c.stateDiff);

      if (withDiffs.length === 0) {
        return {
          content: [{
            type: 'text',
            text: '⚠️ No state diffs captured yet. This requires Redux/Zustand/Jotai instrumentation in the extension.',
          }],
        };
      }

      const lines: string[] = ['## State Diffs'];
      for (const ctx of withDiffs) {
        const diff = (ctx as any).stateDiff;
        const ts = new Date(ctx.timestamp).toISOString();
        lines.push('');
        lines.push(`### ${ts} — ${diff.framework}`);
        if (diff.field) lines.push(`**Field:** \`${diff.field}\``);
        lines.push('');
        lines.push('**Before:**');
        lines.push('```json');
        lines.push(JSON.stringify(diff.before, null, 2));
        lines.push('```');
        lines.push('');
        lines.push('**After:**');
        lines.push('```json');
        lines.push(JSON.stringify(diff.after, null, 2));
        lines.push('```');
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  // ── Layer 1: get_performance_trace ────────────────────────────────────────────
  server.registerTool(
    'get_performance_trace',
    {
      description:
        'Returns PerformanceObserver data: long tasks, layout shifts, paint timings, forced reflows. ' +
        'Use when investigating slowness, jank, or performance-related crashes.',
      inputSchema: {
        since: z.number().int().optional()
          .describe('Only return traces after this Unix timestamp in ms'),
      },
    },
    async ({ since }) => {
      const contexts = store.getContext(20, since);
      const withPerf = contexts.filter((c: any) => c.performanceTrace && c.performanceTrace.length > 0);

      if (withPerf.length === 0) {
        return {
          content: [{
            type: 'text',
            text: '⚠️ No performance traces captured yet. This requires PerformanceObserver instrumentation in the extension.',
          }],
        };
      }

      const lines: string[] = ['## Performance Traces'];
      for (const ctx of withPerf) {
        const traces = (ctx as any).performanceTrace;
        const ts = new Date(ctx.timestamp).toISOString();
        lines.push('');
        lines.push(`### ${ts} — ${ctx.url}`);
        lines.push('');
        lines.push('| Type | Name | Start | Duration |');
        lines.push('|------|------|-------|----------|');
        for (const trace of traces) {
          lines.push(`| ${trace.entryType} | ${trace.name} | ${trace.startTime.toFixed(2)}ms | ${trace.duration.toFixed(2)}ms |`);
        }
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  // ── Layer 2: replay_event ─────────────────────────────────────────────────────
  server.registerTool(
    'replay_event',
    {
      description:
        '💰 PAID · Returns the full event detail by ID. Every event gets a unique ID when ingested. ' +
        'Use this to inspect the complete raw data for a specific event mentioned in logs.',
      inputSchema: {
        event_id: z.string().describe('Event ID from the buffer'),
      },
    },
    async ({ event_id }) => {
      const event = layer2Store.getEventById(event_id);

      if (!event) {
        return {
          content: [{
            type: 'text',
            text: `❌ Event not found: ${event_id}`,
          }],
        };
      }

      return {
        content: [{
          type: 'text',
          text: '```json\n' + JSON.stringify(event, null, 2) + '\n```',
        }],
      };
    },
  );

  // ── Layer 2: watch ────────────────────────────────────────────────────────────
  server.registerTool(
    'watch',
    {
      description:
        '💰 PAID · Subscribe to a pattern and get notified on next occurrence. ' +
        'AI can use this proactively: "tell me next time /api/auth returns non-200". ' +
        'Pattern can be a URL substring, error message regex, or state path.',
      inputSchema: {
        pattern: z.string().describe('Pattern to watch (regex or substring)'),
        type: z.enum(['network', 'console', 'state']).describe('Event type to watch'),
      },
    },
    async ({ pattern, type }) => {
      const id = layer2Store.registerWatch(pattern, type);

      return {
        content: [{
          type: 'text',
          text: `✅ Watch registered: ${id}\nPattern: "${pattern}"\nType: ${type}\n\nYou'll be notified when this pattern matches.`,
        }],
      };
    },
  );

  // ── Layer 2: get_timeline ─────────────────────────────────────────────────────
  server.registerTool(
    'get_timeline',
    {
      description:
        'Returns all events between two timestamps in chronological order. ' +
        'Essential for diagnosing race conditions. Shows the exact sequence of events.',
      inputSchema: {
        from: z.number().int().describe('Start Unix timestamp in ms'),
        to: z.number().int().describe('End Unix timestamp in ms'),
      },
    },
    async ({ from, to }) => {
      const logs = store.getLogs(200, undefined, from);
      const network = store.getNetwork(200, undefined, from);
      const contexts = store.getContext(20, from);

      const allEvents = [...logs, ...network, ...contexts];
      const timeline = layer2Store.buildTimeline(allEvents, from, to);

      if (timeline.length === 0) {
        return {
          content: [{
            type: 'text',
            text: `No events found between ${new Date(from).toISOString()} and ${new Date(to).toISOString()}`,
          }],
        };
      }

      const lines: string[] = ['## Timeline'];
      lines.push('');
      lines.push(`**Period:** ${new Date(from).toISOString()} → ${new Date(to).toISOString()}`);
      lines.push(`**Total events:** ${timeline.length}`);
      lines.push('');

      let prevTs = from;
      for (const entry of timeline) {
        const delta = entry.timestamp - prevTs;
        lines.push(`**+${delta}ms** | ${new Date(entry.timestamp).toISOString()}`);
        lines.push(`  ${entry.summary}`);
        lines.push('');
        prevTs = entry.timestamp;
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  // ── Layer 3: set_breakpoint ───────────────────────────────────────────────────
  server.registerTool(
    'set_breakpoint',
    {
      description:
        '💰 PAID · Set a conditional breakpoint. When the condition matches, full state is captured. ' +
        'Example: "pause when status === 401" or "when error includes \'token\'". ' +
        'Enables surgical debugging without touching source code.',
      inputSchema: {
        condition: z.string().describe('Condition to evaluate (e.g., "status === 401")'),
        event_type: z.enum(['network', 'console', 'state']).describe('Event type to break on'),
        pattern: z.string().describe('Event pattern (URL, error message, etc.)'),
      },
    },
    async ({ condition, event_type, pattern }) => {
      const id = layer3Store.setBreakpoint(condition, event_type, pattern);

      return {
        content: [{
          type: 'text',
          text: `✅ Breakpoint set: ${id}\nCondition: ${condition}\nType: ${event_type}\nPattern: "${pattern}"`,
        }],
      };
    },
  );

  // ── Layer 3: inject_log ───────────────────────────────────────────────────────
  server.registerTool(
    'inject_log',
    {
      description:
        '💰 PAID · Inject a temporary console.log on a DOM element. ' +
        'The log captures one occurrence and auto-removes. ' +
        'Example: log button click event data without editing source.',
      inputSchema: {
        selector: z.string().describe('CSS selector (e.g., "#login-button")'),
        event: z.string().describe('DOM event name (e.g., "click", "input")'),
        expression: z.string().describe('JS expression to log (e.g., "event.target.value")'),
      },
    },
    async ({ selector, event, expression }) => {
      const id = layer3Store.injectLog(selector, event, expression);

      return {
        content: [{
          type: 'text',
          text: `✅ Log injected: ${id}\nSelector: ${selector}\nEvent: ${event}\nExpression: ${expression}\n\nWaiting for event to fire...`,
        }],
      };
    },
  );

  // ── Layer 3: mock_response ────────────────────────────────────────────────────
  server.registerTool(
    'mock_response',
    {
      description:
        '💰 PAID · Stub a network response to test a hypothesis. ' +
        'Example: "mock /api/user to return 401" to see if error handling works. ' +
        'Closes the loop between hypothesis and validation without changing code.',
      inputSchema: {
        url: z.string().describe('URL pattern to mock (supports wildcards: /api/*)'),
        method: z.string().describe('HTTP method (GET, POST, etc.)'),
        status: z.number().int().describe('HTTP status code'),
        body: z.unknown().describe('Response body (JSON or string)'),
      },
    },
    async ({ url, method, status, body }) => {
      const id = layer3Store.setMock(url, method, status, body);

      return {
        content: [{
          type: 'text',
          text: `✅ Mock registered: ${id}\n${method} ${url} → ${status}\n\nBody:\n\`\`\`json\n${JSON.stringify(body, null, 2)}\n\`\`\``,
        }],
      };
    },
  );

  // ── Layer 4: get_error_history ────────────────────────────────────────────────
  server.registerTool(
    'get_error_history',
    {
      description:
        'Search error history for similar past errors. Returns how many times seen, when, and what fixes worked. ' +
        'Use this FIRST when debugging: "have we seen this before?"',
      inputSchema: {
        query: z.string().describe('Error message or substring to search'),
        limit: z.number().int().min(1).max(50).optional().describe('Max results (default 10)'),
      },
    },
    async ({ query, limit = 10 }) => {
      const results = layer4Store.searchErrors(query, limit);

      if (results.length === 0) {
        return {
          content: [{
            type: 'text',
            text: `❌ No matching errors found for: "${query}"`,
          }],
        };
      }

      const lines: string[] = ['## Error History'];
      lines.push('');
      lines.push(`Found ${results.length} matching error(s):`);
      lines.push('');

      for (const entry of results) {
        lines.push(`### "${entry.message.slice(0, 100)}"`);
        lines.push(`- **Occurrences:** ${entry.count}×`);
        lines.push(`- **First seen:** ${new Date(entry.firstSeen).toISOString()}`);
        lines.push(`- **Last seen:** ${new Date(entry.lastSeen).toISOString()}`);

        if (entry.fixes.length > 0) {
          lines.push(`- **Fixes applied:** ${entry.fixes.length}`);
          for (const fix of entry.fixes.slice(0, 3)) {
            const verdict = fix.verdict === 'correct' ? '✅' : fix.verdict === 'partial' ? '⚠️' : '❌';
            lines.push(`  ${verdict} \`${fix.commitSha.slice(0, 7)}\` — ${fix.description.slice(0, 80)}`);
          }
        } else {
          lines.push(`- **Fixes:** None recorded yet`);
        }
        lines.push('');
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  // ── Layer 4: link_fix ─────────────────────────────────────────────────────────
  server.registerTool(
    'link_fix',
    {
      description:
        'Link a git commit to an error as the fix. Builds a corpus of error→fix pairs over time. ' +
        'Call this after pushing a fix: "link this error to commit abc123".',
      inputSchema: {
        error_query: z.string().describe('Error message to link'),
        commit_sha: z.string().describe('Git commit SHA'),
        description: z.string().describe('Brief description of the fix'),
        verdict: z.enum(['correct', 'partial', 'wrong']).optional().describe('How well this fix worked'),
      },
    },
    async ({ error_query, commit_sha, description, verdict = 'correct' }) => {
      // Find the error by message
      const results = layer4Store.searchErrors(error_query, 1);

      if (results.length === 0) {
        return {
          content: [{
            type: 'text',
            text: `❌ No error found matching: "${error_query}"\n\nThe error must be in the buffer first. Reproduce the error, then link the fix.`,
          }],
          isError: true,
        };
      }

      const error = results[0];
      const success = layer4Store.linkFix(error.fingerprint, commit_sha, description, verdict);

      if (!success) {
        return {
          content: [{
            type: 'text',
            text: `❌ Failed to link fix`,
          }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text',
          text: `✅ Fix linked to error\n\n**Error:** ${error.message.slice(0, 100)}\n**Commit:** ${commit_sha}\n**Description:** ${description}\n**Verdict:** ${verdict}`,
        }],
      };
    },
  );

  // ── Layer 4: error_stats ──────────────────────────────────────────────────────
  server.registerTool(
    'error_stats',
    {
      description:
        'Get statistics about the error history corpus: total unique errors, total fixes, coverage.',
    },
    async () => {
      const stats = layer4Store.getStats();
      const recentErrors = layer4Store.listErrors(10);

      const lines: string[] = ['## Error History Statistics'];
      lines.push('');
      lines.push(`- **Total unique errors:** ${stats.totalErrors}`);
      lines.push(`- **Total fixes recorded:** ${stats.totalFixes}`);
      lines.push(`- **Average fixes per error:** ${stats.avgFixesPerError.toFixed(2)}`);
      lines.push('');

      if (recentErrors.length > 0) {
        lines.push('### Recent errors:');
        lines.push('');
        for (const err of recentErrors) {
          const msg = err.message.slice(0, 80);
          lines.push(`- **${err.count}×** "${msg}" (last: ${new Date(err.lastSeen).toISOString()})`);
        }
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  // ── git suspect commit ────────────────────────────────────────────────────────
  server.registerTool(
    'get_suspect_commit',
    {
      description:
        'Identify the git commit most likely responsible for a runtime error by running ' +
        'git blame on the error\'s stack frame. Returns commit SHA, author, message, ' +
        'causal weight (feat/fix = high, chore/style = low), and any local uncommitted diff.',
      inputSchema: {
        file: z.string().describe('Workspace-relative file path from the stack trace'),
        line: z.number().int().describe('Line number from the stack trace'),
        cwd: z.string().optional().describe('Workspace root (defaults to process.cwd())'),
      },
    },
    async ({ file, line, cwd: cwdArg }) => {
      const { findSuspectCommit, getLocalDiff } = await import('../sensor/git-suspect.js');
      const cwd = cwdArg ?? process.cwd();
      const suspect = await findSuspectCommit(file, line, cwd);

      if (!suspect) {
        return {
          content: [{
            type: 'text',
            text: `No git blame data for ${file}:${line}. ` +
              'The file may be untracked, the line uncommitted, or git is unavailable.',
          }],
        };
      }

      const weightEmoji = { high: '🔴', medium: '🟡', low: '🟢' }[suspect.causalWeight];
      const lines: string[] = [
        `## Suspect Commit for \`${file}:${line}\``,
        '',
        `**SHA:** \`${suspect.shortSha}\` (${suspect.sha})`,
        `**Author:** ${suspect.author} <${suspect.authorEmail}>`,
        `**Date:** ${new Date(suspect.timestamp).toISOString()}`,
        `**Message:** ${suspect.summary}`,
        `**Causal weight:** ${weightEmoji} ${suspect.causalWeight.toUpperCase()}`,
        '',
      ];

      if (suspect.hasLocalDiff) {
        lines.push('⚠️ **This file has uncommitted local changes** — the bug may be in your working tree, not this commit.');
        if (suspect.localDiffStat) lines.push(`Changed: ${suspect.localDiffStat}`);
        lines.push('');
        const diff = await getLocalDiff(file, cwd);
        if (diff) {
          lines.push('```diff', diff.slice(0, 1500), '```');
        }
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );
}

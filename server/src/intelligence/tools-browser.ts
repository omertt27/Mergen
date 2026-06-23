import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { store, LogLevel } from '../sensor/buffer.js';
import { serviceTopology } from '../sensor/service-topology.js';
import { truncateToTokenBudget } from './token-budget.js';
import { getActivePlanId } from './license.js';
import { getPlan } from './plans.js';
import { trackCall } from './tools-state.js';
import logger from '../sensor/logger.js';

// Component tree shape as captured by the browser extension.
interface TreeNode {
  name: string;
  renderCount?: number;
  props?: Record<string, unknown>;
  state?: Record<string, unknown>;
  data?: Record<string, unknown>;
  hooks?: Array<{ index: number; value: string }>;
  children?: TreeNode[];
}

interface ComponentTreeCapture {
  framework: string;
  tree?: TreeNode;
}

export function registerBrowserTools(server: McpServer): void {
  // ── get_recent_logs ────────────────────────────────────────────────────────
  server.registerTool(
    'get_recent_logs',
    {
      description:
        'Retrieves runtime events from the event buffer — recent console events captured from the runtime. ' +
        'Default min_severity is WARN — console.log spam is filtered out automatically. ' +
        'Use exclude_patterns to suppress known noise (e.g. ["HMR", "\\[vite\\]", "\\[Fast Refresh\\]"]). ' +
        'Use this to drill into specific errors after get_unified_timeline has shown the cross-signal picture. ' +
        'Always lead response with: total errors, total warnings, most critical first.',
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional()
          .describe('Max events to return (default 50)'),
        level: z.enum(['error', 'warn', 'log']).optional()
          .describe('Filter by log level'),
        since: z.number().int().optional()
          .describe('Only return events after this Unix timestamp in ms'),
        min_severity: z.enum(['log', 'warn', 'error']).optional()
          .describe('Minimum severity level (default: warn). Filters out low-priority noise like console.log spam.'),
        exclude_patterns: z.array(z.string()).optional()
          .describe('Regex patterns to exclude, e.g. ["HMR", "webpack", "vite", "\\[Fast Refresh\\]"]. Case-insensitive.'),
        max_tokens: z.number().int().min(100).max(10000).optional()
          .describe('Soft token limit for response. Will truncate if exceeded.'),
      },
    },
    async ({ limit, level, since, min_severity, exclude_patterns, max_tokens }) => {
      let events = store.getLogs(limit ?? 50, level as LogLevel | undefined, since);

      const severityThreshold = min_severity || 'warn';
      const severityOrder = { log: 0, warn: 1, error: 2 };
      events = events.filter(e => severityOrder[e.level] >= severityOrder[severityThreshold]);

      if (exclude_patterns && exclude_patterns.length > 0) {
        try {
          const regexes = exclude_patterns.map(p => new RegExp(p, 'i'));
          events = events.filter(e => {
            const message = e.args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
            return !regexes.some(re => re.test(message));
          });
        } catch (err) {
          logger.warn({ err, exclude_patterns }, 'invalid regex in exclude_patterns');
        }
      }

      if (events.length === 0) {
        return { content: [{ type: 'text', text: 'No console events match filters.' }] };
      }

      const errors = events.filter((e) => e.level === 'error').length;
      const warns  = events.filter((e) => e.level === 'warn').length;
      const header =
        `Buffer: ${store.size()} total events. ` +
        `Showing ${events.length} — ${errors} error(s), ${warns} warning(s).\n\n`;

      const lines = events.map((e) => {
        const ts    = new Date(e.timestamp).toISOString();
        const args  = e.args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
        const stack = e.stack ? `\n  Stack: ${e.stack}` : '';
        const blame = e.gitSuspect
          ? `\n  Git:   ${e.gitSuspect.sha.slice(0, 7)} by ${e.gitSuspect.author} — "${e.gitSuspect.summary}"`
          : '';
        return `[${ts}] [${e.level.toUpperCase()}] ${args}${stack}${blame}`;
      });

      const { result, truncated, omitted, estimatedTokens } = truncateToTokenBudget(lines, max_tokens, '\n');
      if (truncated) logger.info({ tool: 'get_recent_logs', omitted, estimatedTokens }, 'response truncated');

      return { content: [{ type: 'text', text: header + result }] };
    },
  );

  // ── get_network_activity ───────────────────────────────────────────────────
  server.registerTool(
    'get_network_activity',
    {
      description:
        'Returns intercepted fetch/XHR events. ' +
        '404 = missing asset or API call; 500 = critical server error. ' +
        'Use max_tokens to control response size.',
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional()
          .describe('Max events to return (default 50)'),
        status_filter: z.number().int().optional()
          .describe('Filter to a specific HTTP status code (e.g. 404, 500)'),
        since: z.number().int().optional()
          .describe('Only return events after this Unix timestamp in ms'),
        max_tokens: z.number().int().min(100).max(10000).optional()
          .describe('Soft token limit for response. Will truncate if exceeded.'),
      },
    },
    async ({ limit, status_filter, since, max_tokens }) => {
      const events = store.getNetwork(limit ?? 50, status_filter, since);

      if (events.length === 0) {
        const msg = status_filter
          ? `No network events with status ${status_filter}.`
          : 'No network events in buffer.';
        return { content: [{ type: 'text', text: msg }] };
      }

      const lines = events.map((e) => {
        const ts         = new Date(e.timestamp).toISOString();
        const flag       = e.status >= 500 ? ' [CRITICAL]' : e.status >= 400 ? ' [ERROR]' : '';
        const body       = e.error
          ? ` | error: ${e.error}`
          : e.responseBody
            ? ` | response: ${JSON.stringify(e.responseBody).slice(0, 200)}`
            : '';
        const trace      = e.traceId    ? ` | trace: ${e.traceId}` : '';
        const tracestate = e.tracestate ? ` | tracestate: ${e.tracestate}` : '';
        const baggage    = e.baggage    ? ` | baggage: ${JSON.stringify(e.baggage)}` : '';
        const userId     = e.userId     ? ` | user: ${e.userId}` : '';
        return `[${ts}] ${e.method} ${e.url} → ${e.status} ${e.statusText} (${e.duration}ms)${flag}${body}${trace}${tracestate}${baggage}${userId}`;
      });

      const { result, truncated, omitted, estimatedTokens } = truncateToTokenBudget(lines, max_tokens, '\n');
      if (truncated) logger.info({ tool: 'get_network_activity', omitted, estimatedTokens }, 'response truncated');

      return { content: [{ type: 'text', text: result }] };
    },
  );

  // ── get_dom_context ────────────────────────────────────────────────────────
  server.registerTool(
    'get_dom_context',
    {
      description:
        'Returns DOM and storage snapshots captured at the exact millisecond of each console.error. ' +
        'Shows the page URL, title, focused element, React/Vue component, localStorage, and sessionStorage. ' +
        'Use this to understand what the user was doing and what state the app was in when an error fired. ' +
        'Use focused_element_only=true to minimize token usage.',
      inputSchema: {
        limit: z.number().int().min(1).max(50).optional()
          .describe('Max snapshots to return (default 10)'),
        since: z.number().int().optional()
          .describe('Only return snapshots after this Unix timestamp in ms'),
        focused_element_only: z.boolean().optional()
          .describe('If true, only return focused element and component (skip storage). Reduces token usage by ~80%.'),
        max_tokens: z.number().int().min(100).max(10000).optional()
          .describe('Soft token limit for response. Will truncate if exceeded.'),
      },
    },
    async ({ limit, since, focused_element_only, max_tokens }) => {
      const snapshots = store.getContext(limit ?? 10, since);

      if (snapshots.length === 0) {
        return { content: [{ type: 'text', text: 'No context snapshots yet. They are captured automatically on every console.error.' }] };
      }

      const lines = snapshots.map((s) => {
        const ts    = new Date(s.timestamp).toISOString();
        const parts: string[] = [
          `[${ts}] ${s.url}`,
          `  Page: ${s.title}`,
        ];

        if (s.activeElement) parts.push(`  Focused element: ${s.activeElement}`);
        if (s.component)     parts.push(`  Component: ${s.component}`);

        if (focused_element_only) return parts.join('\n');

        const { full: ls, changed: lsChanged } = store.getLocalStorageDiff(s.localStorage, s.url);
        const lsEntries = Object.entries(ls);
        if (lsEntries.length > 0) {
          const changedCount = lsChanged.size;
          const header = changedCount > 0
            ? `  localStorage (${lsEntries.length} keys, ${changedCount} changed):`
            : `  localStorage (${lsEntries.length} keys):`;
          parts.push(header);
          for (const [k, v] of lsEntries) {
            const badge = lsChanged.has(k) ? '🔄 ' : '   ';
            parts.push(`  ${badge}${k} = ${v}`);
          }
        }

        const ssEntries = Object.entries(s.sessionStorage);
        if (ssEntries.length > 0) {
          const showing = ssEntries.slice(0, 10);
          const header = ssEntries.length > 10
            ? `  sessionStorage (showing 10 of ${ssEntries.length}):`
            : `  sessionStorage (${ssEntries.length} keys):`;
          parts.push(header);
          for (const [k, v] of showing) {
            parts.push(`    ${k} = ${v}`);
          }
        }

        return parts.join('\n');
      });

      const { result, truncated, omitted, estimatedTokens } = truncateToTokenBudget(lines, max_tokens, '\n\n');
      if (truncated) logger.info({ tool: 'get_dom_context', omitted, estimatedTokens }, 'response truncated');

      return { content: [{ type: 'text', text: result }] };
    },
  );

  // ── get_websocket_activity ─────────────────────────────────────────────────
  server.registerTool(
    'get_websocket_activity',
    {
      description:
        'Returns WebSocket connection events with message frames. ' +
        'Use this to debug real-time features like chat, live dashboards, or multiplayer games. ' +
        'Shows connection status (open/closed/error), last sent/received frames, and connection duration.',
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional()
          .describe('Max connections to return (default 50)'),
        connection_url: z.string().optional()
          .describe('Filter by WebSocket URL (partial match, e.g. "wss://api.example.com")'),
        since: z.number().int().optional()
          .describe('Only return events after this Unix timestamp in ms'),
        max_tokens: z.number().int().min(100).max(10000).optional()
          .describe('Soft token limit for response. Will truncate if exceeded.'),
      },
    },
    async ({ limit, connection_url, since, max_tokens }) => {
      trackCall('get_websocket_activity');
      if (!getPlan(getActivePlanId()).websocketInspection) {
        return {
          content: [{
            type: 'text',
            text:
              `⛔ **WebSocket Inspection** is a Pro feature.\n\n` +
              `Upgrade to **Pro ($29/mo)** to inspect WebSocket connections and message frames.\n\n` +
              `→ https://mergen.dev/pricing`,
          }],
          isError: true,
        };
      }

      const events = store.getWebSockets(limit ?? 50, connection_url, since);

      if (events.length === 0) {
        const msg = connection_url
          ? `No WebSocket activity for URL containing "${connection_url}".`
          : 'No WebSocket activity in buffer.';
        return { content: [{ type: 'text', text: msg }] };
      }

      const lines = events.map((e) => {
        const ts    = new Date(e.timestamp).toISOString();
        const parts: string[] = [
          `[${ts}] WebSocket: ${e.url}`,
          `  Connection ID: ${e.connectionId}`,
          `  Status: ${e.status.toUpperCase()}`,
        ];

        if (e.code !== undefined) parts.push(`  Close code: ${e.code}`);
        if (e.reason)             parts.push(`  Close reason: ${e.reason}`);
        if (e.error)              parts.push(`  Error: ${e.error}`);

        if (e.frames && e.frames.length > 0) {
          parts.push(`  Frames captured: ${e.frames.length}`);
          parts.push(`  Recent frames:`);
          const recentFrames = e.frames.slice(-5);
          for (const frame of recentFrames) {
            const direction = frame.direction === 'sent' ? '→' : '←';
            const frameTs   = new Date(frame.timestamp).toISOString().split('T')[1].split('.')[0];
            parts.push(`    ${direction} [${frameTs}] ${frame.data}`);
          }
          if (e.frames.length > 5) parts.push(`    ... (${e.frames.length - 5} more frames)`);
        }

        return parts.join('\n');
      });

      const { result, truncated, omitted, estimatedTokens } = truncateToTokenBudget(lines, max_tokens, '\n\n');
      if (truncated) logger.info({ tool: 'get_websocket_activity', omitted, estimatedTokens }, 'response truncated');

      return { content: [{ type: 'text', text: result }] };
    },
  );

  // ── get_sse_activity ───────────────────────────────────────────────────────
  server.registerTool(
    'get_sse_activity',
    {
      description:
        'Returns Server-Sent Events (EventSource) activity. ' +
        'Use this to debug real-time server push features. ' +
        'Shows connection status and recent messages.',
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional()
          .describe('Max connections to return (default 50)'),
        connection_url: z.string().optional()
          .describe('Filter by SSE URL (partial match)'),
        since: z.number().int().optional()
          .describe('Only return events after this Unix timestamp in ms'),
        max_tokens: z.number().int().min(100).max(10000).optional()
          .describe('Soft token limit for response. Will truncate if exceeded.'),
      },
    },
    async ({ limit, connection_url, since, max_tokens }) => {
      trackCall('get_sse_activity');
      if (!getPlan(getActivePlanId()).websocketInspection) {
        return {
          content: [{
            type: 'text',
            text:
              `⛔ **SSE / EventSource Inspection** is a Pro feature.\n\n` +
              `Upgrade to **Pro ($29/mo)** to inspect Server-Sent Events streams.\n\n` +
              `→ https://mergen.dev/pricing`,
          }],
          isError: true,
        };
      }

      const events = store.getSSE(limit ?? 50, connection_url, since);

      if (events.length === 0) {
        const msg = connection_url
          ? `No SSE activity for URL containing "${connection_url}".`
          : 'No SSE activity in buffer.';
        return { content: [{ type: 'text', text: msg }] };
      }

      const lines = events.map((e) => {
        const ts    = new Date(e.timestamp).toISOString();
        const parts: string[] = [
          `[${ts}] SSE: ${e.url}`,
          `  Connection ID: ${e.connectionId}`,
          `  Status: ${e.status.toUpperCase()}`,
        ];

        if (e.messages && e.messages.length > 0) {
          parts.push(`  Messages received: ${e.messages.length}`);
          parts.push(`  Recent messages:`);
          const recentMessages = e.messages.slice(-5);
          for (const msg of recentMessages) {
            const msgTs = new Date(msg.timestamp).toISOString().split('T')[1].split('.')[0];
            parts.push(`    [${msgTs}] ${msg.data}`);
          }
          if (e.messages.length > 5) parts.push(`    ... (${e.messages.length - 5} more messages)`);
        }

        return parts.join('\n');
      });

      const { result, truncated, omitted, estimatedTokens } = truncateToTokenBudget(lines, max_tokens, '\n\n');
      if (truncated) logger.info({ tool: 'get_sse_activity', omitted, estimatedTokens }, 'response truncated');

      return { content: [{ type: 'text', text: result }] };
    },
  );

  // ── get_component_tree ─────────────────────────────────────────────────────
  server.registerTool(
    'get_component_tree',
    {
      description:
        '🌳 PRO · Returns React or Vue component tree with props, state, and hooks. ' +
        'Use this to debug "component not re-rendering", "props not updating", or "infinite render loop" issues. ' +
        'Shows component hierarchy, current prop/state values, and hook dependencies.',
      inputSchema: {
        component_name: z.string().optional()
          .describe('Optional: filter to a specific component name (e.g., "UserProfile", "LoginForm")'),
        max_depth: z.number().int().min(1).max(10).optional()
          .describe('Max tree depth to traverse (default: 5)'),
        since: z.number().int().optional()
          .describe('Only return component snapshots after this Unix timestamp in ms'),
        max_tokens: z.number().int().min(100).max(10000).optional()
          .describe('Soft token limit for response. Will truncate if exceeded.'),
      },
    },
    async ({ component_name, max_depth, since, max_tokens }) => {
      trackCall('get_component_tree');
      if (!getPlan(getActivePlanId()).componentTree) {
        return {
          content: [{
            type: 'text',
            text:
              `⛔ **Component Tree Inspection** is a Pro feature.\n\n` +
              `Upgrade to **Pro ($29/mo)** to inspect React and Vue component trees, props, state, and hooks.\n\n` +
              `→ https://mergen.dev/pricing`,
          }],
          isError: true,
        };
      }

      void component_name; // available for future filtering

      const contexts  = store.getContext(50, since);
      const withTrees = contexts.filter(c => c.componentTree);

      if (withTrees.length === 0) {
        return {
          content: [{
            type: 'text',
            text:
              'No component trees captured yet. Component trees are automatically captured on console.error events.\n\n' +
              'To manually capture, trigger an error in your app or wait for the next error to occur.',
          }],
        };
      }

      const depth = max_depth ?? 5;

      function formatReactNode(node: TreeNode, d: number): string[] {
        if (d > depth) return [];
        const indent = '  '.repeat(d);
        const out: string[] = [];
        const renderBadge = node.renderCount && node.renderCount > 0
          ? ` (renders: ${node.renderCount}${node.renderCount > 10 ? ' ⚠' : ''})`
          : '';
        out.push(`${indent}${node.name}${renderBadge}`);
        if (node.props && Object.keys(node.props).length > 0) {
          out.push(`${indent}  props:`);
          for (const [key, val] of Object.entries(node.props).slice(0, 5))
            out.push(`${indent}    ${key}: ${String(val).slice(0, 100)}`);
        }
        if (node.state && Object.keys(node.state).length > 0) {
          out.push(`${indent}  state:`);
          for (const [key, val] of Object.entries(node.state).slice(0, 5))
            out.push(`${indent}    ${key}: ${String(val).slice(0, 100)}`);
        }
        if (node.hooks && node.hooks.length > 0) {
          out.push(`${indent}  hooks:`);
          for (const hook of node.hooks.slice(0, 5))
            out.push(`${indent}    [${hook.index}]: ${hook.value.slice(0, 100)}`);
        }
        for (const child of node.children ?? []) out.push(...formatReactNode(child, d + 1));
        return out;
      }

      function formatVueNode(node: TreeNode, d: number): string[] {
        if (d > depth) return [];
        const indent = '  '.repeat(d);
        const out: string[] = [];
        out.push(`${indent}${node.name}`);
        if (node.props && Object.keys(node.props).length > 0) {
          out.push(`${indent}  props:`);
          for (const [key, val] of Object.entries(node.props).slice(0, 5))
            out.push(`${indent}    ${key}: ${String(val).slice(0, 100)}`);
        }
        const dataSource = node.state ?? node.data;
        if (dataSource && Object.keys(dataSource).length > 0) {
          out.push(`${indent}  ${node.state ? 'state' : 'data'}:`);
          for (const [key, val] of Object.entries(dataSource).slice(0, 5))
            out.push(`${indent}    ${key}: ${String(val).slice(0, 100)}`);
        }
        for (const child of node.children ?? []) out.push(...formatVueNode(child, d + 1));
        return out;
      }

      const lines: string[] = ['## 🌲 Component Tree', ''];

      for (const ctx of withTrees.slice(-3)) {
        const tree = ctx.componentTree as ComponentTreeCapture | undefined;
        if (!tree) continue;

        lines.push(`**Captured at:** ${new Date(ctx.timestamp).toISOString()}`);
        lines.push(`**Framework:** ${tree.framework}`);
        lines.push(`**URL:** ${ctx.url}`);
        lines.push('');

        if (tree.framework === 'React' && tree.tree) {
          lines.push('```');
          lines.push(...formatReactNode(tree.tree, 0));
          lines.push('```');
        }

        if ((tree.framework === 'Vue' || tree.framework === 'Vue3') && tree.tree) {
          lines.push('```');
          lines.push(...formatVueNode(tree.tree, 0));
          lines.push('```');
        }

        lines.push('');
      }

      lines.push('---');
      lines.push('**Debug hints:**');
      lines.push('- `renders: N ⚠` means this component type committed >10 times — check for missing deps in useEffect/useMemo');
      lines.push('- Missing props? Check parent component\'s render method');
      lines.push('- State not updating? Verify setState/dispatch calls');

      const { result, truncated, omitted, estimatedTokens } = truncateToTokenBudget(lines, max_tokens, '\n');
      if (truncated) logger.info({ tool: 'get_component_tree', omitted, estimatedTokens }, 'response truncated');
      return { content: [{ type: 'text', text: result }] };
    },
  );

  // ── get_service_topology ───────────────────────────────────────────────────
  server.registerTool(
    'get_service_topology',
    {
      description:
        '⚡ FREE · Returns the persistent service dependency graph as structured JSON — ' +
        'every service Mergen has observed (browser, API, database, queue, cache, infra), ' +
        'their dependencies, call counts, error rates, and p99 latencies. ' +
        'Built incrementally from backend spans and W3C trace joins. Survives server restarts. ' +
        'Use this to understand system structure before diagnosing an incident: ' +
        '"what services exist?", "what calls what?", "which service has the most errors?". ' +
        'Returns empty graph if no backend spans have been received yet — ' +
        'install the Node.js or Python SDK to start populating it.',
    },
    async () => {
      trackCall('get_service_topology');
      const snap = serviceTopology.snapshot();

      if (snap.nodes.length === 0) {
        return {
          content: [{
            type: 'text',
            text: [
              '## Service Topology\n',
              '> No services observed yet. The topology is built from backend spans.',
              '> Install the Mergen SDK in your backend services to start populating it:',
              '> - Node.js: `npm install @mergen/node`',
              '> - Python: `pip install mergen`',
              '',
              'Browser-side network events are already captured.',
              'Service-to-service edges appear once backend spans arrive.',
            ].join('\n'),
          }],
        };
      }

      const lines: string[] = ['## Service Topology\n'];

      lines.push(`**${snap.summary.totalServices} services · ${snap.summary.totalEdges} edges**\n`);

      if (snap.summary.criticalPath.length > 0) {
        lines.push(`**Critical path:** ${snap.summary.criticalPath.join(' → ')}\n`);
      }
      if (snap.summary.errorHotspot) {
        lines.push(`**Error hotspot:** \`${snap.summary.errorHotspot}\``);
      }
      if (snap.summary.slowestEdge) {
        const e = snap.summary.slowestEdge;
        lines.push(`**Slowest edge:** \`${e.from} → ${e.to}\` (${e.avgDurationMs}ms avg)\n`);
      }

      lines.push('### Services\n');
      lines.push('| Service | Type | Calls | Errors | Avg ms | p99 ms |');
      lines.push('|---------|------|-------|--------|--------|--------|');
      for (const n of snap.nodes.sort((a, b) => b.spanCount - a.spanCount)) {
        const errPct = n.spanCount > 0 ? ((n.errorCount / n.spanCount) * 100).toFixed(1) : '0.0';
        const errCell = n.errorCount > 0 ? `${n.errorCount} (${errPct}%)` : '0';
        lines.push(`| \`${n.id}\` | ${n.type} | ${n.spanCount} | ${errCell} | ${n.avgDurationMs} | ${n.p99DurationMs} |`);
      }

      lines.push('\n### Dependencies\n');
      for (const e of snap.edges.sort((a, b) => b.callCount - a.callCount)) {
        const errInfo = e.errorCount > 0 ? ` · ⚠️ ${e.errorCount} errors` : '';
        lines.push(`- \`${e.from}\` → \`${e.to}\` (${e.callCount} calls · ${e.avgDurationMs}ms avg${errInfo})`);
      }

      lines.push('\n---');
      lines.push(`*Updated: ${snap.capturedAt} · Raw JSON: GET /topology*`);

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );
}

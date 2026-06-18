/**
 * tools-discovery.ts — Phase 0 repository discovery tool.
 *
 * Before writing code, an AI agent should call discover_repo_context to map:
 *   - Existing patterns and conventions (tool structure, route factory pattern)
 *   - Domain vocabulary (type names from buffer-schemas, tool names)
 *   - Reusable utilities (which modules to check before writing a duplicate)
 *   - Testing conventions (framework, file layout, coverage floors)
 *   - All registered MCP tools and REST routes
 *
 * This tool is read-only. It never modifies any file or state.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ALL_TOOLS } from './tool-manifest.js';
import { trackCall } from './tools-state.js';
import { store } from '../sensor/buffer.js';

export function registerDiscoveryTools(server: McpServer): void {
  server.registerTool(
    'discover_repo_context',
    {
      description:
        'Phase 0 repository exploration — call this BEFORE writing any code. ' +
        'Returns: domain vocabulary, existing patterns, reusable utilities, testing conventions, ' +
        'and all registered MCP tools and REST routes. Read-only; makes no changes. ' +
        'Use the returned context to avoid duplicating logic that already exists.',
      inputSchema: {
        focus: z.enum(['all', 'tools', 'routes', 'types', 'testing', 'utilities'])
          .optional()
          .describe('Narrow the report to a specific area (default: all)'),
      },
    },
    async ({ focus = 'all' }) => {
      trackCall('discover_repo_context');

      const sections: string[] = ['## Repository Discovery Report (Phase 0)', ''];

      // ── MCP Tools ─────────────────────────────────────────────────────────────
      if (focus === 'all' || focus === 'tools') {
        const byModule = new Map<string, typeof ALL_TOOLS[number][]>();
        for (const t of ALL_TOOLS) {
          const group = byModule.get(t.module) ?? [];
          group.push(t);
          byModule.set(t.module, group);
        }

        sections.push('### Registered MCP Tools', '');
        sections.push('Before adding a new tool, verify no existing tool already covers your need.', '');
        for (const [mod, tools] of byModule) {
          sections.push(`**${mod}**`);
          for (const t of tools) {
            sections.push(`  - \`${t.name}\` (tier: ${t.tier})`);
          }
        }
        sections.push('');
        sections.push(
          `**Pattern:** Register in \`intelligence/tool-manifest.ts\` + \`intelligence/tools-state.ts\` (KNOWN_TOOLS). ` +
          `Implement in \`intelligence/tools-<module>.ts\`. Export a \`registerXxxTools(server)\` function.`,
          '',
        );
      }

      // ── REST Routes ───────────────────────────────────────────────────────────
      if (focus === 'all' || focus === 'routes') {
        sections.push('### REST Route Conventions', '');
        sections.push(
          'Each route module exports a **factory function** (e.g. `createIncidentsRouter(): Router`).',
          'The factory is imported in `app.ts` and mounted with `app.use(createXxxRouter())`.',
          'Zod validates all request bodies. Return `{ ok: true, ... }` on success, `{ error: string }` on failure.',
          '',
          '**Existing route modules** (check before adding a new one):',
          '`sensor`, `incidents`, `pagerduty`, `github-webhook`, `ci`, `sessions`, `postmortem`,',
          '`calibration`, `dashboard`, `impact-report`, `shadow-report`, `rbac`, `overrides`,',
          '`validate`, `license`, `api-keys`, `setup-ui`, `explain-why`, `war-room`,',
          '`slack-routing`, `heartbeats`, `habituation`, `active-authors`, `agent-blunders`,',
          '`telemetry`, `demo`, `sentry`, `otel`, `otlp-receiver`, `layers`, `billing-outcome`,',
          '`tickets`, `incident-webhook`, `sdk`, `adr`, `confidence`',
          '',
        );
      }

      // ── Domain Types ──────────────────────────────────────────────────────────
      if (focus === 'all' || focus === 'types') {
        sections.push('### Domain Vocabulary (canonical type names)', '');
        sections.push(
          'Use these names exactly. Never use generic alternatives like `data`, `item`, `payload`.',
          '',
          '**Event types** (from `sensor/buffer-schemas.ts`):',
          '`ConsoleEvent`, `NetworkEvent`, `ContextSnapshot`, `WebSocketEvent`, `SSEEvent`,',
          '`DiagnosticEvent`, `TerminalOutputEvent`, `TestResultEvent`, `ProcessExitEvent`,',
          '`CIEvent`, `DeploymentEvent`, `BackendSpanEvent`, `BrowserEvent`',
          '',
          '**Core concepts**:',
          '`ToolEntry`, `ToolTier` (free|pro|all), `AdrRecord`, `ConfidenceReport`,',
          '`RollbackStrategy`, `RollbackPlan`, `BlastRadiusReport`, `SessionSignal`',
          '',
          '**Key identifiers**: `pid` (hypothesis ID), `sessionId`, `traceId`, `spanId`, `buildSha`',
          '',
        );
      }

      // ── Testing Conventions ────────────────────────────────────────────────────
      if (focus === 'all' || focus === 'testing') {
        sections.push('### Testing Conventions', '');
        sections.push(
          '**Framework:** Vitest (`vitest run`)',
          '**Test location:** Colocate `.test.ts` next to the implementation file, OR place in `src/__tests__/`.',
          '**Coverage floors:** lines 80%, functions 80%, branches 75%.',
          '**Import style:** use `.js` extension even for `.ts` source files (Node16 module resolution).',
          '',
          '**Required:** After adding an MCP tool, run `tool-manifest.test.ts` to verify consistency.',
          '',
          '**Mocking pattern:**',
          '```typescript',
          'vi.mock(\'../intelligence/license.js\', async (importOriginal) => {',
          '  const actual = await importOriginal() as Record<string, unknown>;',
          '  return { ...actual, getActivePlanId: vi.fn(() => \'free\') };',
          '});',
          '```',
          '',
          '**Arrange-Act-Assert structure** is expected in all test cases.',
          '',
        );
      }

      // ── Reusable Utilities ────────────────────────────────────────────────────
      if (focus === 'all' || focus === 'utilities') {
        sections.push('### Reusable Utilities (check before writing a duplicate)', '');
        sections.push(
          '| Utility | Path | Purpose |',
          '|---------|------|---------|',
          '| `store` | `sensor/buffer.ts` | Ring buffer: getLogs, getNetwork, getContext, getSignals, push, clear |',
          '| `trackCall(tool)` | `intelligence/tools-state.ts` | Increment MCP tool call counter |',
          '| `withTierGate(tier, handler)` | `intelligence/tools-state.ts` | Enforce plan-tier access on a tool handler |',
          '| `getTierForTool(name)` | `intelligence/tool-manifest.ts` | Lookup a tool\'s tier from the manifest |',
          '| `adrStore` | `sensor/adr-store.ts` | List/get/add Architectural Decision Records |',
          '| `incidentStore` | `sensor/incident-store.ts` | CRUD for open/acknowledged/resolved incidents |',
          '| `logger` | `sensor/logger.ts` | Pino logger — use instead of console.log |',
          '| `DATA_DIR`, `zeroRetentionMode()` | `sensor/paths.ts` | File paths and zero-retention guard |',
          '| `executeRemediation(cmd)` | `intelligence/autonomy.ts` | Safe command execution (blocklist, audit, RBAC) |',
          '| `deriveRollback(cmd)` | `intelligence/rollback.ts` | Derive inverse command for rollback |',
          '| `generateRollbackPlan(intent)` | `intelligence/rollback.ts` | Pre-implementation rollback plan |',
          '',
        );
      }

      sections.push('---');
      sections.push('*This report is generated from live server state. Re-run after adding tools or routes.*');

      return { content: [{ type: 'text', text: sections.join('\n') }] };
    },
  );

  // ── get_buffer_schema ────────────────────────────────────────────────────────
  // @ts-ignore — TS2589
  server.registerTool(
    'get_buffer_schema',
    {
      description:
        'Inspect the live event buffer without reading raw events — returns a structural summary: ' +
        'event types present, log levels, URL patterns, detected services, error patterns, and time range. ' +
        'Free to call; no credits consumed. ' +
        'Use this before `analyze_runtime` to understand what telemetry is available and ' +
        'calibrate how much context to request.',
      inputSchema: {
        include_samples: z.boolean().optional()
          .describe('Include one sample message per error pattern (default: false).'),
      },
    },
    async ({ include_samples = false }) => {
      trackCall('get_buffer_schema');

      const logs    = store.getLogs(500);
      const network = store.getNetwork(500);
      const ctx     = store.getContext(20);
      const terminal = store.getTerminalOutput(100);
      const ci      = store.getCIEvents(20);
      const deploys = store.getDeployments(20);

      const eventTypes: Record<string, number> = {};
      if (logs.length)     eventTypes['console']  = logs.length;
      if (network.length)  eventTypes['network']  = network.length;
      if (ctx.length)      eventTypes['context']  = ctx.length;
      if (terminal.length) eventTypes['terminal'] = terminal.length;
      if (ci.length)       eventTypes['ci']       = ci.length;
      if (deploys.length)  eventTypes['deploy']   = deploys.length;

      const totalEvents = Object.values(eventTypes).reduce((a, b) => a + b, 0);

      // Log levels
      const levelCounts: Record<string, number> = {};
      for (const l of logs) {
        const lv = l.level ?? 'log';
        levelCounts[lv] = (levelCounts[lv] ?? 0) + 1;
      }

      // URL patterns (deduplicated path prefixes)
      const urlPatterns = new Set<string>();
      for (const n of network) {
        try {
          const u = new URL(n.url ?? '');
          const parts = u.pathname.split('/').filter(Boolean);
          urlPatterns.add('/' + (parts.slice(0, 2).join('/') || ''));
        } catch { /* non-URL */ }
      }

      // Services detected from console context
      const services = new Set<string>();
      for (const c of ctx) {
        if ((c as any).service) services.add((c as any).service);
      }
      for (const l of logs) {
        const m = String(l.args?.[0] ?? '').match(/^\[([a-z0-9_-]{2,24})\]/i);
        if (m) services.add(m[1].toLowerCase());
      }

      // Error patterns
      const errorMsgs = logs.filter((l) => l.level === 'error').map((l) => String(l.args?.[0] ?? ''));
      const errorPatternMap = new Map<string, string>();
      for (const msg of errorMsgs) {
        const pat = msg.replace(/\d{3,}/g, 'N').replace(/"[^"]{0,40}"/g, '"…"').slice(0, 80);
        if (!errorPatternMap.has(pat)) errorPatternMap.set(pat, msg);
      }
      const errorPatterns = [...errorPatternMap.keys()].slice(0, 10);

      // Time range
      const allTs = [
        ...logs.map((l) => l.timestamp),
        ...network.map((n) => n.timestamp),
      ].filter(Boolean) as number[];
      const minTs = allTs.length ? Math.min(...allTs) : null;
      const maxTs = allTs.length ? Math.max(...allTs) : null;

      // Network status distribution
      const statusBuckets: Record<string, number> = {};
      for (const n of network) {
        const s = n.status ?? 0;
        const bucket = s >= 500 ? '5xx' : s >= 400 ? '4xx' : s >= 300 ? '3xx' : s >= 200 ? '2xx' : 'other';
        statusBuckets[bucket] = (statusBuckets[bucket] ?? 0) + 1;
      }

      const lines = [
        '## Buffer Schema',
        '',
        `**Total events:** ${totalEvents}`,
        '',
        '### Event Types',
        ...Object.entries(eventTypes).map(([k, v]) => `- \`${k}\`: ${v} events`),
        '',
        '### Log Levels',
        Object.keys(levelCounts).length > 0
          ? Object.entries(levelCounts).map(([k, v]) => `- \`${k}\`: ${v}`).join('\n')
          : '_No console events_',
        '',
        '### Network Status Distribution',
        Object.keys(statusBuckets).length > 0
          ? Object.entries(statusBuckets).map(([k, v]) => `- \`${k}\`: ${v}`).join('\n')
          : '_No network events_',
        '',
        '### URL Patterns (top path prefixes)',
        [...urlPatterns].length > 0
          ? [...urlPatterns].slice(0, 15).map((u) => `- \`${u}\``).join('\n')
          : '_No network events_',
        '',
        '### Detected Services',
        [...services].length > 0
          ? [...services].slice(0, 10).map((s) => `- \`${s}\``).join('\n')
          : '_No service identifiers detected_',
        '',
        '### Error Patterns',
        errorPatterns.length > 0
          ? errorPatterns.map((p, i) => {
              const sample = include_samples ? `\n  _Sample: ${errorPatternMap.get(p)?.slice(0, 100)}_` : '';
              return `${i + 1}. \`${p}\`${sample}`;
            }).join('\n')
          : '_No errors in buffer_',
        '',
        '### Time Range',
        minTs && maxTs
          ? `- Oldest: ${new Date(minTs).toISOString()}\n- Newest: ${new Date(maxTs).toISOString()}\n- Span: ${Math.round((maxTs - minTs) / 1000)}s`
          : '_No timestamped events_',
        '',
        '---',
        '_Call `analyze_runtime` to run full causal analysis, or `get_recent_logs` to read raw events._',
      ];

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );
}

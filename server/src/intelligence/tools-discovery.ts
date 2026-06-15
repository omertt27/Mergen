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
}

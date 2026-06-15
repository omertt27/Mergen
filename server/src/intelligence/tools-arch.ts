/**
 * tools-arch.ts — Architectural governance MCP tools.
 *
 *   check_arch_violations   — find import boundary violations in modified files
 *   score_change_risk       — compute a 0–100 risk score before editing
 *   query_arch_graph        — traverse the import dependency graph
 *   critique_implementation — post-implementation rule-based critic
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import path from 'path';
import { trackCall } from './tools-state.js';
import { checkBoundaries, formatBoundaryReport } from './arch-boundaries.js';
import { scoreChangeRisk, formatRiskReport } from './change-risk.js';
import { buildGraph, queryGraph, invalidateGraph, ZONE_DISPLAY } from './arch-graph.js';
import { critiqueImplementation, formatCritiqueReport } from './impl-critic.js';

/**
 * Resolve srcDir: if not provided, use the `server/src` directory relative to
 * the running process. Works whether invoked from the `server/` directory or
 * the repo root.
 */
function defaultSrcDir(): string {
  const cwd = process.cwd();
  const candidates = [
    path.resolve(cwd, 'src'),
    path.resolve(cwd, 'server/src'),
    path.resolve(cwd, '../src'),
  ];
  const { existsSync } = require('fs');
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return path.resolve(cwd, 'src');
}

export function registerArchTools(server: McpServer): void {

  // ── check_arch_violations ───────────────────────────────────────────────────
  server.registerTool(
    'check_arch_violations',
    {
      description:
        'Scan source files for architectural boundary violations — e.g. sensor/* importing from routes/*. ' +
        'Run this BEFORE and AFTER any code change. Returns a list of violations with file, zone, and rationale. ' +
        'All violations are errors that must be resolved before merging. ' +
        'Default rules: sensor cannot import routes or intelligence; intelligence cannot import routes; ' +
        'datadog cannot import routes or intelligence.',
      inputSchema: {
        files: z.array(z.string()).optional()
          .describe('Specific files to check (absolute paths). Omit to scan the full source tree.'),
        srcDir: z.string().optional()
          .describe('Root of the TypeScript source directory. Defaults to ./src or server/src.'),
      },
    },
    async ({ files, srcDir }) => {
      trackCall('check_arch_violations');
      const dir = srcDir ?? defaultSrcDir();
      const result = checkBoundaries({
        srcDir: dir,
        singleFile: files?.length === 1 ? files[0] : undefined,
      });
      return { content: [{ type: 'text', text: formatBoundaryReport(result, dir) }] };
    },
  );

  // ── score_change_risk ───────────────────────────────────────────────────────
  server.registerTool(
    'score_change_risk',
    {
      description:
        'Compute a change risk score (0–100) for a proposed edit before making it. ' +
        'Factors: files touched, subsystems crossed, public API exposure, test blast radius, untested files, critical entry points. ' +
        'Score ≥ 70 → HIGH RISK, requires human approval. ' +
        'Score 40–69 → MEDIUM, file a confidence report and rollback plan first. ' +
        'Score < 40 → LOW, safe to proceed. ' +
        'Call this as part of Phase 0 discovery alongside discover_repo_context and report_confidence.',
      inputSchema: {
        files: z.array(z.string()).min(1)
          .describe('Files you plan to modify (absolute or relative paths from srcDir)'),
        srcDir: z.string().optional()
          .describe('Root of the TypeScript source directory. Defaults to ./src or server/src.'),
      },
    },
    async ({ files, srcDir }) => {
      trackCall('score_change_risk');
      const dir = srcDir ?? defaultSrcDir();
      const absoluteFiles = files.map((f) => path.isAbsolute(f) ? f : path.resolve(dir, f));
      const report = scoreChangeRisk(absoluteFiles, dir);
      return { content: [{ type: 'text', text: formatRiskReport(report) }] };
    },
  );

  // ── query_arch_graph ────────────────────────────────────────────────────────
  server.registerTool(
    'query_arch_graph',
    {
      description:
        'Traverse the architectural dependency graph of the codebase. ' +
        'Ask "what depends on rollback.ts?" to find all files that would break if rollback.ts changes. ' +
        'Ask "what does routes/incidents.ts depend on?" to understand its dependencies before refactoring. ' +
        'Also returns a zone-level summary of which architectural layers are involved.',
      inputSchema: {
        file: z.string()
          .describe('File to query (filename, relative path, or absolute path)'),
        direction: z.enum(['depends-on', 'depended-by'])
          .describe('"depends-on": what does this file import? "depended-by": what imports this file?'),
        maxDepth: z.number().int().min(1).max(6).optional()
          .describe('Traversal depth (default 3). Higher values find more transitive dependents.'),
        srcDir: z.string().optional()
          .describe('Root of the TypeScript source directory. Defaults to ./src or server/src.'),
      },
    },
    async ({ file, direction, maxDepth = 3, srcDir }) => {
      trackCall('query_arch_graph');
      const dir = srcDir ?? defaultSrcDir();
      const graph = buildGraph(dir);

      // Resolve the file — accept basename, relative, or absolute
      let resolvedFile: string | undefined;
      if (path.isAbsolute(file) && graph.forward.has(file)) {
        resolvedFile = file;
      } else {
        resolvedFile = graph.files.find(
          (f) => f.endsWith(`/${file}`) || f.endsWith(`/${file}.ts`) || path.basename(f) === file || path.basename(f) === `${file}.ts`,
        );
      }

      if (!resolvedFile) {
        const similar = graph.files
          .filter((f) => path.basename(f).toLowerCase().includes(path.basename(file).toLowerCase().replace('.ts', '')))
          .slice(0, 5)
          .map((f) => path.relative(dir, f));
        return {
          content: [{
            type: 'text',
            text: `File not found in graph: \`${file}\`\n\nDid you mean one of these?\n${similar.map((s) => `  - ${s}`).join('\n') || '  (no similar files found)'}`,
          }],
        };
      }

      const result = queryGraph(graph, { file: resolvedFile, direction, maxDepth });
      const relFile = path.relative(dir, resolvedFile);

      const { getZone, ZONE_DISPLAY: ZD } = await import('./arch-graph.js');
      const lines: string[] = [
        `## Dependency Graph: \`${relFile}\``,
        '',
        `**Direction:** ${direction}  |  **Depth:** ${maxDepth}`,
        '',
      ];

      if (result.direct.length === 0) {
        lines.push(`No direct ${direction === 'depends-on' ? 'imports' : 'importers'} found.`);
      } else {
        lines.push(`### Direct (${result.direct.length})`);
        for (const f of result.direct) {
          lines.push(`  - \`${path.relative(dir, f)}\` _(${getZone(f)})_`);
        }
        lines.push('');

        if (result.transitive.length > 0) {
          lines.push(`### Transitive up to depth ${maxDepth} (${result.transitive.length})`);
          for (const f of result.transitive) {
            lines.push(`  - \`${path.relative(dir, f)}\` _(${getZone(f)})_`);
          }
          lines.push('');
        }

        // Zone summary
        const allDeps = [...result.direct, ...result.transitive];
        const zoneCount = new Map<string, number>();
        for (const f of allDeps) {
          const z = getZone(f);
          zoneCount.set(z, (zoneCount.get(z) ?? 0) + 1);
        }
        lines.push('### By architectural zone');
        for (const [zone, count] of zoneCount) {
          lines.push(`  - **${ZD[zone as keyof typeof ZD] ?? zone}**: ${count} file(s)`);
        }
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  // ── critique_implementation ─────────────────────────────────────────────────
  server.registerTool(
    'critique_implementation',
    {
      description:
        'Post-implementation critic — run this after writing or modifying code. ' +
        'Checks for: architectural boundary violations, ADR violations, security anti-patterns ' +
        '(empty catch, eval, XSS, command injection), hard-coded return values, and missing workflow steps ' +
        '(confidence report). Errors must be resolved before merging; warnings should be addressed. ' +
        'This is the "senior staff engineer review" step in the structured agent workflow.',
      inputSchema: {
        files: z.array(z.string()).min(1)
          .describe('Files that were modified (absolute or relative paths from srcDir)'),
        srcDir: z.string().optional()
          .describe('Root of the TypeScript source directory. Defaults to ./src or server/src.'),
      },
    },
    async ({ files, srcDir }) => {
      trackCall('critique_implementation');
      const dir = srcDir ?? defaultSrcDir();
      const absoluteFiles = files.map((f) => path.isAbsolute(f) ? f : path.resolve(dir, f));

      // Invalidate the graph so it picks up newly written files
      invalidateGraph(dir);

      const report = critiqueImplementation({ files: absoluteFiles, srcDir: dir });
      return { content: [{ type: 'text', text: formatCritiqueReport(report) }] };
    },
  );
}

/**
 * tools-intent.ts — explain_why MCP tool.
 *
 * The Systemic Recall Interface (Pillar 3). Answers the question:
 * "Why does this service behave this way?" by retrieving the captured
 * PR intent context — the prompts, business reasoning, linked tickets,
 * and human approvers behind the commits that shaped the current state.
 *
 * Data source: commit_contexts table (populated by POST /webhooks/github).
 * No LLM calls — purely deterministic retrieval from the causal intent archive.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { commitContextStore } from '../sensor/commit-context-store.js';
import { trackCall } from './tools-state.js';
import { recordExplainWhy } from './usage.js';

export function registerIntentTools(server: McpServer): void {
  server.registerTool(
    'explain_why',
    {
      description:
        'Retrieves the causal intent behind a service\'s current behavior — the PR titles, ' +
        'business descriptions, linked tickets, and human approvers responsible for the code that ' +
        'exists today. Answers "Why does service X have a 30s timeout?" or "Who approved the retry logic?" ' +
        'without requiring the original author to be on-call. ' +
        'Data comes from the commit intent archive (GitHub PR webhooks). ' +
        'Returns nothing if no PRs have been captured yet — connect GitHub webhook to POST /webhooks/github first.',
      inputSchema: {
        service: z.string()
          .describe('Service or repo name to query (e.g. "api", "payments-worker", "org/repo").'),
        behavior: z.string().optional()
          .describe('Optional: specific behavior to explain (e.g. "30s timeout", "retry 3 times", "rate limit 100rps"). Filters results by relevance.'),
        limit: z.number().int().min(1).max(20).optional()
          .describe('Max PRs to return (default: 10).'),
      },
    },
    ({ service, behavior, limit = 10 }) => {
      trackCall('explain_why');
      recordExplainWhy();

      const contexts = commitContextStore.listByRepo(service, limit * 2);

      if (contexts.length === 0) {
        const total = commitContextStore.count();
        if (total === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: [
                `## Intent Archive: ${service}`,
                '',
                '**No PRs captured yet.** Connect GitHub to start building the intent archive:',
                '',
                '```',
                `mergen-server connect github --repo ${service.includes('/') ? service : `<org>/${service}`}`,
                '```',
                '',
                '_Takes 30 seconds. Every PR merged after this populates the archive automatically._',
                '_Next incident: ask "explain why this service has a 30s timeout" and get the original PR, author, and approver instantly._',
              ].join('\n'),
            }],
          };
        }
        return {
          content: [{
            type: 'text' as const,
            text: [
              `## Intent Archive: ${service}`,
              '',
              `_${total} total contexts in archive — none matched "${service}"._`,
              '',
              `Try the full repo name (e.g. \`org/${service}\`), or connect this repo:`,
              '',
              '```',
              `mergen-server connect github --repo <org>/${service}`,
              '```',
            ].join('\n'),
          }],
        };
      }

      // Filter by behavior keyword if provided
      let filtered = contexts;
      if (behavior) {
        const kw = behavior.toLowerCase();
        filtered = contexts.filter((c) => {
          const searchText = [c.prTitle, c.prBody, ...c.linkedIssues.map((i) => i.ref)]
            .join(' ').toLowerCase();
          return searchText.includes(kw);
        });
        // Fall back to all if no match
        if (filtered.length === 0) filtered = contexts;
      }

      const results = filtered.slice(0, limit);
      const aiCount = results.filter((c) => c.aiGenerated).length;
      const approvedCount = results.filter((c) => c.approvers.length > 0).length;

      const lines = [
        `## Intent Archive: ${service}`,
        `_${results.length} PR${results.length !== 1 ? 's' : ''} · ${aiCount} AI-generated · ${approvedCount} with recorded approvals_`,
        behavior ? `_Filtered by: "${behavior}"_` : '',
        '',
      ].filter(Boolean);

      for (const ctx of results) {
        const prRef = ctx.prNumber ? `PR #${ctx.prNumber}` : ctx.sha.slice(0, 7);
        const aiTag = ctx.aiGenerated ? ` 🤖 ${ctx.aiTool ?? 'AI-generated'}` : '';
        const dateStr = ctx.mergedAt
          ? new Date(ctx.mergedAt).toISOString().slice(0, 10)
          : new Date(ctx.capturedAt).toISOString().slice(0, 10);

        lines.push(`### ${prRef}${aiTag} — ${dateStr}`);
        if (ctx.prTitle) lines.push(`**${ctx.prTitle}**`);

        const meta: string[] = [];
        if (ctx.author) meta.push(`Author: @${ctx.author}`);
        if (ctx.approvers.length) meta.push(`Approved by: ${ctx.approvers.join(', ')}`);
        else meta.push('⚠️ No recorded approvers');
        if (ctx.branch) meta.push(`Branch: ${ctx.branch}`);
        lines.push(`_${meta.join(' · ')}_`);

        if (ctx.linkedIssues.length > 0) {
          lines.push(`**Linked issues:** ${ctx.linkedIssues.slice(0, 5).map((i) => i.ref).join(', ')}`);
        }

        if (ctx.prBody) {
          const summary = ctx.prBody
            .split('\n')
            .filter((l) => l.trim() && !l.startsWith('#'))
            .slice(0, 3)
            .join(' ')
            .slice(0, 400);
          if (summary) lines.push(`> ${summary}`);
        }

        if (ctx.filesChanged.length > 0) {
          const files = ctx.filesChanged.slice(0, 5).join(', ');
          const more = ctx.filesChanged.length > 5 ? ` +${ctx.filesChanged.length - 5} more` : '';
          lines.push(`_Files: ${files}${more}_`);
        }

        lines.push('');
      }

      lines.push('---');
      lines.push(`_Source: commit intent archive · ${commitContextStore.count()} total contexts captured_`);

      const feedbackId = `ew-${Date.now().toString(36)}`;
      lines.push('');
      lines.push(`_Was this helpful?  \`mergen-server feedback ${feedbackId} --yes\`  or  \`mergen-server feedback ${feedbackId} --no\`_`);

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      };
    },
  );
}

/**
 * tools-change-timeline.ts — get_change_timeline MCP tool.
 *
 * The "30-second context dump" the Operational Memory strategy promises.
 * Answers: "What changed in this service in the last N days?"
 *
 * Pulls from: CI events, deployment events, incident store, gitSuspect
 * data from recent errors. AI-generated commits are tagged.
 *
 * This is the first tool a triage agent should call when a PagerDuty
 * alert fires — before diagnosis, before hypothesis generation.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { store } from '../sensor/buffer.js';
import { incidentStore } from '../sensor/incident-store.js';
import { commitContextStore } from '../sensor/commit-context-store.js';
import { detectAiCommit } from './ai-commit.js';
import { trackCall } from './tools-state.js';

function fmtMs(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

function isoDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 16).replace('T', ' ');
}

export function registerChangeTimelineTools(server: McpServer): void {
  server.registerTool(
    'get_change_timeline',
    {
      description:
        'Returns a chronological change timeline for a service — the "what changed?" context dump ' +
        'before diagnosis begins. Pulls deployments, CI runs, incidents, and AI-generated commits ' +
        'from operational memory. AI-written commits are flagged so on-call engineers know which ' +
        'changes have no human author to ask. ' +
        'Call this first when a PagerDuty alert fires, before reconstruct_context or triage_incident.',
      inputSchema: {
        service: z.string().optional()
          .describe('Service name to filter (e.g. "api", "payments-worker"). Omit to get all services.'),
        days: z.number().int().min(1).max(30).optional()
          .describe('How many days back to look (default: 7).'),
      },
    },
    async ({ service, days = 7 }) => {
      trackCall('get_change_timeline');

      const windowMs = days * 24 * 60 * 60 * 1000;
      const since = Date.now() - windowMs;

      type TimelineEntry = {
        ts: number;
        kind: 'deploy' | 'ci' | 'incident' | 'ai_commit';
        label: string;
        aiGenerated?: boolean;
        aiTool?: string | null;
      };

      const entries: TimelineEntry[] = [];

      // ── CommitContext lookup (PR intent archive) ─────────────────────────────
      const ctxWindow = commitContextStore.listByWindow(since, Date.now(), service);
      const ctxBySha = new Map(ctxWindow.map((c) => [c.sha.slice(0, 7), c]));

      // ── Deployments ──────────────────────────────────────────────────────────
      const deploys = store.getDeployments(100, undefined, since);
      for (const d of deploys) {
        if (service && d.service && d.service !== service) continue;
        const statusIcon = d.status === 'success' ? '✅' : d.status === 'failure' ? '❌' : d.status === 'rollback' ? '⏪' : '▶';
        const svcLabel = d.service ? ` [${d.service}]` : '';
        const aiSignal = d.actor ? detectAiCommit(d.actor, d.actor) : { detected: false, tool: null };
        const ctx = ctxBySha.get(d.sha.slice(0, 7)) ?? commitContextStore.getBySha(d.sha);
        const prTag = ctx?.prNumber ? ` PR#${ctx.prNumber}` : '';
        const approverTag = ctx?.approvers.length ? ` ✓ ${ctx.approvers.join(', ')}` : '';
        entries.push({
          ts: d.timestamp,
          kind: 'deploy',
          label: `${statusIcon} Deploy${svcLabel} ${d.shortSha ?? d.sha.slice(0, 7)} → ${d.environment}${d.version ? ` v${d.version}` : ''}${d.actor ? ` by ${d.actor}` : ''}${prTag}${approverTag}`,
          aiGenerated: (aiSignal.detected || ctx?.aiGenerated) || undefined,
          aiTool: aiSignal.tool ?? ctx?.aiTool,
        });
      }

      // ── CI runs ──────────────────────────────────────────────────────────────
      const ciEvents = store.getCIEvents(100, undefined, since);
      for (const c of ciEvents) {
        const statusIcon = c.status === 'success' ? '✅' : c.status === 'failure' ? '❌' : '⏸';
        const branchLabel = c.branch ? ` (${c.branch})` : '';
        entries.push({
          ts: c.timestamp,
          kind: 'ci',
          label: `${statusIcon} CI ${c.provider.replace('_', ' ')} · ${c.job}${branchLabel} ${c.sha.slice(0, 7)}${c.status === 'failure' && c.failedTests?.length ? ` — ${c.failedTests.length} test(s) failed` : ''}`,
        });
      }

      // ── Past incidents ───────────────────────────────────────────────────────
      const incidents = incidentStore.list(undefined, 200).filter((i) => {
        if (i.createdAt < since) return false;
        if (service && i.service && i.service !== service) return false;
        return true;
      });
      for (const inc of incidents) {
        const statusIcon = inc.status === 'resolved' ? (inc.resolvedAutonomously ? '🤖' : '✅') : '🔴';
        const mttr = inc.resolvedAt ? ` MTTR: ${fmtMs(inc.resolvedAt - inc.createdAt)}` : '';
        const svcLabel = inc.service ? ` [${inc.service}]` : '';
        entries.push({
          ts: inc.createdAt,
          kind: 'incident',
          label: `${statusIcon} Incident${svcLabel} · ${inc.tag || 'unknown'} · conf ${Math.round(inc.confidence * 100)}%${mttr}`,
        });
      }

      // ── AI-generated commits from gitSuspect on recent errors ────────────────
      const errors = store.getLogs(200, 'error', since);
      const seenShas = new Set<string>();
      for (const e of errors) {
        const gs = e.gitSuspect;
        if (!gs || seenShas.has(gs.sha)) continue;
        if (service && e.url && !e.url.includes(service)) continue;
        const signal = gs.aiGenerated
          ? { detected: true, tool: null as string | null }
          : detectAiCommit(gs.summary, gs.author);
        if (signal.detected) {
          seenShas.add(gs.sha);
          entries.push({
            ts: e.timestamp,
            kind: 'ai_commit',
            label: `🤖 AI commit ${gs.sha.slice(0, 7)} — "${gs.summary.slice(0, 80)}" by ${gs.author}${signal.tool ? ` (${signal.tool})` : ''}`,
            aiGenerated: true,
            aiTool: signal.tool,
          });
        }
      }

      entries.sort((a, b) => a.ts - b.ts);

      if (entries.length === 0) {
        const corpusNote = incidentStore.list(undefined, 1).length === 0
          ? '\n\n_No incident history yet — trigger an incident or run `mergen-server demo` to seed the corpus._'
          : `\n\n_No events in the last ${days} day${days !== 1 ? 's' : ''}${service ? ` for service "${service}"` : ''}. Try a wider window._`;
        return {
          content: [{
            type: 'text' as const,
            text: `## Change Timeline${service ? ` — ${service}` : ''}\n\n_No changes recorded in the last ${days} day${days !== 1 ? 's' : ''}._ ${corpusNote}`,
          }],
        };
      }

      const aiCount = entries.filter((e) => e.aiGenerated).length;
      const incidentCount = entries.filter((e) => e.kind === 'incident').length;
      const deployCount = entries.filter((e) => e.kind === 'deploy').length;

      const header = [
        `## Change Timeline${service ? ` — ${service}` : ''} (last ${days} day${days !== 1 ? 's' : ''})`,
        '',
        `${deployCount} deploy${deployCount !== 1 ? 's' : ''} · ${incidentCount} incident${incidentCount !== 1 ? 's' : ''} · ${aiCount} AI-generated commit${aiCount !== 1 ? 's' : ''} flagged`,
        '',
      ];

      const rows = entries.map((e) => {
        const aiTag = e.aiGenerated ? ' ⚠️ AI' : '';
        return `- \`${isoDate(e.ts)}\` ${e.label}${aiTag}`;
      });

      const footer: string[] = [];
      if (aiCount > 0) {
        footer.push(
          '',
          `> ⚠️ **${aiCount} AI-generated commit${aiCount !== 1 ? 's' : ''} in this window.** These have no human author to consult during triage.`,
          `> Call \`reconstruct_context\` for causal analysis or \`explain_service(service: "${service ?? 'service-name'}")\` for failure mode history.`,
        );
      }

      // ── PR Intent section — show captured context for top entries ─────────
      const prEntries = ctxWindow.filter((c) => c.prTitle && c.prNumber).slice(0, 3);
      if (prEntries.length > 0) {
        footer.push('', '### PR Intent Archive');
        for (const c of prEntries) {
          const issueRefs = c.linkedIssues.slice(0, 3).map((i) => i.ref).join(', ');
          const approvers = c.approvers.length ? `Approved by: ${c.approvers.join(', ')}` : 'No recorded approvers';
          const aiTag = c.aiGenerated ? ` 🤖 ${c.aiTool ?? 'AI'}` : '';
          footer.push(
            `**PR #${c.prNumber}${aiTag}**: ${c.prTitle}`,
            `_Author: @${c.author ?? '?'} · ${approvers}${issueRefs ? ` · Refs: ${issueRefs}` : ''}_`,
            c.prBody ? `> ${c.prBody.split('\n').filter((l) => l.trim()).slice(0, 2).join(' ').slice(0, 200)}` : '',
            '',
          );
        }
      }

      return {
        content: [{
          type: 'text' as const,
          text: [...header, ...rows, ...footer].join('\n'),
        }],
      };
    },
  );
}

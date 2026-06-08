/**
 * tools-runbook.ts — Y2 runbook replacement + semantic postmortem search.
 *
 * generate_runbook:
 *   Synthesizes a self-updating runbook for a failure mode from the postmortem
 *   corpus via hybrid retrieval (FTS5 BM25 + TF-IDF cosine similarity, fused
 *   with Reciprocal Rank Fusion). Replaces static Confluence/Notion runbooks
 *   that decay within weeks of being written.
 *
 * search_postmortems:
 *   Direct semantic search over the corpus. Returns ranked postmortems with
 *   retrieval signal metadata (which signals matched, similarity scores).
 *   The technical answer to YC Q2: this is how we turn raw incident noise
 *   into high-signal, token-budget-aware summaries for the AI.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { postmortemStore } from './postmortem-store.js';
import { hybridSearch, tagToQuery } from './postmortem-retrieval.js';
import { trackCall } from './tools-state.js';
import { store } from '../sensor/buffer.js';

function fmtMs(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.round((ms % 60_000) / 1000);
  return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
}

export function registerRunbookTools(server: McpServer): void {

  // ── generate_runbook ────────────────────────────────────────────────────────
  server.registerTool(
    'generate_runbook',
    {
      description:
        'Generate a self-updating runbook for a failure mode from your incident corpus. ' +
        'Uses hybrid retrieval (FTS5 BM25 keyword search + TF-IDF embedding, fused via RRF) ' +
        'to find the most relevant past incidents. ' +
        'Synthesizes root cause patterns, verified fix commands, MTTR trends, and step-by-step procedure. ' +
        'Replaces static Confluence/Notion runbooks that decay within weeks. ' +
        'Pass a failure tag (e.g. "db_connection_pool_exhausted") or a free-text description. ' +
        'If no tag is provided, lists all failure modes with corpus coverage.',
      inputSchema: {
        tag: z.string().optional()
          .describe('Failure mode tag (e.g. "infra_db_connection_pool_exhausted"). If omitted, lists all available.'),
        query: z.string().optional()
          .describe('Free-text description to search for (e.g. "database connections timing out"). Used for hybrid retrieval if tag is not given.'),
        service: z.string().optional()
          .describe('Filter to a specific service name.'),
        limit: z.number().int().min(1).max(50).optional()
          .describe('Max postmortems to synthesize from (default: 10).'),
      },
    },
    async ({ tag, query, service, limit = 10 }) => {
      trackCall('generate_runbook');

      // No tag or query: return corpus coverage overview
      if (!tag && !query) {
        const stats = postmortemStore.tagStats();
        if (stats.length === 0) {
          return {
            content: [{
              type: 'text',
              text: [
                '## Runbook Corpus — Empty',
                '',
                'No postmortems have been written yet. The corpus grows automatically as incidents are resolved.',
                '',
                'To seed with 50 real-world incident postmortems run: `mergen-server demo`',
                'Or call `triage_incident` to begin building your own corpus.',
              ].join('\n'),
            }],
          };
        }

        const totalPms = stats.reduce((s, t) => s + t.count, 0);
        const lines = [
          '## Runbook Corpus — Coverage',
          '',
          `**${totalPms} postmortems** across **${stats.length} failure modes**`,
          '',
          '| Failure mode | Incidents | Avg MTTR | Last seen |',
          '|---|---|---|---|',
        ];
        for (const s of stats) {
          const displayTag = s.tag.replace(/^infra_/, '');
          const mttr = s.avgMttrMs != null ? fmtMs(s.avgMttrMs) : '—';
          const last = new Date(s.lastAt).toISOString().slice(0, 10);
          lines.push(`| \`${displayTag}\` | ${s.count} | ${mttr} | ${last} |`);
        }
        lines.push('', 'Call `generate_runbook(tag: "...")` or `generate_runbook(query: "...")` to synthesize a runbook.');
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      // Build search query: prefer explicit query, fall back to tag expansion
      const normalizedTag = tag
        ? (tag.startsWith('infra_') ? tag : `infra_${tag}`)
        : undefined;
      const searchQuery = query ?? (normalizedTag ? tagToQuery(normalizedTag) : '');

      // Hybrid retrieval: FTS5 + TF-IDF cosine similarity, fused via RRF
      const results = hybridSearch(searchQuery, {
        tag: normalizedTag,
        service,
        topK: limit,
      });

      // Fall back to exact-match if hybrid returns nothing (empty corpus for this tag)
      const postmortems = results.length > 0
        ? results.map((r) => r.postmortem)
        : (normalizedTag ? postmortemStore.getByTag(normalizedTag, limit) : []);

      if (postmortems.length === 0) {
        return {
          content: [{
            type: 'text',
            text: [
              `## Runbook — ${(normalizedTag ?? query ?? '').replace(/^infra_/, '')}`,
              '',
              'No postmortems found.',
              service ? `No resolved incidents for service \`${service}\` matching this query.` : '',
              '',
              'The runbook auto-generates once the first matching incident is resolved.',
            ].filter(Boolean).join('\n'),
          }],
        };
      }

      // ── Synthesis ──────────────────────────────────────────────────────────
      const displayTag = (normalizedTag ?? postmortems[0].tag).replace(/^infra_/, '');
      const totalCount = postmortems.length;
      const autonomousCount = postmortems.filter((pm) => pm.resolvedAutonomously).length;
      const mttrSamples = postmortems.filter((pm) => pm.mttrMs != null).map((pm) => pm.mttrMs!);
      const avgMttr = mttrSamples.length > 0
        ? mttrSamples.reduce((a, b) => a + b, 0) / mttrSamples.length
        : null;
      const minMttr = mttrSamples.length > 0 ? Math.min(...mttrSamples) : null;

      // Ranked fix commands
      const commandCounts = new Map<string, number>();
      for (const pm of postmortems) {
        if (pm.fixCommand) {
          commandCounts.set(pm.fixCommand, (commandCounts.get(pm.fixCommand) ?? 0) + 1);
        }
      }
      const topCommands = [...commandCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3);

      // Root causes (deduplicated by first sentence)
      const rootCauses = [...new Set(
        postmortems
          .map((pm) => pm.rootCause.split('.')[0].trim())
          .filter(Boolean),
      )].slice(0, 3);

      // Retrieval signal summary (shows which signals fired)
      const signalSummary = results.length > 0
        ? `_Retrieved via: ${[...new Set(results.flatMap((r) => r.signals))].join(' + ')} → RRF fusion_`
        : '';

      // Recent incidents table
      const recentRows = postmortems.slice(0, 5).map((pm) => {
        const date = new Date(pm.generatedAt).toISOString().slice(0, 10);
        const mttr = pm.mttrMs != null ? fmtMs(pm.mttrMs) : '—';
        const how = pm.resolvedAutonomously ? '🤖 auto' : '👤 manual';
        return `| ${date} | ${pm.service} | ${mttr} | ${how} |`;
      });

      const lines = [
        `# Runbook — ${displayTag}`,
        `_Auto-generated from ${totalCount} incident${totalCount !== 1 ? 's' : ''} · ${new Date(postmortems[0].generatedAt).toISOString().slice(0, 10)}_`,
        signalSummary,
        '',
        '## Summary',
        '',
        `- **${totalCount}** incidents in corpus`,
        avgMttr != null
          ? `- **Avg MTTR:** ${fmtMs(avgMttr)}${minMttr != null ? ` (best: ${fmtMs(minMttr)})` : ''}`
          : '',
        `- **Autonomous resolution rate:** ${Math.round((autonomousCount / totalCount) * 100)}%`,
        '',
        '## Root Causes',
        '',
        ...rootCauses.map((rc, i) => `${i + 1}. ${rc}`),
        '',
      ];

      if (topCommands.length > 0) {
        lines.push('## Verified Fix Commands', '');
        lines.push('_Ranked by frequency — these have resolved this failure mode before:_', '');
        for (const [cmd, cnt] of topCommands) {
          lines.push(`\`\`\`\n${cmd}\n\`\`\``);
          lines.push(`_Applied ${cnt} time${cnt !== 1 ? 's' : ''}_`, '');
        }
      }

      lines.push(
        '## Procedure',
        '',
        `1. Confirm failure: check logs for \`${displayTag}\` pattern`,
        '2. Run `triage_incident` to get current diagnosis',
        topCommands.length > 0
          ? `3. If confidence ≥ 85%: apply \`${topCommands[0][0]}\``
          : '3. Apply fix per root cause above',
        '4. Run `validate_fix` to confirm resolution',
        '5. Resolution automatically updates this runbook',
        '',
        '## Recent Incidents',
        '',
        '| Date | Service | MTTR | How |',
        '|---|---|---|---|',
        ...recentRows,
      );

      return { content: [{ type: 'text', text: lines.filter((l) => l !== undefined).join('\n') }] };
    },
  );

  // ── search_postmortems ──────────────────────────────────────────────────────
  server.registerTool(
    'search_postmortems',
    {
      description:
        'Semantic search over the postmortem corpus using hybrid retrieval ' +
        '(FTS5 BM25 + TF-IDF cosine similarity fused via Reciprocal Rank Fusion). ' +
        'Use this to find past incidents similar to the current one before triaging. ' +
        'Returns ranked postmortems with retrieval signal metadata. ' +
        'This is the "token tax" solution: instead of dumping raw logs into context, ' +
        'retrieve the 3-5 most relevant past incidents and include only those.',
      inputSchema: {
        query: z.string()
          .describe('Describe what you\'re looking for (e.g. "memory OOM kill in worker service", "rate limit cascade").'),
        service: z.string().optional()
          .describe('Restrict to a specific service.'),
        tag: z.string().optional()
          .describe('Restrict to a specific failure mode tag.'),
        limit: z.number().int().min(1).max(20).optional()
          .describe('Number of results to return (default: 5).'),
      },
    },
    async ({ query, service, tag, limit = 5 }) => {
      trackCall('search_postmortems');

      const normalizedTag = tag
        ? (tag.startsWith('infra_') ? tag : `infra_${tag}`)
        : undefined;

      const results = hybridSearch(query, {
        tag: normalizedTag,
        service,
        topK: limit,
      });

      if (results.length === 0) {
        const totalInCorpus = postmortemStore.count();
        return {
          content: [{
            type: 'text',
            text: totalInCorpus === 0
              ? '## No results\n\nCorpus is empty. Resolve an incident with `triage_incident` to start building the corpus.'
              : `## No results for "${query}"\n\nCorpus has ${totalInCorpus} postmortem${totalInCorpus !== 1 ? 's' : ''} but none matched. Try a broader query.`,
          }],
        };
      }

      const lines = [
        `## Postmortem Search — "${query}"`,
        '',
        `_Found ${results.length} result${results.length !== 1 ? 's' : ''} · hybrid retrieval (FTS5 + TF-IDF → RRF)_`,
        '',
      ];

      for (const [i, result] of results.entries()) {
        const { postmortem: pm, score, signals, embeddingSimilarity, keywordRank } = result;
        const date = new Date(pm.generatedAt).toISOString().slice(0, 10);
        const mttr = pm.mttrMs != null ? fmtMs(pm.mttrMs) : '—';
        const signalStr = signals.join('+');
        const simStr = embeddingSimilarity != null
          ? `sim=${(embeddingSimilarity * 100).toFixed(0)}%`
          : '';
        const rankStr = keywordRank != null ? `kw-rank=${keywordRank + 1}` : '';
        const meta = [signalStr, simStr, rankStr].filter(Boolean).join(', ');

        lines.push(
          `### ${i + 1}. ${pm.tag.replace(/^infra_/, '')} — ${pm.service} (${date})`,
          `_RRF score: ${score.toFixed(4)} · ${meta}_`,
          '',
          `**Root cause:** ${pm.rootCause}`,
          pm.fixCommand ? `**Fix:** \`${pm.fixCommand}\`` : '',
          `**MTTR:** ${mttr}  |  **Confidence:** ${Math.round(pm.confidence * 100)}%  |  **Resolution:** ${pm.resolvedAutonomously ? '🤖 autonomous' : '👤 manual'}`,
          pm.gitBranch ? `**Branch:** ${pm.gitBranch}  |  **SHA:** ${pm.gitSha ?? 'unknown'}` : '',
          '',
        );
      }

      lines.push('---', `_To generate a full runbook: \`generate_runbook(tag: "...")\`_`);

      return { content: [{ type: 'text', text: lines.filter((l) => l !== undefined).join('\n') }] };
    },
  );

  // ── draft_postmortem ────────────────────────────────────────────────────────
  server.registerTool(
    'draft_postmortem',
    {
      description:
        'Draft a blameless incident postmortem from live telemetry + corpus context. ' +
        'Reconstructs the incident timeline from buffer events, correlates with past similar incidents ' +
        'via hybrid retrieval, and produces a structured Markdown draft ready for team review. ' +
        'Eliminates the post-incident documentation chore — from "incident closed" to blameless draft in seconds. ' +
        'Outputs: timeline, contributing factors, impact estimate, action items, and related past incidents. ' +
        'Pass a summary of what happened plus the affected service. The draft auto-links to similar corpus incidents.',
      inputSchema: {
        service: z.string()
          .describe('Affected service name (e.g. "api", "payments", "worker").'),
        summary: z.string().optional()
          .describe('One-sentence description of what happened (e.g. "Database connection pool exhausted during peak traffic"). Used to find similar past incidents.'),
        duration_minutes: z.number().int().min(1).max(1440).optional()
          .describe('How long the incident lasted in minutes. Used for impact estimate.'),
        severity: z.enum(['sev1', 'sev2', 'sev3']).optional()
          .describe('Incident severity (default: sev2).'),
        affected_users: z.string().optional()
          .describe('Who was affected and how (e.g. "all authenticated users, checkout unavailable").'),
        slack_thread: z.string().optional()
          .describe('Slack thread URL or text content to incorporate into the timeline (optional).'),
      },
    },
    async ({ service, summary, duration_minutes, severity = 'sev2', affected_users, slack_thread }) => {
      trackCall('draft_postmortem');

      const now = Date.now();
      const windowMs = (duration_minutes ?? 60) * 60 * 1000;
      const windowStart = now - windowMs;

      // Pull telemetry from buffer for the incident window
      const errors    = store.getLogs(50, 'error', windowStart);
      const warns     = store.getLogs(20, 'warn',  windowStart);
      const netFails  = store.getNetwork(30, undefined, windowStart)
        .filter((n) => n.status >= 400 || !!n.error);
      const terminal  = store.getTerminalOutput(20, undefined, windowStart);

      // Find similar past incidents via hybrid retrieval
      const searchQuery = summary ?? `${service} incident failure`;
      const relatedPms = hybridSearch(searchQuery, { service, topK: 5 });

      // Build timeline from buffer events
      const timelineEvents: Array<{ ts: number; kind: string; msg: string }> = [];

      for (const e of errors.slice(0, 10)) {
        const msg = e.args.map((a) => typeof a === 'string' ? a : JSON.stringify(a)).join(' ').slice(0, 200);
        timelineEvents.push({ ts: e.timestamp, kind: 'ERROR', msg });
      }
      for (const n of netFails.slice(0, 10)) {
        timelineEvents.push({
          ts: n.timestamp,
          kind: `HTTP ${n.status || 'ERR'}`,
          msg: `${n.method} ${n.url}${n.error ? ` — ${n.error.slice(0, 100)}` : ''}`,
        });
      }
      for (const t of terminal.slice(0, 5)) {
        if (/error|fatal|panic|oom|killed/i.test(String(t.data ?? ''))) {
          timelineEvents.push({ ts: t.timestamp, kind: 'PROCESS', msg: String(t.data ?? '').slice(0, 200) });
        }
      }
      timelineEvents.sort((a, b) => a.ts - b.ts);

      // Contributing factors: deduplicate top error patterns
      const errorPatterns = [...new Set(
        errors.map((e) => {
          const msg = String(e.args?.[0] ?? '').slice(0, 120);
          return msg.replace(/\d+/g, 'N').replace(/[a-f0-9]{8,}/gi, '<id>');
        }),
      )].slice(0, 5);

      const netPatterns = [...new Set(
        netFails.map((n) => `${n.method} ${new URL(n.url).pathname} → ${n.status || 'ERR'}`).slice(0, 5),
      )];

      // Impact estimate
      const userImpact = affected_users ?? 'Unknown — add user impact manually';
      const durationLabel = duration_minutes
        ? fmtMs(duration_minutes * 60 * 1000)
        : 'Unknown — add duration manually';

      // Related past incidents section
      const relatedSection = relatedPms.length > 0
        ? [
          '## Related Past Incidents',
          '',
          '_Retrieved via hybrid search (FTS5 + TF-IDF → RRF)_',
          '',
          ...relatedPms.slice(0, 3).map((r, i) => {
            const pm = r.postmortem;
            const date = new Date(pm.generatedAt).toISOString().slice(0, 10);
            const mttr = pm.mttrMs != null ? fmtMs(pm.mttrMs) : '—';
            return [
              `### ${i + 1}. ${pm.tag.replace(/^infra_/, '')} — ${pm.service} (${date})`,
              `**Root cause:** ${pm.rootCause}`,
              pm.fixCommand ? `**Fix that worked:** \`${pm.fixCommand}\`` : '',
              `**MTTR:** ${mttr}  |  **Resolution:** ${pm.resolvedAutonomously ? 'Autonomous' : 'Manual'}`,
              '',
            ].filter(Boolean).join('\n');
          }),
        ].join('\n')
        : '';

      // Slack thread section
      const slackSection = slack_thread
        ? [
          '## Slack Thread Context',
          '',
          '```',
          slack_thread.slice(0, 1000),
          '```',
          '',
        ].join('\n')
        : '';

      // Draft action items based on error patterns
      const actionItems: string[] = [];
      if (errors.length > 0) actionItems.push(`[ ] Investigate root cause: ${errorPatterns[0] ?? 'see errors above'}`);
      if (netFails.length > 0) actionItems.push('[ ] Add retry logic / circuit breaker for failing endpoints');
      if (relatedPms.length > 1) actionItems.push(`[ ] Review ${relatedPms.length} similar past incidents — recurring pattern may need systemic fix`);
      actionItems.push('[ ] Update runbook: `generate_runbook(service: "' + service + '")`');
      actionItems.push('[ ] Schedule blameless retrospective within 5 business days');

      const severityLabel = severity.toUpperCase();
      const dateStr = new Date(windowStart).toISOString().slice(0, 10);

      const lines = [
        `# [${severityLabel}] Incident Postmortem — ${service}`,
        `_Draft generated by Mergen · ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC_`,
        '',
        '## Summary',
        '',
        summary ?? `${service} incident — add one-sentence summary here`,
        '',
        '## Impact',
        '',
        `- **Service:** ${service}`,
        `- **Severity:** ${severityLabel}`,
        `- **Date:** ${dateStr}`,
        `- **Duration:** ${durationLabel}`,
        `- **Users affected:** ${userImpact}`,
        '',
        '## Timeline',
        '',
        timelineEvents.length > 0
          ? timelineEvents.map((e) => {
              const ts = new Date(e.ts).toISOString().slice(11, 19);
              return `- \`${ts}\` **[${e.kind}]** ${e.msg}`;
            }).join('\n')
          : '_No telemetry events in window — add timeline manually or extend the window._',
        '',
        slackSection,
        '## Contributing Factors',
        '',
        ...(errorPatterns.length > 0
          ? errorPatterns.map((p, i) => `${i + 1}. ${p}`)
          : ['_Add contributing factors here_']),
        ...(netPatterns.length > 0 ? ['', '**Network failures:**', ...netPatterns.map((p) => `- ${p}`)] : []),
        '',
        '## Root Cause',
        '',
        relatedPms.length > 0
          ? `_Likely similar to: ${relatedPms[0].postmortem.rootCause} — verify against current evidence above_`
          : '_Add root cause analysis here — call `triage_incident` for automated root cause identification_',
        '',
        '## Resolution',
        '',
        relatedPms.length > 0 && relatedPms[0].postmortem.fixCommand
          ? `Previous resolution: \`${relatedPms[0].postmortem.fixCommand}\` — verify if applicable here`
          : '_Describe the fix that resolved the incident_',
        '',
        '## Action Items',
        '',
        ...actionItems,
        '',
        relatedSection,
        '---',
        `_Telemetry: ${errors.length} errors, ${warns.length} warnings, ${netFails.length} network failures in window · Corpus: ${postmortemStore.count()} postmortems_`,
      ].filter((l) => l !== undefined);

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );
}

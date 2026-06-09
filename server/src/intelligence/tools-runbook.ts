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
import { incidentStore } from '../sensor/incident-store.js';

function fmtMs(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.round((ms % 60_000) / 1000);
  return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
}

export function registerRunbookTools(server: McpServer): void {

  // ── check_fix_history ───────────────────────────────────────────────────────
  server.registerTool(
    'check_fix_history',
    {
      description:
        'Before running a fix, check whether Mergen has seen it before and whether it worked. ' +
        'Prevents repeated mistakes: if this command previously caused a REGRESSION or has a low ' +
        'resolution rate, the tool surfaces that before execution. ' +
        'Pass the exact command you are about to run (command) or a free-text description (description). ' +
        'Returns: resolution rate, avg MTTR when successful, per-service breakdown, and nearest ' +
        'corpus alternatives if the command is not found. ' +
        'Always call this before execute_fix or before proposing a fix to the user.',
      inputSchema: {
        command: z.string().optional()
          .describe('The shell command you are about to run (e.g. "kubectl rollout restart deployment/api"). Fuzzy-matched against fix history.'),
        description: z.string().optional()
          .describe('Free-text description of what the fix does (e.g. "restart the api pod"). Used for hybrid search when exact command is unknown.'),
        service: z.string().optional()
          .describe('Narrow results to a specific service.'),
      },
    },
    async ({ command, description, service }) => {
      trackCall('check_fix_history');

      if (!command && !description) {
        return {
          content: [{
            type: 'text' as const,
            text: 'Provide either `command` (the exact fix to check) or `description` (what the fix does).',
          }],
        };
      }

      // ── Path 1: command provided — SQL lookup first ──────────────────────────
      if (command) {
        const rows = postmortemStore.lookupFixHistory(command, service);

        if (rows.length > 0) {
          const totalApplied  = rows.reduce((s, r) => s + r.timesApplied, 0);
          const totalResolved = rows.reduce((s, r) => s + r.timesResolved, 0);
          const resolutionRate = totalApplied > 0
            ? Math.round((totalResolved / totalApplied) * 100)
            : 0;

          const verdict = resolutionRate >= 80
            ? '✅ HIGH CONFIDENCE'
            : resolutionRate >= 50
              ? '⚠️ MIXED RESULTS'
              : '❌ LOW SUCCESS RATE';

          const tableRows = rows.map((r) => {
            const mttr = r.avgMttrMs != null ? fmtMs(r.avgMttrMs) : '—';
            const rate = r.timesApplied > 0
              ? Math.round((r.timesResolved / r.timesApplied) * 100)
              : 0;
            const last = new Date(r.lastUsedAt).toISOString().slice(0, 10);
            return `| ${r.service} | ${r.timesApplied} | ${rate}% | ${mttr} | ${last} |`;
          });

          const lines = [
            `## Fix History: \`${command.slice(0, 80)}${command.length > 80 ? '…' : ''}\``,
            '',
            `**Found in corpus:** ${totalApplied} application${totalApplied !== 1 ? 's' : ''} across ${rows.length} service${rows.length !== 1 ? 's' : ''}`,
            '',
            '| Service | Applied | Resolved | Avg MTTR | Last used |',
            '|---------|---------|----------|----------|-----------|',
            ...tableRows,
            '',
            `${verdict} — ${resolutionRate}% overall resolution rate`,
            '',
            resolutionRate >= 80
              ? '_This fix has a strong track record. Proceed with `execute_fix`._'
              : resolutionRate >= 50
                ? '_Mixed results. Review the per-service breakdown before proceeding._'
                : '_Poor track record. Consider `triage_incident` for an alternative diagnosis._',
          ];

          return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
        }

        // Command not in corpus — fall through to hybrid search for alternatives
      }

      // ── Path 2: no SQL hit — hybrid search for related fixes ────────────────
      const searchQuery = command ?? description ?? '';
      const related = hybridSearch(searchQuery, { service, topK: 5 });

      if (related.length === 0) {
        const corpusSize = postmortemStore.count();
        return {
          content: [{
            type: 'text' as const,
            text: [
              `## Fix History: \`${searchQuery.slice(0, 80)}\``,
              '',
              command
                ? `⚠️ **Not found in corpus.** No previous applications of this command recorded.`
                : `⚠️ **No matching incidents found** for: "${searchQuery}"`,
              '',
              corpusSize === 0
                ? '_Corpus is empty — no incident history yet. Proceed with caution and validate after applying._'
                : `_Corpus has ${corpusSize} postmortem${corpusSize !== 1 ? 's' : ''} but none matched. Consider \`triage_incident\` for automated root cause analysis first._`,
            ].join('\n'),
          }],
        };
      }

      // Show closest alternatives from corpus
      const altLines = related.slice(0, 3).map((r, i) => {
        const pm = r.postmortem;
        const fix = pm.fixCommand ? `\`${pm.fixCommand.slice(0, 70)}${pm.fixCommand.length > 70 ? '…' : ''}\`` : '_no fix recorded_';
        const mttr = pm.mttrMs != null ? fmtMs(pm.mttrMs) : '—';
        const date = new Date(pm.generatedAt).toISOString().slice(0, 10);
        return [
          `**${i + 1}. ${pm.tag.replace(/^infra_/, '')}** — ${pm.service} (${date})`,
          `Fix: ${fix}  |  MTTR: ${mttr}  |  ${pm.resolvedAutonomously ? '🤖 autonomous' : '👤 manual'}`,
        ].join('\n');
      });

      const lines = [
        `## Fix History: \`${searchQuery.slice(0, 80)}\``,
        '',
        command
          ? `⚠️ **Not found in corpus.** No exact match — showing nearest related fixes:`
          : `**Nearest corpus fixes for:** "${searchQuery}"`,
        '',
        ...altLines.flatMap((l) => [l, '']),
        '---',
        '_If none of these apply, call `triage_incident` for a fresh causal analysis._',
      ];

      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    },
  );

  // ── explain_service ─────────────────────────────────────────────────────────
  server.registerTool(
    'explain_service',
    {
      description:
        'Returns a deterministic, token-efficient briefing card for a service: ' +
        'top failure modes ranked by frequency, avg MTTR per mode, autonomous resolution rate, ' +
        'verified fix commands ranked by usage, co-occurring services, and current open incident count. ' +
        'Built from the local incident corpus — no LLM calls, no hallucinated topology. ' +
        'Primary use case: new engineer joins on-call rotation and calls this before their first page. ' +
        'Also used by AI agents to ground themselves before triaging — prevents fabricated service boundaries.',
      inputSchema: {
        service: z.string()
          .describe('Service or component name (e.g. "api", "checkout-api", "payments-worker").'),
        limit: z.number().int().min(1).max(10).optional()
          .describe('Max failure modes to return (default: 5).'),
      },
    },
    async ({ service, limit = 5 }) => {
      trackCall('explain_service');

      // Exact match first; fall back to LIKE if the exact name isn't in the corpus
      // (handles "api" vs "api-service" naming drift across teams/deployments).
      let profile = postmortemStore.serviceProfile(service);
      let resolvedName = service;
      if (profile.totalIncidents === 0) {
        const fuzzy = postmortemStore.fuzzyService(service);
        if (fuzzy) {
          resolvedName = fuzzy;
          profile = postmortemStore.serviceProfile(fuzzy);
        }
      }

      // ── Empty corpus path ────────────────────────────────────────────────────
      if (profile.totalIncidents === 0) {
        const allStats = postmortemStore.tagStats();
        const knownServices = postmortemStore.knownServices(10);

        return {
          content: [{
            type: 'text' as const,
            text: [
              `## Service Profile: ${service}`,
              '',
              '_No incidents found for this service in the Mergen corpus._',
              '',
              knownServices.length > 0
                ? `**Known services in corpus:** ${knownServices.join(', ')}`
                : `**Corpus is empty.** Incidents are recorded automatically as they are triaged.`,
              '',
              'Once incidents are resolved, this tool returns:',
              '- Top failure modes by frequency',
              '- Average MTTR per failure mode',
              '- Verified fix commands ranked by usage',
              '- Co-occurring services',
              '',
              allStats.length > 0
                ? `_Tip: ${allStats.length} failure mode${allStats.length !== 1 ? 's' : ''} exist across all services — call \`generate_runbook\` with one of: ${allStats.slice(0, 3).map((s) => `\`${s.tag.replace(/^infra_/, '')}\``).join(', ')}_`
                : `_Run \`mergen-server demo\` to seed 50 real-world incidents and see this tool in action._`,
            ].join('\n'),
          }],
        };
      }

      // ── Co-occurring services ────────────────────────────────────────────────
      // SQL self-join: other services with incidents within 10 min of this service's
      // incidents. Pure SQL — no JS O(n²) scan.
      const coServices = incidentStore.coOccurringServices(resolvedName);

      // ── Open incidents ───────────────────────────────────────────────────────
      const openCount = incidentStore.list(undefined, 200).filter(
        (i) => i.service === resolvedName && i.status === 'open',
      ).length;

      // ── Format output card ───────────────────────────────────────────────────
      const firstDate = profile.firstSeenAt
        ? new Date(profile.firstSeenAt).toISOString().slice(0, 10)
        : '—';
      const lastDate = profile.lastSeenAt
        ? new Date(profile.lastSeenAt).toISOString().slice(0, 10)
        : '—';
      const fuzzyNote = resolvedName !== service
        ? `_No exact match for "${service}" — showing results for "${resolvedName}"_\n`
        : '';

      const modes = profile.failureModes.slice(0, limit);

      const modeRows = modes.map((m) => {
        const tag     = m.tag.replace(/^infra_/, '');
        const mttr    = m.avgMttrMs != null ? fmtMs(m.avgMttrMs) : '—';
        const fix     = m.topFixCommand ? `\`${m.topFixCommand.slice(0, 60)}${m.topFixCommand.length > 60 ? '…' : ''}\`` : '—';
        return `| ${tag} | ${m.frequency}× | ${mttr} | ${m.autonomousRate}% | ${fix} |`;
      });

      const fixLines = profile.topFixCommands.map((f, i) =>
        `${i + 1}. \`${f.command}\` — applied ${f.timesApplied}×`,
      );

      const coLine = coServices.length > 0
        ? coServices.map(({ service: svc, count }) => `${svc} (${count})`).join(' · ')
        : '_No co-occurring service data yet_';

      const openLine = openCount > 0
        ? `⚠️ **${openCount} open incident${openCount !== 1 ? 's' : ''}** currently tracked`
        : '✅ No open incidents';

      const lines = [
        `## Service Profile: ${resolvedName}`,
        `_Mergen corpus · ${profile.totalIncidents} incident${profile.totalIncidents !== 1 ? 's' : ''} · First: ${firstDate} · Last: ${lastDate}_`,
        fuzzyNote,
        openLine,
        '',
        '### Failure Modes',
        '',
        '| Mode | Freq | Avg MTTR | Auto-resolved | Most Recent Verified Fix |',
        '|------|------|----------|---------------|--------------------------|',
        ...modeRows,
        '',
      ];

      if (fixLines.length > 0) {
        lines.push('### Verified Fix Commands (ranked by usage)', '', ...fixLines, '');
      }

      lines.push(
        '### Co-occurring Services',
        '',
        coLine,
        '',
        '---',
        `_Drill down: \`generate_runbook(service: "${resolvedName}")\` · \`search_postmortems(query: "...", service: "${resolvedName}")\`_`,
      );

      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    },
  );

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
      const markdown = await draftPostmortemDoc({ service, summary, duration_minutes, severity, affected_users, slack_thread });
      return { content: [{ type: 'text', text: markdown }] };
    },
  );
}

// ── Shared draft logic ─────────────────────────────────────────────────────────
// Called by both the `draft_postmortem` MCP tool and the POST /postmortem/from-slack
// HTTP route so the draft algorithm lives in one place.

export async function draftPostmortemDoc(params: {
  service: string;
  summary?: string;
  duration_minutes?: number;
  severity?: 'sev1' | 'sev2' | 'sev3';
  affected_users?: string;
  slack_thread?: string;
}): Promise<string> {
  const { service, summary, duration_minutes, severity = 'sev2', affected_users, slack_thread } = params;

  const now = Date.now();
  const windowMs = (duration_minutes ?? 60) * 60 * 1000;
  const windowStart = now - windowMs;

  const errors    = store.getLogs(50, 'error', windowStart);
  const warns     = store.getLogs(20, 'warn',  windowStart);
  const netFails  = store.getNetwork(30, undefined, windowStart)
    .filter((n) => n.status >= 400 || !!n.error);
  const terminal  = store.getTerminalOutput(20, undefined, windowStart);

  const searchQuery = summary ?? `${service} incident failure`;
  const relatedPms = hybridSearch(searchQuery, { service, topK: 5 });

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

  const errorPatterns = [...new Set(
    errors.map((e) => {
      const msg = String(e.args?.[0] ?? '').slice(0, 120);
      return msg.replace(/\d+/g, 'N').replace(/[a-f0-9]{8,}/gi, '<id>');
    }),
  )].slice(0, 5);

  const netPatterns = [...new Set(
    netFails.map((n) => {
      let pathname = n.url;
      try { pathname = new URL(n.url).pathname; } catch { /* non-HTTP or relative URL */ }
      return `${n.method} ${pathname} → ${n.status || 'ERR'}`;
    }).slice(0, 5),
  )];

  const userImpact = affected_users ?? 'Unknown — add user impact manually';
  const durationLabel = duration_minutes
    ? fmtMs(duration_minutes * 60 * 1000)
    : 'Unknown — add duration manually';

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

  return lines.join('\n');
}

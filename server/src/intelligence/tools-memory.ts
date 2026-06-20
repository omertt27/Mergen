import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { memoryStore, formatMttr, type IncidentMemoryRecord } from '../datadog/memory-store.js';
import { agentMemoryStore } from '../sensor/agent-memory-store.js';
import { getOverrideSummary, getOverridesForTag } from './override-corpus.js';
import { getStats, getStatsForTag, getRecords, isCorpusSeeded } from './calibration.js';
import { trackCall } from './tools-state.js';

function formatRecord(r: IncidentMemoryRecord, index: number): string {
  const firedAgo = Math.round((Date.now() - r.firedAt) / 60_000);
  const mttr = r.mttrMs ? formatMttr(r.mttrMs) : 'unresolved';
  const fix = r.fixPrTitle
    ? `Fix: [${r.fixPrTitle}](${r.fixPrUrl ?? '#'}) (${r.resolutionType})`
    : r.fixSummary
      ? `Fix: ${r.fixSummary}`
      : `Fix: not captured (${r.resolutionType})`;

  const location = r.implicatedFile
    ? `\`${r.implicatedFile}${r.implicatedLine ? ':' + r.implicatedLine : ''}\``
    : 'unknown';

  return [
    `**${index + 1}.** \`${new Date(r.firedAt).toISOString().slice(0, 16)}\` · ${firedAgo}m ago`,
    `   Service: \`${r.service}\` · Endpoint: \`${r.endpoint}\``,
    `   Error: ${r.errorMessage.slice(0, 120)}`,
    `   Location: ${location}`,
    `   MTTR: ${mttr} · ${fix}`,
    r.deployedSha ? `   Deploy: \`${r.deployedSha.slice(0, 7)}\`` : '',
  ].filter(Boolean).join('\n');
}

function fmtMs(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.round((ms % 60_000) / 1_000);
  return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
}

export function registerMemoryTools(server: McpServer): void {
  // ── get_incident_history ───────────────────────────────────────────────────
  server.registerTool(
    'get_incident_history',
    {
      description:
        'Returns the historical record of past incidents matching the current error pattern. ' +
        'Use this after get_incident_context to answer: "Have we seen this before? ' +
        'How was it fixed? How long did it take?" ' +
        'The fingerprint is a stable hash of error_type + service + endpoint — same class of bug, same fingerprint. ' +
        'Also returns benchmark statistics (p50 MTTR, most common fix type).',
      inputSchema: {
        fingerprint: z
          .string()
          .optional()
          .describe('16-char hex fingerprint from a previous incident (shown in get_incident_context output)'),
        service: z
          .string()
          .optional()
          .describe('Filter by service name instead of fingerprint (e.g. "api", "auth-service", "payments")'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe('Max past incidents to return (default 5)'),
      },
    },
    async ({ fingerprint, service, limit = 5 }) => {
      trackCall('get_incident_history');

      if (!memoryStore.isHealthy()) {
        return {
          content: [{
            type: 'text',
            text: '⚠️ **Incident memory store is unavailable** (SQLite init failed — check logs for WASM or file error). History cannot be queried. New incidents will not be persisted until the store recovers on next restart.',
          }],
        };
      }

      if (!fingerprint && !service) {
        return {
          content: [{
            type: 'text',
            text: [
              '## Incident History',
              '',
              'Provide either `fingerprint` (from a Runtime Fact) or `service` to look up history.',
              '',
              '**Open incidents right now:**',
              ...memoryStore.listOpen().slice(0, 5).map((r, i) => formatRecord(r, i)),
            ].join('\n'),
          }],
        };
      }

      let similar: IncidentMemoryRecord[];
      if (fingerprint) {
        similar = memoryStore.findSimilar(fingerprint, limit);
      } else {
        // Service filter: return recent records for that service regardless of fingerprint
        similar = memoryStore.listOpen()
          .filter((r) => r.service === service)
          .slice(0, limit);
        if (similar.length < limit) {
          // Also fetch resolved ones
          const fp = similar[0]?.fingerprint;
          if (fp) similar = memoryStore.findSimilar(fp, limit);
        }
      }

      if (similar.length === 0) {
        return {
          content: [{
            type: 'text',
            text: fingerprint
              ? `No historical incidents found for fingerprint \`${fingerprint}\`.\n\nThis is the first time Mergen has seen this error pattern.`
              : `No historical incidents found for service \`${service}\`.`,
          }],
        };
      }

      const fp = similar[0].fingerprint;
      const stats = memoryStore.benchmarkStats(fp);
      const lines: string[] = [
        `## Incident History — fingerprint \`${fp}\``,
        '',
      ];

      if (stats && stats.occurrences > 1) {
        const p50 = stats.p50MttrMs ? formatMttr(stats.p50MttrMs) : 'N/A';
        const p90 = stats.p90MttrMs ? formatMttr(stats.p90MttrMs) : 'N/A';
        const lastSeen = stats.lastSeenAt
          ? `${Math.round((Date.now() - stats.lastSeenAt) / 86_400_000)}d ago`
          : 'unknown';
        lines.push(
          `**Seen ${stats.occurrences} time${stats.occurrences !== 1 ? 's' : ''} · p50 MTTR: ${p50} · p90 MTTR: ${p90}**`,
          `Most common fix: **${stats.topResolutionType}** (${stats.topResolutionCount}/${stats.occurrences} times) · Last seen: ${lastSeen}`,
          '',
        );
      }

      lines.push('**Past incidents (most recent first):**', '');
      for (const [i, r] of similar.entries()) {
        lines.push(formatRecord(r, i), '');
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  // ── list_open_incidents ────────────────────────────────────────────────────
  server.registerTool(
    'list_open_incidents',
    {
      description:
        'Lists all currently open incidents tracked by Mergen (fired but not yet resolved). ' +
        'Use this to see what is actively burning and whether any GitHub PRs have been correlated.',
      inputSchema: {},
    },
    async () => {
      trackCall('list_open_incidents');

      const open = memoryStore.listOpen();
      if (open.length === 0) {
        return { content: [{ type: 'text', text: '## Open Incidents\n\nNo open incidents. All quiet.' }] };
      }

      const lines = [`## Open Incidents (${open.length})`, ''];
      for (const [i, r] of open.entries()) {
        lines.push(formatRecord(r, i), '');
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  // ── store_agent_memory ─────────────────────────────────────────────────────
  server.registerTool(
    'store_agent_memory',
    {
      description:
        'Persist a key–value memory that survives across sessions. Use this to remember ' +
        'patterns, constraints, or context that you should not have to re-discover the next ' +
        'time you are invoked. Tag memories with `service` and `errorFingerprint` to enable ' +
        'episodic recall — retrieving past context for the exact (service, error) pair you are working on.',
      inputSchema: {
        key:              z.string().min(1).max(200).describe('Short, human-readable identifier for the memory'),
        value:            z.string().min(1).max(8000).describe('The content to remember (plain text or JSON)'),
        agentId:          z.string().optional().describe('Identifier for this agent. Defaults to "default"'),
        ttlMs:            z.number().int().min(0).optional().describe('Time-to-live in milliseconds. 0 = permanent'),
        service:          z.string().optional().describe('Service name for episodic indexing (e.g. "api", "auth-service")'),
        errorFingerprint: z.string().optional().describe('Error fingerprint hash for episodic indexing'),
      },
    },
    async ({ key, value, agentId = 'default', ttlMs = 0, service = '', errorFingerprint = '' }) => {
      trackCall('store_agent_memory');
      if (!agentMemoryStore.isHealthy()) {
        return {
          content: [{
            type: 'text',
            text: '⚠️ **Agent memory store is unavailable** (SQLite init failed). Memory was NOT persisted. Check server logs for the root cause.',
          }],
        };
      }
      const entry = agentMemoryStore.store(agentId, key, value, ttlMs, service, errorFingerprint);
      return {
        content: [{ type: 'text', text: `Memory stored: "${key}" [id=${entry.id}${service ? `, service=${service}` : ''}]` }],
      };
    },
  );

  // ── recall_agent_memory ────────────────────────────────────────────────────
  server.registerTool(
    'recall_agent_memory',
    {
      description:
        'Retrieve previously stored agent memories. Use this at the start of each session ' +
        'to recover patterns and constraints from prior runs. Filter by `service` + `errorFingerprint` ' +
        'for episodic recall — retrieving exactly the memories relevant to the current incident context.',
      inputSchema: {
        key:              z.string().optional().describe('Filter to memories with this exact key'),
        agentId:          z.string().optional().describe('Agent ID to scope the recall. Defaults to "default"'),
        limit:            z.number().int().min(1).max(50).optional().describe('Max entries to return (default 10)'),
        service:          z.string().optional().describe('Filter to memories tagged for this service'),
        errorFingerprint: z.string().optional().describe('Filter to memories tagged for this error fingerprint'),
      },
    },
    async ({ key, agentId = 'default', limit = 10, service, errorFingerprint }) => {
      trackCall('recall_agent_memory');
      if (!agentMemoryStore.isHealthy()) {
        return {
          content: [{
            type: 'text',
            text: '⚠️ **Agent memory store is unavailable** (SQLite init failed — check logs for WASM or file error). Memories cannot be retrieved. Call `store_agent_memory` to check if the issue has resolved.',
          }],
        };
      }
      const entries = agentMemoryStore.recall(agentId, key, limit, service, errorFingerprint);
      if (entries.length === 0) {
        return { content: [{ type: 'text', text: 'No memories found.' }] };
      }
      const lines = [`## Agent Memories (${entries.length})`, ''];
      for (const e of entries) {
        const expiry = e.ttlMs > 0
          ? `  _(expires ${new Date(e.storedAt + e.ttlMs).toISOString()})_`
          : '';
        const ctx = [e.service, e.errorFingerprint].filter(Boolean).join('/');
        lines.push(`### ${e.key}${ctx ? ` [${ctx}]` : ''}${expiry}`, e.value, '');
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  // ── list_agent_memory_keys ─────────────────────────────────────────────────
  server.registerTool(
    'list_agent_memory_keys',
    {
      description:
        'List all memory keys stored for an agent. Use this at the start of a session to discover ' +
        'what was previously stored before calling recall_agent_memory with a specific key. ' +
        'Without this tool, an agent would need to already know the key names — defeating the purpose of persistent memory.',
      inputSchema: {
        agentId: z.string().optional()
          .describe('Agent ID to scope the listing. Defaults to "default".'),
      },
    },
    async ({ agentId = 'default' }) => {
      trackCall('list_agent_memory_keys');
      if (!agentMemoryStore.isHealthy()) {
        return {
          content: [{
            type: 'text' as const,
            text: '⚠️ **Agent memory store is unavailable** (SQLite init failed). Keys cannot be listed.',
          }],
        };
      }
      const keys = agentMemoryStore.listKeys(agentId);
      if (keys.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: `No memories stored for agent \`${agentId}\`.\n\nCall \`store_agent_memory\` to begin persisting context across sessions.`,
          }],
        };
      }
      const lines = [
        `## Agent Memory Keys — \`${agentId}\` (${keys.length} key${keys.length !== 1 ? 's' : ''})`,
        '',
        ...keys.map((k) => `- **${k.key}** — last updated ${new Date(k.lastStoredAt).toISOString().slice(0, 16)} UTC`),
        '',
        '_Call `recall_agent_memory(key: "...")` to retrieve the value for a specific key._',
      ];
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    },
  );

  // ── get_override_patterns ──────────────────────────────────────────────────
  // Exposes the override corpus to the AI agent so it can understand operational
  // constraints BEFORE proposing a fix — prevents re-proposing actions that
  // engineers have already decided are unsafe in a given context.
  server.registerTool(
    'get_override_patterns',
    {
      description:
        'Returns the override corpus — all the times engineers said NO to Mergen\'s recommendations, ' +
        'categorised by why and when. Use this BEFORE proposing or executing a fix to understand ' +
        'operational constraints that are not encoded in code: Friday batch windows, compliance holds, ' +
        'cost ceilings, or on-call preferences. ' +
        'If a pattern shows "batch-window" overrides every Friday evening for a service, do not propose ' +
        'restarts on Friday evenings. This is the team\'s institutional knowledge in structured form.',
      inputSchema: {
        service: z.string().optional()
          .describe('Filter to override patterns for a specific service.'),
        tag: z.string().optional()
          .describe('Filter to a specific failure mode tag (e.g. "connection_pool_exhausted").'),
        limit: z.number().int().min(1).max(50).optional()
          .describe('Max patterns to return (default 20).'),
      },
    },
    async ({ service, tag, limit = 20 }) => {
      trackCall('get_override_patterns');

      // Tag-specific lookup: return raw events + summary
      if (tag) {
        const normalizedTag = tag.startsWith('infra_') ? tag : tag;
        const events = getOverridesForTag(normalizedTag)
          .filter((e) => !service || e.service === service)
          .slice(-limit);

        if (events.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: `## Override Patterns — \`${normalizedTag}\`\n\nNo overrides recorded for this failure mode${service ? ` on service \`${service}\`` : ''}.\n\n_If Mergen has never been overridden for this (tag, service) pair, autonomous execution is not blocked by the corpus._`,
            }],
          };
        }

        const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        const lines = [
          `## Override Patterns — \`${normalizedTag}\`${service ? ` · service: \`${service}\`` : ''}`,
          '',
          `**${events.length} override${events.length !== 1 ? 's' : ''} recorded**`,
          '',
          '| Date | Service | Reason | Time (UTC) | Outcome |',
          '|------|---------|--------|------------|---------|',
          ...events.map((e) => {
            const date    = new Date(e.recordedAt).toISOString().slice(0, 10);
            const time    = `${DAY_NAMES[e.dayOfWeek]} ${e.hourOfDay}:00`;
            const outcome = e.outcome ?? 'unknown';
            return `| ${date} | ${e.service} | ${e.overrideReason} | ${time} | ${outcome} |`;
          }),
          '',
          events.length > 0
            ? `_Dominant pattern: \`${events.reduce((best, e, _, arr) => {
                const counts = new Map<OverrideReason, number>();
                for (const ev of arr) counts.set(ev.overrideReason, (counts.get(ev.overrideReason) ?? 0) + 1);
                let topReason: OverrideReason = best;
                let topCount  = 0;
                for (const [r, c] of counts) if (c > topCount) { topReason = r; topCount = c; }
                return topReason;
              }, events[0].overrideReason)}\` — check time pattern before proposing a fix._`
            : '',
        ];

        return { content: [{ type: 'text' as const, text: lines.filter(Boolean).join('\n') }] };
      }

      // Global summary across all tags
      const summaries = getOverrideSummary()
        .filter((s) => !service || s.services.includes(service))
        .slice(0, limit);

      if (summaries.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: '## Override Patterns\n\nNo overrides recorded yet.\n\n_The override corpus grows automatically as engineers decline Mergen\'s recommendations. POST /overrides to record a manual override._',
          }],
        };
      }

      const totalOverrides = summaries.reduce((s, x) => s + x.total, 0);
      const lines = [
        '## Override Patterns — Corpus Summary',
        '',
        `**${totalOverrides} total overrides** across **${summaries.length} failure modes**`,
        '',
        '| Failure Mode | Overrides | Dominant Reason | Time Pattern | Services |',
        '|---|---|---|---|---|',
        ...summaries.map((s) => {
          const tp = s.timePattern ?? '—';
          const sv = s.services.slice(0, 3).join(', ') + (s.services.length > 3 ? '…' : '');
          return `| \`${s.tag}\` | ${s.total} | ${s.dominantReason ?? '—'} | ${tp} | ${sv} |`;
        }),
        '',
        '---',
        '_Call `get_override_patterns(tag: "...")` for full history of a specific failure mode._',
        '_Before proposing a fix, check whether the (tag, service, time) combination has been overridden before._',
      ];

      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    },
  );

  // ── get_detector_calibration ───────────────────────────────────────────────
  // Exposes calibration accuracy to the AI agent so it can self-assess how
  // much to trust its own diagnosis before proposing a fix.
  server.registerTool(
    'get_detector_calibration',
    {
      description:
        'Returns calibration accuracy for Mergen\'s detectors — how often each diagnosis type has ' +
        'been correct, wrong, or partial based on production feedback. ' +
        'Use this to understand how reliable a specific hypothesis is before acting on it. ' +
        'A detector with 90% accuracy and 30+ verdicts is highly trusted. ' +
        'One with 50% accuracy or fewer than 5 verdicts is uncertain — require higher confidence or manual review. ' +
        'Also returns the 7-day accuracy trend to detect detectors that are drifting.',
      inputSchema: {
        tag: z.string().optional()
          .describe('Specific failure mode tag to look up (e.g. "connection_pool_exhausted"). Omit to return all detectors.'),
      },
    },
    async ({ tag }) => {
      trackCall('get_detector_calibration');

      const seededWarning = isCorpusSeeded()
        ? '\n> ⚠️ **SYNTHETIC PRIORS ACTIVE** — no production verdicts have been recorded yet (or all have expired). The accuracy figures below are developer estimates, not measurements from this system\'s incident history. Do not use them to gate autonomous execution decisions.\n'
        : '';

      if (tag) {
        const normalizedTag = tag.startsWith('infra_') ? tag : tag;
        const stats = getStatsForTag(normalizedTag);

        if (!stats) {
          return {
            content: [{
              type: 'text' as const,
              text: [
                `## Detector Calibration — \`${normalizedTag}\``,
                seededWarning,
                '_No calibration data yet for this detector._',
                '',
                `Calibration builds automatically as incidents of type \`${normalizedTag}\` are diagnosed and verdicts recorded.`,
                'With fewer than 5 verdicts, execution decisions use the built-in prior (developer estimate).',
              ].filter(Boolean).join('\n'),
            }],
          };
        }

        const trustLabel = stats.trusted
          ? `✅ TRUSTED (${stats.verdicts} verdicts)`
          : `⚠️ PRIOR ESTIMATE (${stats.verdicts}/${5} verdicts needed)`;

        const trendLabel = stats.trendDelta !== null
          ? stats.trendDelta > 0.05
            ? `📈 Improving (+${Math.round(stats.trendDelta * 100)}% vs all-time)`
            : stats.trendDelta < -0.05
              ? `📉 Degrading (${Math.round(stats.trendDelta * 100)}% vs all-time)`
              : `→ Stable`
          : '— insufficient 7-day data';

        const shouldAct = stats.accuracy >= 0.7
          ? '✅ Proceed with `execute_fix` if confidence ≥ threshold'
          : stats.accuracy >= 0.5
            ? '⚠️ Mixed accuracy — require confidence ≥ 0.90 or manual review'
            : '🚫 Poor accuracy — do not auto-execute; manual review required';

        // Real vs. synthetic verdict breakdown so agents know what the accuracy is based on
        const tagRecs = getRecords().filter((r) => r.tag === normalizedTag);
        const realVerdicts    = tagRecs.filter((r) => !r.isBuiltinSeed && r.verdict !== null).length;
        const syntheticVerdicts = tagRecs.filter((r) => r.isBuiltinSeed).length;
        const verdictBreakdown = realVerdicts > 0
          ? `${realVerdicts} real · ${syntheticVerdicts} synthetic priors`
          : `0 real · ${syntheticVerdicts} synthetic priors _(accuracy based on estimates only)_`;

        const lines = [
          `## Detector Calibration — \`${normalizedTag}\``,
          seededWarning,
          `**Status:** ${trustLabel}`,
          `**All-time accuracy:** ${Math.round(stats.accuracy * 100)}%`,
          `**7-day accuracy:** ${stats.accuracy7d !== null ? Math.round(stats.accuracy7d * 100) + '%' : '—'}`,
          `**Trend:** ${trendLabel}`,
          `**Total predictions:** ${stats.predictions}`,
          `**Verdicts:** ${stats.verdicts} (correct: ${Math.round(stats.diagnosisAccuracy * 100)}%, remediation: ${stats.remediationAccuracy !== null ? Math.round(stats.remediationAccuracy * 100) + '%' : '—'})`,
          `**Verdict breakdown:** ${verdictBreakdown}`,
          '',
          `**Recommended action:** ${shouldAct}`,
          '',
          stats.commonFailureModes.length > 0
            ? [
                '**Common reasons for wrong diagnoses:**',
                ...stats.commonFailureModes.slice(0, 3).map((m) => `- "${m.note}" (${m.count}×)`),
              ].join('\n')
            : '',
        ].filter(Boolean);

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      }

      // All detectors overview
      const allStats = getStats().filter((s) => s.predictions > 0);

      if (allStats.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: '## Detector Calibration\n\nNo calibration data yet.\n\nCalibration builds automatically as incidents are diagnosed and resolved. Each correct/wrong verdict updates the accuracy scores shown here.',
          }],
        };
      }

      const trusted    = allStats.filter((s) => s.trusted);
      const untrusted  = allStats.filter((s) => !s.trusted);
      const avgAccuracy = trusted.length > 0
        ? trusted.reduce((sum, s) => sum + s.accuracy, 0) / trusted.length
        : null;

      const lines = [
        '## Detector Calibration — All Detectors',
        seededWarning,
        `**${allStats.length} detectors tracked** · **${trusted.length} trusted** (≥5 verdicts) · **${untrusted.length} on prior estimate**`,
        avgAccuracy !== null
          ? `**Mean accuracy (trusted):** ${Math.round(avgAccuracy * 100)}%`
          : '',
        '',
        '### Trusted Detectors',
        '',
        '| Tag | Accuracy | 7d Trend | Verdicts | Suppress? |',
        '|-----|----------|----------|----------|-----------|',
        ...trusted
          .sort((a, b) => b.accuracy - a.accuracy)
          .map((s) => {
            const acc7d = s.accuracy7d !== null ? Math.round(s.accuracy7d * 100) + '%' : '—';
            const trend = s.trendDelta !== null
              ? (s.trendDelta > 0.05 ? '📈' : s.trendDelta < -0.05 ? '📉' : '→')
              : '—';
            const suppress = s.shouldInterrupt ? '🚫 YES' : '—';
            return `| \`${s.tag}\` | ${Math.round(s.accuracy * 100)}% | ${trend} ${acc7d} | ${s.verdicts} | ${suppress} |`;
          }),
        '',
        untrusted.length > 0
          ? [
              '### On Prior Estimate (< 5 verdicts)',
              '',
              untrusted.map((s) => `- \`${s.tag}\`: ${s.predictions} predictions, ${s.verdicts} verdict${s.verdicts !== 1 ? 's' : ''}`).join('\n'),
            ].join('\n')
          : '',
        '',
        '---',
        '_A detector is suppressed (🚫) when accuracy falls below 20% on trusted data — Mergen will stop surfacing it until the corpus improves._',
      ].filter(Boolean);

      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    },
  );
}

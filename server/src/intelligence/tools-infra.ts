import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { store, LogLevel } from '../sensor/buffer.js';
import { truncateToTokenBudget } from './token-budget.js';
import { hypothesisHistory } from './hypothesis-history.js';
import { getActivePlanId } from './license.js';
import { getPlan } from './plans.js';
import { trackCall, withTierGate } from './tools-state.js';
import { getTierForTool } from './tool-manifest.js';
import logger from '../sensor/logger.js';

export function registerInfraTools(server: McpServer): void {
  // ── get_unified_timeline ───────────────────────────────────────────────────
  server.registerTool(
    'get_unified_timeline',
    {
      description:
        'Returns the complete cross-signal causal timeline with confidence labels on every event. ' +
        'EXACT = deterministic traceId join (browser request ↔ backend log line, same request). ' +
        'LINKED = structural SHA join (git blame / CI run / deployment matches browser build). ' +
        '~CORR = timestamp proximity only (within 2s, statistical). ' +
        'OBS = event captured, no cross-signal link found. ' +
        'Start with EXACT rows — they are the verified causal chain. Use LINKED rows to find the responsible commit. ' +
        'Includes root cause hypothesis at top when confidence ≥ 45%.',
      inputSchema: {
        seconds: z.number().int().min(60).max(3600).optional()
          .describe('Time window in seconds (default 300 = 5 minutes, max 3600 = 1 hour)'),
        limit: z.number().int().min(1).max(200).optional()
          .describe('Max events to return (default 50)'),
      },
    },
    withTierGate(getTierForTool('get_unified_timeline'), async ({ seconds = 300, limit = 50 }) => {
      trackCall('get_unified_timeline');

      const since            = Date.now() - seconds * 1000;
      const BACKEND_ERROR_RE = /error|exception|traceback|panic|fatal|killed|oom/i;

      type Confidence = 'exact' | 'linked' | 'temporal' | 'observed';

      const backendTraceSet = new Set<string>();
      for (const t of store.getTerminalOutput(200, undefined, since)) {
        if (t.traceId) backendTraceSet.add(t.traceId);
      }

      const browserTraceMap = new Map<string, string>();
      for (const n of store.getNetwork(limit, undefined, since)) {
        if (n.traceId) browserTraceMap.set(n.traceId, `${n.method} ${n.url}`);
      }

      const browserBuildShas = new Set<string>();
      for (const e of store.getLogs(limit, undefined, since)) {
        if (e.buildSha) browserBuildShas.add(e.buildSha.toLowerCase());
      }
      for (const n of store.getNetwork(limit, undefined, since)) {
        if (n.buildSha) browserBuildShas.add(n.buildSha.toLowerCase());
      }

      const ciAndDeployShas = new Set<string>();
      for (const c of store.getCIEvents(50, undefined, since)) {
        ciAndDeployShas.add(c.sha.toLowerCase());
        if (c.shortSha) ciAndDeployShas.add(c.shortSha.toLowerCase());
      }
      for (const d of store.getDeployments(20, undefined, since)) {
        ciAndDeployShas.add(d.sha.toLowerCase());
        if (d.shortSha) ciAndDeployShas.add(d.shortSha.toLowerCase());
      }

      const backendErrTimes = store.getTerminalOutput(100, undefined, since)
        .filter((t) => BACKEND_ERROR_RE.test(t.data))
        .map((t) => t.timestamp);

      function nearBackend(ts: number): boolean {
        return backendErrTimes.some((t) => Math.abs(t - ts) <= 2_000);
      }

      function badge(c: Confidence): string {
        switch (c) {
          case 'exact':    return '`EXACT   `';
          case 'linked':   return '`LINKED  `';
          case 'temporal': return '`~CORR   `';
          case 'observed': return '`OBS     `';
        }
      }

      type Row = { ts: number; label: string; icon: string; source: string; sha?: string; confidence: Confidence };
      const rows: Row[] = [];

      for (const e of store.getLogs(limit, undefined, since)) {
        if (e.level === 'log') continue;
        const msg    = e.args.map((a) => typeof a === 'string' ? a : JSON.stringify(a)).join(' ').slice(0, 150);
        const blame  = e.gitSuspect ? `  [${e.gitSuspect.sha.slice(0, 7)} · ${e.gitSuspect.author}]` : '';
        const confidence: Confidence = e.gitSuspect ? 'linked' : nearBackend(e.timestamp) ? 'temporal' : 'observed';
        rows.push({ ts: e.timestamp, icon: e.level === 'error' ? '🔴' : '🟡', label: msg + blame, source: 'browser', confidence });
      }

      for (const n of store.getNetwork(limit, undefined, since)) {
        if (n.status < 400 && n.status !== 0 && !n.error) continue;
        const traceJoin = n.traceId ? backendTraceSet.has(n.traceId) : false;
        const shaJoin   = n.buildSha ? ciAndDeployShas.has(n.buildSha.toLowerCase()) : false;
        const confidence: Confidence = traceJoin ? 'exact' : shaJoin ? 'linked' : nearBackend(n.timestamp) ? 'temporal' : 'observed';
        const traceNote = traceJoin ? '  ↔ backend' : '';
        rows.push({ ts: n.timestamp, icon: '🔴', label: `${n.method} ${n.url} → ${n.status || 'ERR'} (${n.duration}ms)${traceNote}`, source: 'browser', confidence });
      }

      for (const t of store.getTerminalOutput(100, undefined, since)) {
        if (!BACKEND_ERROR_RE.test(t.data)) continue;
        const traceJoin = t.traceId ? browserTraceMap.has(t.traceId) : false;
        const confidence: Confidence = traceJoin ? 'exact' : 'observed';
        const traceNote = traceJoin ? `  ↔ ${browserTraceMap.get(t.traceId!)}` : '';
        rows.push({ ts: t.timestamp, icon: '💻', label: `[${t.terminalName}] ${t.data.slice(0, 150)}${traceNote}`, source: 'backend', confidence });
      }

      for (const p of store.getProcessExits(20, undefined, since)) {
        if (p.reason === 'normal') continue;
        rows.push({ ts: p.timestamp, icon: '💥', label: `[${p.process}] crashed (exit ${p.exitCode})`, source: 'backend', confidence: 'observed' });
      }

      for (const c of store.getCIEvents(50, undefined, since)) {
        const icon   = c.status === 'failure' ? '❌' : c.status === 'success' ? '✅' : '⏭';
        const tests  = c.failedTests && c.failedTests.length > 0
          ? ` — ${c.failedTests.slice(0, 2).map((t) => t.name).join(', ')}`
          : '';
        const sha7   = c.shortSha ?? c.sha.slice(0, 7);
        const shaJoin = browserBuildShas.has(c.sha.toLowerCase()) || browserBuildShas.has(sha7.toLowerCase());
        rows.push({ ts: c.timestamp, icon, label: `CI ${c.status}: ${c.job}${tests}`, source: 'ci', sha: sha7, confidence: shaJoin ? 'linked' : 'observed' });
      }

      for (const d of store.getDeployments(20, undefined, since)) {
        const icon   = d.status === 'success' ? '🚀' : d.status === 'failure' ? '💥' : d.status === 'rollback' ? '⏪' : '⏳';
        const sha7   = d.shortSha ?? d.sha.slice(0, 7);
        const shaJoin = browserBuildShas.has(d.sha.toLowerCase()) || browserBuildShas.has(sha7.toLowerCase());
        rows.push({ ts: d.timestamp, icon, label: `Deploy to ${d.environment}: ${d.status}${d.actor ? ' by ' + d.actor : ''}`, source: 'deploy', sha: sha7, confidence: shaJoin ? 'linked' : 'observed' });
      }

      rows.sort((a, b) => a.ts - b.ts);
      const trimmed = rows.slice(-limit);

      const latest = hypothesisHistory.latest();
      const top    = latest?.topHypothesis ?? null;
      const lines: string[] = [];

      if (top && top.confidenceScore >= 0.45) {
        const pct = Math.round(top.confidenceScore * 100);
        lines.push(`## Root Cause — ${pct}% confidence`, `**${top.summary}**`);
        if (top.fixHint) lines.push(`Fix: ${top.fixHint}`);
        lines.push('', '---', '');
      }

      const exactCount    = trimmed.filter((r) => r.confidence === 'exact').length;
      const linkedCount   = trimmed.filter((r) => r.confidence === 'linked').length;
      const temporalCount = trimmed.filter((r) => r.confidence === 'temporal').length;

      lines.push(`## Unified Timeline (last ${Math.round(seconds / 60)}m · ${trimmed.length} events)`);
      if (exactCount > 0 || linkedCount > 0 || temporalCount > 0) {
        const parts: string[] = [];
        if (exactCount    > 0) parts.push(`${exactCount} exact trace join${exactCount    > 1 ? 's' : ''}`);
        if (linkedCount   > 0) parts.push(`${linkedCount} SHA-linked`);
        if (temporalCount > 0) parts.push(`${temporalCount} temporal`);
        lines.push(`*Causal joins: ${parts.join(' · ')}*`);
      }
      lines.push('');

      for (const r of trimmed) {
        const time = new Date(r.ts).toISOString().slice(11, 19);
        const sha  = r.sha ? `  [${r.sha}]` : '';
        lines.push(`\`${time}\`  ${r.icon}  ${badge(r.confidence)}  **[${r.source.toUpperCase()}]**  ${r.label}${sha}`);
      }

      if (trimmed.length === 0) {
        lines.push('*No significant events in the last ' + Math.round(seconds / 60) + ' minutes.*', '');
        lines.push('Connect your CI pipeline: `POST /ci/github` or `POST /ci/generic`');
        lines.push('Notify Mergen of deploys: `POST /deployments`');
        lines.push('Stream backend logs: `mergen-server watch npm start`');
      } else {
        lines.push('', '> `EXACT` = traceId join  ·  `LINKED` = SHA/git join  ·  `~CORR` = timestamp proximity  ·  `OBS` = no cross-signal link');
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }),
  );

  // ── get_ci_results ─────────────────────────────────────────────────────────
  server.registerTool(
    'get_ci_results',
    {
      description:
        'Returns CI/CD run results (GitHub Actions, GitLab CI, etc.) captured by Mergen. ' +
        'Use this when a browser error appeared after a deploy to ask: ' +
        '"Did the CI run for this commit have failures? Which tests?" ' +
        'The commit SHA links CI failures directly to browser errors.',
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional()
          .describe('Max results to return (default 20)'),
        status: z.enum(['success', 'failure', 'cancelled', 'skipped']).optional()
          .describe('Filter by status — use "failure" to see only broken builds'),
        since: z.number().int().optional()
          .describe('Only return CI runs after this Unix timestamp in ms'),
        sha: z.string().optional()
          .describe('Filter to a specific commit SHA (full or short)'),
      },
    },
    async ({ limit, status, since, sha }) => {
      trackCall('get_ci_results');
      let events = store.getCIEvents(limit ?? 20, status, since);

      if (sha) {
        const s = sha.toLowerCase();
        events = events.filter((e) => e.sha.startsWith(s) || s.startsWith(e.sha.slice(0, 7)));
      }

      if (events.length === 0) {
        return {
          content: [{
            type: 'text',
            text:
              'No CI events in buffer.\n\nTo send CI results to Mergen, add to your GitHub Actions workflow:\n\n' +
              '  - name: Report to Mergen\n    if: always()\n    run: |\n' +
              '      curl -s -X POST $MERGEN_URL/ci/generic \\\n' +
              '        -H "Content-Type: application/json" \\\n' +
              '        -d \'{"sha":"${{ github.sha }}","branch":"${{ github.ref_name }}",\' \\\n' +
              '           \'\"status":"${{ job.status }}","job":"${{ github.job }}"}\'\n\n' +
              'Or use: POST /ci/github, /ci/gitlab, /ci/generic, /deployments',
          }],
        };
      }

      const failures = events.filter((e) => e.status === 'failure');
      const lines    = [`## CI Results (${events.length} runs, ${failures.length} failure${failures.length !== 1 ? 's' : ''})`, ''];

      for (const e of events) {
        const ts   = new Date(e.timestamp).toISOString();
        const icon = e.status === 'success' ? '✅' : e.status === 'failure' ? '❌' : '⏭';
        const dur  = e.durationMs ? ` (${Math.round(e.durationMs / 1000)}s)` : '';
        lines.push(`${icon} **${e.job}** · ${e.shortSha ?? e.sha.slice(0, 7)} · ${e.branch ?? ''} · ${ts}${dur}`);
        if (e.workflow) lines.push(`   Workflow: ${e.workflow} (${e.provider})`);
        if (e.url)      lines.push(`   URL: ${e.url}`);
        if (e.failedTests && e.failedTests.length > 0) {
          lines.push(`   Failed tests (${e.failedTests.length}):`);
          for (const t of e.failedTests.slice(0, 10))
            lines.push(`     • ${t.name}${t.error ? ` — ${t.error.slice(0, 100)}` : ''}`);
        }
        lines.push('');
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  // ── get_deployments ────────────────────────────────────────────────────────
  server.registerTool(
    'get_deployments',
    {
      description:
        'Returns deployment events captured by Mergen. ' +
        'Use this to answer "when was this version deployed and who deployed it?" ' +
        'and to correlate browser errors with the specific deploy that introduced them.',
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional()
          .describe('Max results to return (default 10)'),
        environment: z.string().optional()
          .describe('Filter by environment name (e.g. "staging", "production")'),
        since: z.number().int().optional()
          .describe('Only return deployments after this Unix timestamp in ms'),
      },
    },
    async ({ limit, environment, since }) => {
      trackCall('get_deployments');
      const events = store.getDeployments(limit ?? 10, environment, since);

      if (events.length === 0) {
        return {
          content: [{
            type: 'text',
            text:
              'No deployment events in buffer.\n\nTo notify Mergen of a deploy:\n\n' +
              '  curl -X POST $MERGEN_URL/deployments \\\n' +
              '    -H "Content-Type: application/json" \\\n' +
              '    -d \'{"sha":"abc1234","environment":"staging","status":"success"}\'\n\n' +
              'Supported status values: started | success | failure | rollback',
          }],
        };
      }

      const lines = [`## Deployments (${events.length})`, ''];
      for (const d of events) {
        const ts   = new Date(d.timestamp).toISOString();
        const icon = d.status === 'success' ? '🚀' : d.status === 'failure' ? '💥' : d.status === 'rollback' ? '⏪' : '⏳';
        lines.push(`${icon} **${d.environment}** · ${d.shortSha ?? d.sha.slice(0, 7)} · ${d.status} · ${ts}`);
        if (d.service) lines.push(`   Service: ${d.service}`);
        if (d.version) lines.push(`   Version: ${d.version}`);
        if (d.actor)   lines.push(`   Actor: ${d.actor}`);
        if (d.url)     lines.push(`   URL: ${d.url}`);
        lines.push('');
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  // ── get_process_logs ───────────────────────────────────────────────────────
  server.registerTool(
    'get_process_logs',
    {
      description:
        'Returns stdout/stderr lines captured from local dev servers and containers. ' +
        'Use this when a browser error (e.g. fetch → 500) needs to be correlated with backend output. ' +
        'Filter by process_name to narrow to a specific service (e.g. "backend", "docker:api").',
      inputSchema: {
        limit: z.number().int().min(1).max(500).optional()
          .describe('Max lines to return (default 100)'),
        process_name: z.string().optional()
          .describe('Filter to a specific process or container name (partial match, e.g. "api", "docker:web")'),
        since: z.number().int().optional()
          .describe('Only return lines after this Unix timestamp in ms'),
        errors_only: z.boolean().optional()
          .describe('If true, only return lines matching error/exception/panic/fatal patterns'),
        max_tokens: z.number().int().min(100).max(10000).optional()
          .describe('Soft token limit for response'),
      },
    },
    async ({ limit, process_name, since, errors_only, max_tokens }) => {
      trackCall('get_process_logs');
      let events = store.getTerminalOutput(limit ?? 100, undefined, since);

      if (process_name) {
        const pat = process_name.toLowerCase();
        events = events.filter((e) => e.terminalName.toLowerCase().includes(pat));
      }

      if (errors_only) {
        const ERROR_RE = /error|exception|traceback|panic|fatal|unhandled|crash|killed|oom/i;
        events = events.filter((e) => ERROR_RE.test(e.data));
      }

      const processExits = store.getProcessExits(20, undefined, since);

      if (events.length === 0 && processExits.length === 0) {
        return {
          content: [{
            type: 'text',
            text:
              'No process logs in buffer.\n\n' +
              'To stream a dev server into Mergen:\n' +
              '  mergen-server watch npm start\n' +
              '  mergen-server watch python manage.py runserver\n\n' +
              'Or enable Docker log streaming: MERGEN_DOCKER_LOGS=true',
          }],
        };
      }

      const sources = [...new Set(events.map((e) => e.terminalName))];
      const lines   = events.map((e) => `[${new Date(e.timestamp).toISOString()}] [${e.terminalName}] ${e.data}`);

      for (const p of processExits) {
        lines.push(`[${new Date(p.timestamp).toISOString()}] [${p.process}] EXIT code=${p.exitCode} reason=${p.reason}${p.signal ? ' signal=' + p.signal : ''}`);
      }

      const header = `Process logs from: ${sources.join(', ')} (${events.length} lines)\n\n`;
      const { result, truncated, omitted } = truncateToTokenBudget(lines, max_tokens, '\n');
      if (truncated) logger.info({ tool: 'get_process_logs', omitted }, 'response truncated');

      return { content: [{ type: 'text', text: header + result }] };
    },
  );

  // ── get_code_owners ────────────────────────────────────────────────────────
  server.registerTool(
    'get_code_owners',
    {
      description:
        'Looks up the CODEOWNERS entry for a given file path. ' +
        'Use this after finding a suspect commit to identify which team owns the file ' +
        'and who to page or assign the bug to. ' +
        'Reads .github/CODEOWNERS, CODEOWNERS, or docs/CODEOWNERS from the working directory.',
      inputSchema: {
        file_path: z.string()
          .describe('Relative or absolute file path to look up (e.g. "src/auth/token.ts")'),
        cwd: z.string().optional()
          .describe('Working directory to search for CODEOWNERS (defaults to process.cwd())'),
      },
    },
    withTierGate(getTierForTool('get_code_owners'), async ({ file_path, cwd }) => {
      trackCall('get_code_owners');
      const { findCodeOwners } = await import('../sensor/git-suspect.js');
      const result = findCodeOwners(file_path, cwd ?? process.cwd());

      if (!result) {
        return {
          content: [{
            type: 'text',
            text:
              `No CODEOWNERS entry found for \`${file_path}\`.\n\n` +
              `Either no CODEOWNERS file exists in this repo, or the file doesn't match any pattern.\n` +
              `CODEOWNERS should be at .github/CODEOWNERS, CODEOWNERS, or docs/CODEOWNERS.`,
          }],
        };
      }

      return {
        content: [{
          type: 'text',
          text: [
            `## Code Owners for \`${file_path}\``, '',
            `**Owners:** ${result.owners.join(', ')}`,
            `**Matched pattern:** \`${result.pattern}\``,
            `**Source:** \`${result.source}\``, '',
            `These are the teams/individuals responsible for this file.`,
            `Tag them in the bug report or assign the fix to their queue.`,
          ].join('\n'),
        }],
      };
    }),
  );

  // ── get_backend_logs ───────────────────────────────────────────────────────
  server.registerTool(
    'get_backend_logs',
    {
      description:
        'Returns structured log events from Node.js or Python backend SDKs. ' +
        'Events come from services instrumented with mergen-node or mergen-python. ' +
        'Use service to filter to a specific backend service by name. ' +
        'Use sdk to filter to node or python events only.',
      inputSchema: {
        service: z.string().optional().describe('Filter by service name (MERGEN_NAME env var)'),
        sdk: z.enum(['node', 'python']).optional().describe('Filter to a specific SDK'),
        level: z.enum(['log', 'warn', 'error']).optional().describe('Filter by log level'),
        since: z.number().int().optional().describe('Only return events after this Unix ms timestamp'),
        limit: z.number().int().min(1).max(200).optional().describe('Max events (default 50)'),
      },
    },
    withTierGate(getTierForTool('get_backend_logs'), async ({ service, sdk, level, since, limit }) => {
      trackCall('get_backend_logs');
      let events = store.getLogs(limit ?? 50, level as LogLevel | undefined, since);
      events = events.filter(e =>
        e.url?.startsWith('mergen://node/') || e.url?.startsWith('mergen://python/'),
      );
      if (service) events = events.filter(e => e.url?.includes(`/${service}`));
      if (sdk === 'node')   events = events.filter(e => e.url?.startsWith('mergen://node/'));
      if (sdk === 'python') events = events.filter(e => e.url?.startsWith('mergen://python/'));

      if (events.length === 0) {
        return { content: [{ type: 'text', text: 'No backend log events. Instrument your service with mergen-node or mergen-python.' }] };
      }

      const lines = events.map(e => {
        const ts       = new Date(e.timestamp).toISOString();
        const svcLabel = e.url?.split('/').slice(2).join('/') ?? 'backend';
        const args     = e.args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
        const stack    = e.stack ? `\n  Stack: ${e.stack}` : '';
        return `[${ts}] [${e.level.toUpperCase()}] [${svcLabel}] ${args}${stack}`;
      });

      return { content: [{ type: 'text', text: `${events.length} backend log event(s):\n\n${lines.join('\n')}` }] };
    }),
  );

  // ── get_backend_spans ──────────────────────────────────────────────────────
  server.registerTool(
    'get_backend_spans',
    {
      description:
        'Returns server-side request spans from Node.js or Python SDK middleware. ' +
        'Each span covers one inbound HTTP request: route, method, status, duration, traceId. ' +
        'The traceId links this span to the matching browser network event for end-to-end tracing. ' +
        'Use get_correlated_trace after finding a traceId to see the full round-trip.',
      inputSchema: {
        service: z.string().optional().describe('Filter by service name'),
        trace_id: z.string().optional().describe('Filter to a specific 32-char hex traceId'),
        status_filter: z.number().int().optional().describe('Filter to a specific HTTP status code (e.g. 500)'),
        since: z.number().int().optional().describe('Only return spans after this Unix ms timestamp'),
        limit: z.number().int().min(1).max(200).optional().describe('Max spans (default 50)'),
      },
    },
    async ({ service, trace_id, status_filter, since, limit }) => {
      trackCall('get_backend_spans');
      if (!getPlan(getActivePlanId()).backendObservability) {
        return {
          content: [{ type: 'text', text:
            `⛔ **Backend span tracing** is a Pro feature.\n\n` +
            `Upgrade to **Pro ($29/mo)** for OTLP export, backend spans, and end-to-end trace correlation.\n\n` +
            `→ https://mergen.dev/pricing`,
          }],
          isError: true,
        };
      }
      let spans = store.getBackendSpans(limit ?? 50, service, since);
      if (trace_id)         spans = spans.filter(s => s.traceId.toLowerCase() === trace_id.toLowerCase());
      if (status_filter !== undefined) spans = spans.filter(s => s.statusCode === status_filter);

      if (spans.length === 0) {
        return { content: [{ type: 'text', text: 'No backend spans. Add mergen-node Express middleware or mergen-python Django/FastAPI middleware to capture server spans.' }] };
      }

      const browserTraceIds = new Set(store.getNetwork(200).filter(n => n.traceId).map(n => n.traceId as string));

      const lines = spans.map(s => {
        const ts     = new Date(s.timestamp).toISOString();
        const flag   = s.statusCode >= 500 ? ' [CRITICAL]' : s.statusCode >= 400 ? ' [ERROR]' : '';
        const joined = browserTraceIds.has(s.traceId) ? ' [JOINED→browser]' : '';
        const err    = s.error ? ` — ${s.error}` : '';
        return `[${ts}] [${s.sdk}:${s.service}] ${s.method} ${s.route} → ${s.statusCode} (${s.durationMs}ms)${flag}${joined}${err}\n  traceId: ${s.traceId}`;
      });

      return { content: [{ type: 'text', text: `${spans.length} backend span(s):\n\n${lines.join('\n\n')}` }] };
    },
  );

  // ── get_correlated_trace ───────────────────────────────────────────────────
  server.registerTool(
    'get_correlated_trace',
    {
      description:
        'Given a traceId, returns ALL events that share it: the browser fetch/XHR event, ' +
        'the matching backend span, and any backend log lines that logged the same traceId. ' +
        'This gives a deterministic end-to-end view of one request as it traveled from browser to server. ' +
        'Use after get_backend_spans or get_network_activity shows a traceId of interest.',
      inputSchema: {
        trace_id: z.string().describe('32-char hex traceId from a network event or backend span'),
      },
    },
    async ({ trace_id }) => {
      trackCall('get_correlated_trace');
      if (!getPlan(getActivePlanId()).backendObservability) {
        return {
          content: [{ type: 'text', text:
            `⛔ **End-to-end trace correlation** is a Pro feature.\n\n` +
            `Upgrade to **Pro ($29/mo)** for backend spans and browser-to-server trace correlation.\n\n` +
            `→ https://mergen.dev/pricing`,
          }],
          isError: true,
        };
      }

      const traceId = trace_id.toLowerCase().replace(/-/g, '');
      if (!/^[0-9a-f]{32}$/.test(traceId)) {
        return { content: [{ type: 'text', text: 'Invalid traceId — must be a 32-char hex string.' }] };
      }

      const browserNet   = store.getNetwork(200).filter(n => n.traceId?.toLowerCase() === traceId);
      const backendSpans = store.getBackendSpans(50).filter(s => s.traceId.toLowerCase() === traceId);
      const backendLogs  = store.getTerminalOutput(200).filter(t => t.traceId?.toLowerCase() === traceId);

      if (browserNet.length === 0 && backendSpans.length === 0 && backendLogs.length === 0) {
        return { content: [{ type: 'text', text: `No events found for traceId ${traceId}. The trace may have expired from the buffer.` }] };
      }

      const lines: string[] = [`Correlated trace: ${traceId}\n`];

      if (browserNet.length > 0) {
        lines.push('── Browser (fetch/XHR) ──');
        for (const n of browserNet) {
          lines.push(`[${new Date(n.timestamp).toISOString()}] ${n.method} ${n.url} → ${n.status} ${n.statusText} (${n.duration}ms)`);
          if (n.error)        lines.push(`  Error: ${n.error}`);
          if (n.responseBody) lines.push(`  Response: ${JSON.stringify(n.responseBody).slice(0, 300)}`);
        }
        lines.push('');
      }

      if (backendSpans.length > 0) {
        lines.push('── Backend spans ──');
        for (const s of backendSpans) {
          lines.push(`[${new Date(s.timestamp).toISOString()}] [${s.sdk}:${s.service}] ${s.method} ${s.route} → ${s.statusCode} (${s.durationMs}ms)`);
          if (s.error)  lines.push(`  Error: ${s.error}`);
          if (s.userId) lines.push(`  UserId: ${s.userId}`);
        }
        lines.push('');
      }

      if (backendLogs.length > 0) {
        lines.push('── Backend log lines (traceId extracted from stdout) ──');
        for (const t of backendLogs)
          lines.push(`[${new Date(t.timestamp).toISOString()}] [${t.terminalName}] ${t.data.slice(0, 300)}`);
      }

      const joinStatus = browserNet.length > 0 && backendSpans.length > 0
        ? '✅ EXACT JOIN — browser request matched to backend span'
        : browserNet.length > 0
          ? '⚠️  PARTIAL — browser event found, no backend span (SDK not instrumented?)'
          : '⚠️  PARTIAL — backend span found, no browser event';

      lines.push('', joinStatus);

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );
}

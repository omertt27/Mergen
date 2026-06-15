import { planAllowsTier, type ToolTier } from './plans.js';
import { getActivePlanId } from './license.js';

export const KNOWN_TOOLS = new Set([
  // Analysis
  'quick_check', 'explain_warning', 'session_summary', 'analyze_runtime', 'reconstruct_context',
  'explain_why', 'get_change_timeline',
  'get_error_frequency', 'get_anomaly_baseline', 'get_regression_start', 'get_repro_steps',
  'get_causal_graph',
  // Buffer reads
  'get_recent_logs', 'get_network_activity', 'get_dom_context',
  'get_component_tree', 'get_diagnostics', 'get_test_results',
  'get_snapshots', 'get_websocket_activity', 'get_sse_activity', 'get_service_topology',
  // Backend / infra
  'get_process_logs', 'get_backend_logs', 'get_backend_spans', 'get_correlated_trace',
  'get_ci_results', 'get_deployments', 'get_unified_timeline',
  // Blast radius
  'get_blast_radius', 'get_code_owners', 'get_attribution_accuracy',
  // Incidents
  'triage_incident', 'execute_fix', 'validate_fix',
  'get_incident_history', 'list_open_incidents',
  // Datadog
  'get_incident_context', 'get_datadog_trace', 'get_datadog_logs',
  // Debug sessions
  'inject_logpoint', 'remove_logpoint',
  'start_debug_session', 'checkpoint_debug_session', 'end_debug_session',
  // Runbook / postmortem
  'create_postmortem', 'list_postmortems',
  'check_fix_history', 'explain_service', 'generate_runbook', 'search_postmortems', 'draft_postmortem',
  // Sessions / audit
  'get_session_replay', 'get_audit_log',
  // Memory
  'store_agent_memory', 'recall_agent_memory',
  // Intent
  'create_ticket',
  // Utility
  'clear_buffer', 'get_status', 'mark_capture_start', 'export_session', 'suggest_logging_locations',
  'watch_for_fix', 'stop_file_watch',
]);

export const toolCallCounts: Record<string, number> = {};
export let lastMcpCallAt: number | null = null;
export let firstAnalyzeAt: number | null = null;
export let lastTimeToFirstAnalysisMs: number | null = null;
let _lastClearAt: number = Date.now();

// ── Agent vs human call classification ──────────────────────────────────────
// Autonomous agent loops make many rapid-fire calls; human-in-IDE interaction
// is slower. A burst of ≥5 MCP calls within a 10-second window is classified
// as an agent loop. Both counters are cumulative since server start.
export let humanCallCount = 0;
export let agentCallCount = 0;
const AGENT_BURST_WINDOW_MS  = 10_000;
const AGENT_BURST_THRESHOLD  = 5;
const _recentCallTs: number[] = [];   // sliding window, max AGENT_BURST_THRESHOLD+1 entries

export function getAgentCallRatio(): number {
  const total = humanCallCount + agentCallCount;
  return total > 0 ? agentCallCount / total : 0;
}

export function trackCall(tool: string): void {
  if (!KNOWN_TOOLS.has(tool)) return;
  const now = Date.now();
  lastMcpCallAt = now;
  toolCallCounts[tool] = (toolCallCounts[tool] ?? 0) + 1;

  // Maintain a sliding window of recent call timestamps
  _recentCallTs.push(now);
  while (_recentCallTs.length > 0 && now - _recentCallTs[0] > AGENT_BURST_WINDOW_MS) {
    _recentCallTs.shift();
  }
  if (_recentCallTs.length >= AGENT_BURST_THRESHOLD) {
    agentCallCount++;
  } else {
    humanCallCount++;
  }
}

export function buildCreditBar(used: number, total: number): string {
  const pct = Math.min(1, used / total);
  const filled = Math.round(pct * 10);
  return `[${'█'.repeat(filled)}${'░'.repeat(10 - filled)}] ${Math.round(pct * 100)}%`;
}

export function setFirstAnalyzeAt(ts: number): void { firstAnalyzeAt = ts; }
export function setLastTimeToFirstAnalysisMs(ms: number): void { lastTimeToFirstAnalysisMs = ms; }
export function setLastClearAt(ts: number): void { _lastClearAt = ts; }
export function getLastClearAt(): number { return _lastClearAt; }

// ── Tier gating ──────────────────────────────────────────────────────────────

type McpResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
type ToolHandler<A extends unknown[]> = (...args: A) => Promise<McpResult>;

/**
 * Wraps a tool handler with a plan-tier check.
 *
 * Usage in tools.ts:
 *   server.registerTool('execute_fix', schema, withTierGate('pro', async (args) => { ... }))
 *
 * Free-plan callers receive a structured upgrade prompt instead of an error —
 * the AI can surface the message directly to the user.
 */
export function withTierGate<A extends unknown[]>(
  tier: ToolTier,
  handler: ToolHandler<A>,
): ToolHandler<A> {
  if (tier === 'free' || tier === 'all') return handler;

  return async (...args: A): Promise<McpResult> => {
    const planId = getActivePlanId();
    if (!planAllowsTier(planId, tier)) {
      return {
        content: [{
          type: 'text',
          text: [
            `## Tool unavailable on Free plan`,
            '',
            'This tool requires a paid Mergen plan.',
            '',
            '**Upgrade at:** https://mergen.dev/pricing',
            '',
            'To check your current plan: call `get_status`.',
            'To activate a license key: `POST /license { "key": "..." }`',
          ].join('\n'),
        }],
      };
    }
    return handler(...args);
  };
}

const KNOWN_TOOLS = new Set([
  'quick_check', 'explain_warning', 'session_summary', 'analyze_runtime', 'reconstruct_context',
  'get_recent_logs', 'get_network_activity', 'get_dom_context', 'clear_buffer', 'get_status',
  'get_change_timeline', 'explain_why',
  'get_component_tree', 'suggest_logging_locations', 'get_diagnostics', 'get_test_results',
  'mark_capture_start', 'export_session', 'get_process_logs', 'get_ci_results', 'get_deployments', 'get_unified_timeline', 'get_code_owners',
  'get_error_frequency', 'get_anomaly_baseline', 'get_regression_start', 'get_repro_steps', 'create_ticket',
  'get_backend_logs', 'get_backend_spans', 'get_correlated_trace',
  'get_snapshots', 'inject_logpoint', 'remove_logpoint',
  'get_incident_history', 'list_open_incidents',
  'store_agent_memory', 'recall_agent_memory',
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

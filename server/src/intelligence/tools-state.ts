const KNOWN_TOOLS = new Set([
  'quick_check', 'explain_warning', 'session_summary', 'analyze_runtime', 'reconstruct_context',
  'get_recent_logs', 'get_network_activity', 'get_dom_context', 'clear_buffer', 'get_status',
  'get_change_timeline', 'explain_why',
  'get_component_tree', 'suggest_logging_locations', 'get_diagnostics', 'get_test_results',
  'mark_capture_start', 'export_session', 'get_process_logs', 'get_ci_results', 'get_deployments', 'get_unified_timeline', 'get_code_owners',
  'get_error_frequency', 'get_anomaly_baseline', 'get_regression_start', 'get_repro_steps', 'create_ticket',
  'get_backend_logs', 'get_backend_spans', 'get_correlated_trace',
  'get_snapshots', 'inject_logpoint', 'remove_logpoint',
]);

export const toolCallCounts: Record<string, number> = {};
export let lastMcpCallAt: number | null = null;
export let firstAnalyzeAt: number | null = null;
export let lastTimeToFirstAnalysisMs: number | null = null;
let _lastClearAt: number = Date.now();

export function trackCall(tool: string): void {
  if (!KNOWN_TOOLS.has(tool)) return;
  lastMcpCallAt = Date.now();
  toolCallCounts[tool] = (toolCallCounts[tool] ?? 0) + 1;
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

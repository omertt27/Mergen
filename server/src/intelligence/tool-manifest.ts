/**
 * tool-manifest.ts — Canonical list of every MCP tool registered by Mergen.
 *
 * New-engineer audit: scan this file to see every tool at a glance.
 * Each entry names the tool, its registration module, and its tier access.
 *
 * Tool registration happens in the closed-source tools.ts (gitignored commercial
 * layer). This file is the open-source contract: if a tool name appears here,
 * it must be registered there and vice versa.
 */

export interface ToolEntry {
  name: string;
  module: string;
  tier: 'free' | 'pro' | 'all';
}

/** All MCP tools exposed to AI IDEs. */
export const ALL_TOOLS: readonly ToolEntry[] = [
  // ── Core analysis ─────────────────────────────────────────────────────────
  { name: 'reconstruct_context',      module: 'tools-analysis',       tier: 'all'  },
  { name: 'analyze_runtime',          module: 'tools-analysis',       tier: 'all'  },
  { name: 'quick_check',              module: 'tools-analysis',       tier: 'free' },
  { name: 'explain_warning',          module: 'tools-analysis',       tier: 'free' },
  { name: 'session_summary',          module: 'tools-analysis',       tier: 'free' },
  { name: 'explain_why',              module: 'tools-intent',         tier: 'free' },
  { name: 'get_causal_graph',         module: 'tools-analysis',       tier: 'all'  },

  // ── Buffer reads ──────────────────────────────────────────────────────────
  { name: 'get_recent_logs',          module: 'tools-browser',        tier: 'all'  },
  { name: 'get_network_activity',     module: 'tools-browser',        tier: 'all'  },
  { name: 'get_dom_context',          module: 'tools-browser',        tier: 'all'  },
  { name: 'get_component_tree',       module: 'tools-browser',        tier: 'pro'  },
  { name: 'get_diagnostics',          module: 'tools-utility',        tier: 'all'  },
  { name: 'get_test_results',         module: 'tools-utility',        tier: 'all'  },
  { name: 'get_snapshots',            module: 'tools-utility',        tier: 'all'  },
  { name: 'get_websocket_activity',   module: 'tools-browser',        tier: 'pro'  },
  { name: 'get_sse_activity',         module: 'tools-browser',        tier: 'pro'  },
  { name: 'get_service_topology',     module: 'tools-browser',        tier: 'all'  },

  // ── Backend / infra ────────────────────────────────────────────────────────
  { name: 'get_process_logs',         module: 'tools-infra',          tier: 'all'  },
  { name: 'get_backend_logs',         module: 'tools-infra',          tier: 'pro'  },
  { name: 'get_backend_spans',        module: 'tools-infra',          tier: 'pro'  },
  { name: 'get_correlated_trace',     module: 'tools-infra',          tier: 'pro'  },
  { name: 'get_ci_results',           module: 'tools-infra',          tier: 'all'  },
  { name: 'get_deployments',          module: 'tools-infra',          tier: 'all'  },
  { name: 'get_unified_timeline',     module: 'tools-infra',          tier: 'pro'  },
  { name: 'get_service_graph',        module: 'tools-infra',          tier: 'all'  },
  { name: 'get_code_owners',          module: 'tools-infra',          tier: 'pro'  },

  // ── Blast radius ───────────────────────────────────────────────────────────
  { name: 'get_blast_radius',         module: 'tools-blast-radius',   tier: 'pro'  },
  { name: 'get_attribution_accuracy', module: 'tools-blast-radius',   tier: 'pro'  },

  // ── Frequency / baseline ──────────────────────────────────────────────────
  { name: 'get_error_frequency',      module: 'tools-analysis',       tier: 'all'  },
  { name: 'get_anomaly_baseline',     module: 'tools-analysis',       tier: 'all'  },
  { name: 'get_regression_start',     module: 'tools-analysis',       tier: 'all'  },
  { name: 'get_repro_steps',          module: 'tools-analysis',       tier: 'all'  },

  // ── Change timeline ───────────────────────────────────────────────────────
  { name: 'get_change_timeline',      module: 'tools-change-timeline', tier: 'all' },

  // ── Incidents ─────────────────────────────────────────────────────────────
  { name: 'triage_incident',          module: 'tools-autonomy',       tier: 'all'  },
  { name: 'execute_fix',              module: 'tools-autonomy',       tier: 'pro'  },
  { name: 'validate_fix',             module: 'tools-validate',       tier: 'all'  },
  { name: 'watch_for_fix',            module: 'tools-validate',       tier: 'all'  },
  { name: 'stop_file_watch',          module: 'tools-validate',       tier: 'all'  },
  { name: 'get_incident_history',     module: 'tools-memory',         tier: 'all'  },
  { name: 'list_open_incidents',      module: 'tools-memory',         tier: 'all'  },

  // ── Datadog ───────────────────────────────────────────────────────────────
  { name: 'get_incident_context',     module: 'tools-datadog',        tier: 'free' },
  { name: 'get_datadog_trace',        module: 'tools-datadog',        tier: 'pro'  },
  { name: 'get_datadog_logs',         module: 'tools-datadog',        tier: 'pro'  },

  // ── Debug sessions ────────────────────────────────────────────────────────
  { name: 'start_debug_session',      module: 'tools-debug-sessions', tier: 'free' },
  { name: 'checkpoint_debug_session', module: 'tools-debug-sessions', tier: 'free' },
  { name: 'end_debug_session',        module: 'tools-debug-sessions', tier: 'free' },
  { name: 'inject_logpoint',          module: 'tools-utility',        tier: 'pro'  },
  { name: 'remove_logpoint',          module: 'tools-utility',        tier: 'pro'  },

  // ── Runbook / postmortem ──────────────────────────────────────────────────
  { name: 'check_fix_history',        module: 'tools-runbook',        tier: 'all'  },
  { name: 'explain_service',          module: 'tools-runbook',        tier: 'all'  },
  { name: 'generate_runbook',         module: 'tools-runbook',        tier: 'pro'  },
  { name: 'search_postmortems',       module: 'tools-runbook',        tier: 'pro'  },
  { name: 'draft_postmortem',         module: 'tools-runbook',        tier: 'pro'  },
  { name: 'create_postmortem',        module: 'tools-runbook',        tier: 'pro'  },
  { name: 'list_postmortems',         module: 'tools-runbook',        tier: 'pro'  },
  { name: 'start_runbook',            module: 'tools-runbook',        tier: 'all'  },
  { name: 'suggest_followups',        module: 'tools-runbook',        tier: 'all'  },
  { name: 'find_similar_incidents',   module: 'tools-runbook',        tier: 'pro'  },

  // ── Sessions / audit ──────────────────────────────────────────────────────
  { name: 'get_session_replay',       module: 'tools-sessions',       tier: 'all'  },
  { name: 'get_audit_log',            module: 'tools-sessions',       tier: 'pro'  },

  // ── Agent memory + operational knowledge ─────────────────────────────────
  { name: 'store_agent_memory',       module: 'tools-memory',         tier: 'all'  },
  { name: 'recall_agent_memory',      module: 'tools-memory',         tier: 'all'  },
  { name: 'get_override_patterns',    module: 'tools-memory',         tier: 'all'  },
  { name: 'get_detector_calibration', module: 'tools-memory',         tier: 'all'  },

  // ── Intent / tickets ─────────────────────────────────────────────────────
  { name: 'create_ticket',            module: 'tools-utility',        tier: 'pro'  },

  // ── Utility ───────────────────────────────────────────────────────────────
  { name: 'clear_buffer',             module: 'tools-utility',        tier: 'all'  },
  { name: 'get_status',               module: 'tools-utility',        tier: 'all'  },
  { name: 'mark_capture_start',       module: 'tools-utility',        tier: 'all'  },
  { name: 'export_session',           module: 'tools-utility',        tier: 'all'  },
  { name: 'suggest_logging_locations', module: 'tools-utility',       tier: 'all'  },

  // ── ADR / discovery / agent workflow ─────────────────────────────────────
  { name: 'search_adrs',              module: 'tools-utility',        tier: 'all'  },
  { name: 'discover_repo_context',    module: 'tools-discovery',      tier: 'all'  },
  { name: 'get_buffer_schema',        module: 'tools-discovery',      tier: 'all'  },
  { name: 'report_confidence',        module: 'tools-utility',        tier: 'all'  },
  { name: 'plan_rollback',            module: 'tools-utility',        tier: 'all'  },

  // ── Architectural governance ──────────────────────────────────────────────
  { name: 'check_arch_violations',    module: 'tools-arch',           tier: 'all'  },
  { name: 'score_change_risk',        module: 'tools-arch',           tier: 'all'  },
  { name: 'query_arch_graph',         module: 'tools-arch',           tier: 'all'  },
  { name: 'critique_implementation',  module: 'tools-arch',           tier: 'all'  },
] as const;

export const ALL_TOOL_NAMES: readonly string[] = ALL_TOOLS.map((t) => t.name);

const _tierMap = new Map<string, ToolEntry['tier']>(ALL_TOOLS.map((t) => [t.name, t.tier]));

/**
 * Returns the tier required to call a tool, or 'all' if not found.
 * Use this in tools.ts to avoid hardcoding tiers in two places:
 *
 *   server.registerTool(name, schema, withTierGate(getTierForTool(name), handler))
 */
export function getTierForTool(name: string): ToolEntry['tier'] {
  return _tierMap.get(name) ?? 'all';
}

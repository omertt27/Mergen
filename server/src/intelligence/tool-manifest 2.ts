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
  { name: 'reconstruct_context',    module: 'tools-analysis',       tier: 'all'  },
  { name: 'analyze_runtime',        module: 'tools-analysis',       tier: 'all'  },
  { name: 'quick_check',            module: 'tools-sessions',       tier: 'free' },
  { name: 'explain_warning',        module: 'tools-sessions',       tier: 'free' },
  { name: 'session_summary',        module: 'tools-sessions',       tier: 'free' },
  { name: 'explain_why',            module: 'tools-sessions',       tier: 'free' },

  // ── Buffer reads ──────────────────────────────────────────────────────────
  { name: 'get_recent_logs',        module: 'tools-browser',        tier: 'all'  },
  { name: 'get_network_activity',   module: 'tools-browser',        tier: 'all'  },
  { name: 'get_dom_context',        module: 'tools-browser',        tier: 'all'  },
  { name: 'get_component_tree',     module: 'tools-browser',        tier: 'pro'  },
  { name: 'get_diagnostics',        module: 'tools-browser',        tier: 'all'  },
  { name: 'get_test_results',       module: 'tools-browser',        tier: 'all'  },
  { name: 'get_snapshots',          module: 'tools-debug-sessions', tier: 'all'  },
  { name: 'get_websockets',         module: 'tools-browser',        tier: 'pro'  },
  { name: 'get_sse',                module: 'tools-browser',        tier: 'pro'  },

  // ── Backend / infra ────────────────────────────────────────────────────────
  { name: 'get_process_logs',       module: 'tools-infra',          tier: 'all'  },
  { name: 'get_backend_logs',       module: 'tools-infra',          tier: 'pro'  },
  { name: 'get_backend_spans',      module: 'tools-infra',          tier: 'pro'  },
  { name: 'get_correlated_trace',   module: 'tools-infra',          tier: 'pro'  },
  { name: 'get_ci_results',         module: 'tools-infra',          tier: 'all'  },
  { name: 'get_deployments',        module: 'tools-infra',          tier: 'all'  },
  { name: 'get_unified_timeline',   module: 'tools-infra',          tier: 'pro'  },

  // ── Blast radius ───────────────────────────────────────────────────────────
  { name: 'get_blast_radius',       module: 'tools-blast-radius',   tier: 'pro'  },
  { name: 'get_code_owners',        module: 'tools-blast-radius',   tier: 'pro'  },

  // ── Frequency / baseline ──────────────────────────────────────────────────
  { name: 'get_error_frequency',    module: 'tools-analysis',       tier: 'all'  },
  { name: 'get_anomaly_baseline',   module: 'tools-analysis',       tier: 'all'  },
  { name: 'get_regression_start',   module: 'tools-analysis',       tier: 'all'  },
  { name: 'get_repro_steps',        module: 'tools-analysis',       tier: 'all'  },

  // ── Change timeline ───────────────────────────────────────────────────────
  { name: 'get_change_timeline',    module: 'tools-change-timeline', tier: 'all' },

  // ── Incidents ─────────────────────────────────────────────────────────────
  { name: 'triage_incident',        module: 'tools-autonomy',       tier: 'all'  },
  { name: 'execute_fix',            module: 'tools-autonomy',       tier: 'pro'  },
  { name: 'validate_fix',           module: 'tools-validate',       tier: 'all'  },
  { name: 'get_incident_history',   module: 'tools-autonomy',       tier: 'all'  },
  { name: 'list_open_incidents',    module: 'tools-autonomy',       tier: 'all'  },

  // ── Datadog ───────────────────────────────────────────────────────────────
  { name: 'get_incident_context',   module: 'tools-datadog',        tier: 'free' },
  { name: 'get_datadog_trace',      module: 'tools-datadog',        tier: 'pro'  },
  { name: 'get_datadog_logs',       module: 'tools-datadog',        tier: 'pro'  },

  // ── Debug sessions ────────────────────────────────────────────────────────
  { name: 'inject_logpoint',        module: 'tools-debug-sessions', tier: 'pro'  },
  { name: 'remove_logpoint',        module: 'tools-debug-sessions', tier: 'pro'  },

  // ── Runbook / postmortem ──────────────────────────────────────────────────
  { name: 'create_postmortem',      module: 'tools-runbook',        tier: 'pro'  },
  { name: 'list_postmortems',       module: 'tools-runbook',        tier: 'pro'  },

  // ── Agent memory ──────────────────────────────────────────────────────────
  { name: 'store_agent_memory',     module: 'tools-memory',         tier: 'all'  },
  { name: 'recall_agent_memory',    module: 'tools-memory',         tier: 'all'  },

  // ── Intent / tickets ─────────────────────────────────────────────────────
  { name: 'create_ticket',          module: 'tools-intent',         tier: 'pro'  },

  // ── Utility ───────────────────────────────────────────────────────────────
  { name: 'clear_buffer',           module: 'tools-utility',        tier: 'all'  },
  { name: 'get_status',             module: 'tools-utility',        tier: 'all'  },
  { name: 'mark_capture_start',     module: 'tools-utility',        tier: 'all'  },
  { name: 'export_session',         module: 'tools-utility',        tier: 'all'  },
  { name: 'suggest_logging_locations', module: 'tools-utility',     tier: 'all'  },
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

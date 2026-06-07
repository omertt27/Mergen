/**
 * action-risk.ts — Command risk tier classifier for staged autopilot.
 *
 * Autopilot level controls which risk tier of commands can execute autonomously.
 * Set MERGEN_AUTOPILOT_LEVEL to one of:
 *
 *   restarts  — only service restarts and reloads (safest, recommended first)
 *   deploys   — restarts + rollbacks + dependency pins + image updates
 *   full      — everything that passes the blocklist (default)
 *
 * This gives enterprises a ramp-up path: start with `restarts`, watch the
 * override corpus for 30 days, promote to `deploys`, then `full`. The
 * confidence gate (85%) still applies at all levels.
 *
 * Why categorical tiers and not per-command allowlists?
 * Because allowlists require maintenance as commands evolve. A tier classifier
 * uses structural pattern matching — "does this look like a restart?" — which
 * generalises across different process managers without explicit enumeration.
 */

// ── Risk tiers ────────────────────────────────────────────────────────────────

/** Risk tier of a single command. Lower = safer. */
export type CommandRiskTier = 'restart' | 'deploy' | 'full';

/**
 * Autopilot level — which risk tiers are permitted for autonomous execution.
 * Maps to MERGEN_AUTOPILOT_LEVEL env var.
 */
export type AutopilotLevel = 'restarts' | 'deploys' | 'full';

// ── Pattern sets ──────────────────────────────────────────────────────────────

/** Commands that only restart or reload a running service. No code/config change. */
const RESTART_PATTERNS: RegExp[] = [
  /\bpm2\s+(restart|reload|gracefulReload)\b/i,
  /\bkubectl\s+rollout\s+restart\b/i,
  /\bsystemctl\s+(restart|reload|try-restart)\b/i,
  /\bservice\s+\S+\s+(restart|reload)\b/i,
  /\bdocker\s+(restart|stop\s+.*&&\s*docker\s+start)\b/i,
  /\bsupervisorctl\s+(restart|reload|reread|update)\b/i,
  /\bnginx\s+-s\s+(reload|reopen)\b/i,
  /\bapache2ctl\s+graceful\b/i,
  /\bkill\s+-(?:HUP|1)\b/i,
  /\bpkill\s+-(?:HUP|1)\b/i,
  /\bheroku\s+ps:restart\b/i,
  /\bflyctl\s+machine\s+restart\b/i,
  /\brailway\s+redeploy\b/i,
  /\bgunicorn\s+.*--reload\b/i,
  /\bunicorn_rails\s+.*-s\s+HUP\b/i,
];

/**
 * Commands that change the running version or pinned dependencies.
 * Higher risk than restarts but still reversible without data loss.
 * Includes everything in RESTART_PATTERNS.
 */
const DEPLOY_PATTERNS: RegExp[] = [
  ...RESTART_PATTERNS,
  /\bkubectl\s+rollout\s+undo\b/i,                      // rollback deployment
  /\bkubectl\s+set\s+image\b/i,                         // update container image
  /\bkubectl\s+set\s+env\b/i,                           // set env var on deployment
  /\bhelm\s+(upgrade|rollback)\b/i,                     // helm change
  /\bnpm\s+install\s+\S+@\S+/i,                         // pin a dep to specific version
  /\bpip\s+install\s+\S+==\S+/i,
  /\bpip\s+install\s+--upgrade\s+\S+/i,
  /\byarn\s+add\s+\S+@\S+/i,
  /\bgem\s+install\s+\S+\s+-v\s+\S+/i,
  /\bgit\s+checkout\s+\S+\s+--\s+\S+/i,                // revert a specific file
  /\bgit\s+revert\s+[a-f0-9]{7}/i,                      // git revert a commit
  /\baws\s+ecs\s+update-service\b/i,
  /\bgcloud\s+(app|run)\s+deploy\b/i,
  /\baz\s+(webapp|containerapp)\s+(restart|update)\b/i,
  /\bdocker-compose\s+(restart|up\s+--force-recreate)\b/i,
];

// ── Tier order for numeric comparison ─────────────────────────────────────────

const RISK_TIER_ORDER: Record<CommandRiskTier, number> = {
  restart: 0,
  deploy:  1,
  full:    2,
};

const LEVEL_ORDER: Record<AutopilotLevel, number> = {
  restarts: 0,
  deploys:  1,
  full:     2,
};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Classify a command string into a risk tier.
 * Returns 'restart' for pure service restarts, 'deploy' for version/dep changes,
 * and 'full' for anything else (env changes, schema migrations, etc.).
 */
export function classifyCommandRisk(command: string): CommandRiskTier {
  if (RESTART_PATTERNS.some((p) => p.test(command))) return 'restart';
  if (DEPLOY_PATTERNS.some((p) => p.test(command)))  return 'deploy';
  return 'full';
}

/**
 * Returns true if the command's risk tier is within the configured autopilot level.
 *
 * level=restarts → only 'restart' tier commands
 * level=deploys  → 'restart' and 'deploy' tier commands
 * level=full     → all commands (same as before this feature existed)
 */
export function autopilotLevelPermits(command: string, level: AutopilotLevel): boolean {
  const risk = classifyCommandRisk(command);
  return RISK_TIER_ORDER[risk] <= LEVEL_ORDER[level];
}

/**
 * Parse MERGEN_AUTOPILOT_LEVEL env var. Defaults to 'full' if unset or invalid.
 * 'full' preserves backwards-compatible behaviour for existing deployments.
 */
export function getAutopilotLevel(): AutopilotLevel {
  const raw = process.env.MERGEN_AUTOPILOT_LEVEL;
  if (raw === 'restarts' || raw === 'deploys' || raw === 'full') return raw;
  return 'full';
}

/** Human-readable description of what a level permits (for Slack messages). */
export function autopilotLevelDescription(level: AutopilotLevel): string {
  switch (level) {
    case 'restarts': return 'service restarts and reloads only';
    case 'deploys':  return 'restarts, rollbacks, and dependency pins';
    case 'full':     return 'all commands';
  }
}

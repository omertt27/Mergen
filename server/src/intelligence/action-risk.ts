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
export type AutopilotLevel = 'restarts' | 'deploys' | 'full';

export interface SemanticRiskResult {
  risk: 'low' | 'medium' | 'high';
  blocked: boolean;
  reason: string | null;
}

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

const DEPLOY_PATTERNS: RegExp[] = [
  ...RESTART_PATTERNS,
  /\bkubectl\s+rollout\s+undo\b/i,
  /\bkubectl\s+set\s+image\b/i,
  /\bkubectl\s+set\s+env\b/i,
  /\bhelm\s+(upgrade|rollback)\b/i,
  /\bnpm\s+install\s+\S+@\S+/i,
  /\bpip\s+install\s+\S+==\S+/i,
  /\bpip\s+install\s+--upgrade\s+\S+/i,
  /\byarn\s+add\s+\S+@\S+/i,
  /\bgem\s+install\s+\S+\s+-v\s+\S+/i,
  /\bgit\s+checkout\s+\S+\s+--\s+\S+/i,
  /\bgit\s+revert\s+[a-f0-9]{7}/i,
  /\baws\s+ecs\s+update-service\b/i,
  /\bgcloud\s+(app|run)\s+deploy\b/i,
  /\bgc\s+(app|run)\s+deploy\b/i,
  /\baz\s+(webapp|containerapp)\s+(restart|update)\b/i,
  /\bdocker-compose\s+(restart|up\s+--force-recreate)\b/i,
];

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

export function classifyCommandRisk(command: string): CommandRiskTier {
  if (RESTART_PATTERNS.some((p) => p.test(command))) return 'restart';
  if (DEPLOY_PATTERNS.some((p) => p.test(command)))  return 'deploy';
  return 'full';
}

export function autopilotLevelPermits(command: string, level: AutopilotLevel): boolean {
  const risk = classifyCommandRisk(command);
  return RISK_TIER_ORDER[risk] <= LEVEL_ORDER[level];
}

export function getAutopilotLevel(): AutopilotLevel {
  const raw = process.env.MERGEN_AUTOPILOT_LEVEL;
  if (raw === 'restarts' || raw === 'deploys' || raw === 'full') return raw;
  return 'full';
}

export function autopilotLevelDescription(level: AutopilotLevel): string {
  switch (level) {
    case 'restarts': return 'service restarts and reloads only';
    case 'deploys':  return 'restarts, rollbacks, and dependency pins';
    case 'full':     return 'all commands';
  }
}

/**
 * Semantic risk analysis to classify commands based on context and potential blast radius impact.
 */
export function analyzeSemanticRisk(
  command: string,
  context?: { service?: string; service_time?: { dayOfWeek: number; hourOfDay: number } }
): SemanticRiskResult {
  const lower = command.toLowerCase();
  
  // 1. Context check: Resizing DB connection pool during Friday settlement window (20:00 - 24:00 UTC)
  const isDBPoolResize = (lower.includes('pool') || lower.includes('max_connections') || lower.includes('db_pool')) && 
                         (lower.includes('set') || lower.includes('env') || lower.includes('export') || lower.includes('scale'));
  
  if (isDBPoolResize) {
    const day = context?.service_time?.dayOfWeek ?? new Date().getUTCDay();
    const hour = context?.service_time?.hourOfDay ?? new Date().getUTCHours();
    
    // Friday is dayOfWeek = 5
    if (day === 5 && hour >= 20 && hour <= 24) {
      return {
        risk: 'high',
        blocked: true,
        reason: 'Semantic Safety: Database pool resize is unsafe during Friday 20-24 UTC settlement window.',
      };
    }
  }

  // 2. Destructive command safety: Check for destructive mutations
  const isDestructiveSql = (lower.includes('drop') || lower.includes('truncate')) &&
    (lower.includes('table') || lower.includes('database') || lower.includes('schema'));
  const isDestructiveFs  = lower.includes('rm -rf') && lower.includes('/');
  const isDestructiveInfra = /terraform\s+destroy|kubectl\s+delete\s+(namespace|cluster)|aws.*delete-cluster/i.test(lower);
  if (isDestructiveSql || isDestructiveFs || isDestructiveInfra) {
    let reason: string;
    if (isDestructiveSql) {
      const op = lower.includes('truncate') ? 'TRUNCATE' : 'DROP';
      reason = `Blocked: \`${op} TABLE/DATABASE\` is irreversible. Use a reversible migration instead — rename the table (\`ALTER TABLE ... RENAME TO ..._deprecated\`) or add a soft-delete column, then drop in a separate PR after verifying no references remain.`;
    } else if (isDestructiveFs) {
      const match = command.match(/rm\s+-rf\s+(\S+)/i);
      const path = match?.[1] ?? '/...';
      reason = `Blocked: \`rm -rf ${path}\` permanently deletes files. Move to a timestamped archive path first (\`mv ${path} ${path}.bak-$(date +%s)\`), verify the archive is correct, then delete.`;
    } else {
      const match = command.match(/terraform\s+destroy|kubectl\s+delete\s+\S+|aws\s+\S+delete-cluster\S*/i);
      const cmd = match?.[0] ?? 'infra destroy command';
      reason = `Blocked: \`${cmd}\` destroys live infrastructure. Use \`terraform plan -destroy\` first to preview blast radius, then require explicit human approval via HITL before executing.`;
    }
    return { risk: 'high', blocked: true, reason };
  }

  // 3. Scale risk check: Resizing replicas or instances
  const isScale = lower.includes('scale') || lower.includes('replicas') || lower.includes('resize');
  if (isScale) {
    return {
      risk: 'medium',
      blocked: false,
      reason: 'Semantic Safety: Service scaling in progress.',
    };
  }

  // Default fallback: classify only actual shell commands, not diffs/code snippets.
  // A diff that doesn't match any destructive pattern is low risk — don't treat
  // "unrecognized as a restart command" as high risk, that causes false positives.
  const tier = classifyCommandRisk(command);
  if (tier === 'deploy') {
    return {
      risk: 'medium',
      blocked: false,
      reason: null,
    };
  }

  return {
    risk: 'low',
    blocked: false,
    reason: null,
  };
}

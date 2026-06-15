/**
 * rollback.ts — Derive and execute rollback strategies for autonomous fixes.
 *
 * Two distinct concerns:
 *
 * 1. PRE-IMPLEMENTATION: generateRollbackPlan(intent)
 *    Called BEFORE any change is made. Returns a structured plan describing
 *    how to undo the change if it regresses — files touched, feature flag,
 *    rollback commands, and whether auto-rollback is feasible.
 *
 * 2. POST-EXECUTION: deriveRollback(command) + executeRollback(strategy)
 *    Called when validate_fix / incident-autopilot detects REGRESSED. Derives
 *    the inverse command and executes it via executeRemediation() (blocklist,
 *    audit log, RBAC).
 *
 * Command coverage for deriveRollback:
 *   kubectl rollout restart / set image  → kubectl rollout undo
 *   helm upgrade                          → helm rollback
 *   npm / pip / yarn install <pkg>@<ver> → install <pkg>@<previous>
 *   git revert                            → git revert HEAD (undo the revert)
 *   restart-tier commands                 → stateless, no rollback needed
 */

import { executeRemediation } from './autonomy.js';
import logger from '../sensor/logger.js';

export type RollbackStrategy =
  | { type: 'command'; command: string }
  | { type: 'none'; reason: string };

/**
 * Derive a rollback strategy from the original executed command.
 *
 * @param command — the command that was just run
 * @param stdout  — stdout from that command (used for Helm release name lookup)
 */
export function deriveRollback(command: string, stdout: string): RollbackStrategy {
  const cmd = command.trim();

  // kubectl rollout restart deploy/<name> → kubectl rollout undo deploy/<name>
  const kubectlRestart = cmd.match(/^kubectl\s+rollout\s+restart\s+(deploy(?:ment)?\/\S+)/i);
  if (kubectlRestart) {
    return { type: 'command', command: `kubectl rollout undo ${kubectlRestart[1]}` };
  }

  // kubectl rollout restart -n <ns> deploy/<name>
  const kubectlRestartNs = cmd.match(/^kubectl\s+rollout\s+restart\s+(?:-n\s+\S+\s+)(deploy(?:ment)?\/\S+)/i);
  if (kubectlRestartNs) {
    const nsMatch = cmd.match(/-n\s+(\S+)/);
    const ns = nsMatch ? ` -n ${nsMatch[1]}` : '';
    return { type: 'command', command: `kubectl rollout undo${ns} ${kubectlRestartNs[1]}` };
  }

  // kubectl set image ... → kubectl rollout undo (extract deployment from args)
  const kubectlSetImage = cmd.match(/^kubectl\s+set\s+image\s+(?:deploy(?:ment)?\/)?(\S+)/i);
  if (kubectlSetImage) {
    return { type: 'command', command: `kubectl rollout undo deploy/${kubectlSetImage[1]}` };
  }

  // helm upgrade <release> ... → helm rollback <release>
  const helmUpgrade = cmd.match(/^helm\s+upgrade\s+(\S+)/i);
  if (helmUpgrade) {
    return { type: 'command', command: `helm rollback ${helmUpgrade[1]}` };
  }

  // npm install <pkg>@<ver> — extract current version from stdout ("+ pkg@x.y.z")
  const npmInstall = cmd.match(/^npm\s+install\s+(\S+)@(\S+)/i);
  if (npmInstall) {
    const [, pkg, ver] = npmInstall;
    // Try to extract the version that was overwritten from stdout
    const prevMatch = stdout.match(new RegExp(`removed.*${escapeRegex(pkg)}@(\\S+)`, 'i'));
    if (prevMatch) {
      return { type: 'command', command: `npm install ${pkg}@${prevMatch[1]}` };
    }
    return { type: 'none', reason: `can't determine prior ${pkg} version — check package-lock.json and revert manually` };
  }

  // pip install <pkg>==<ver>
  const pipInstall = cmd.match(/^pip\s+install\s+(\S+)==(\S+)/i);
  if (pipInstall) {
    const [, pkg] = pipInstall;
    return { type: 'none', reason: `can't determine prior ${pkg} version — revert requirements.txt and run pip install manually` };
  }

  // yarn add <pkg>@<ver>
  const yarnAdd = cmd.match(/^yarn\s+add\s+(\S+)@(\S+)/i);
  if (yarnAdd) {
    const [, pkg] = yarnAdd;
    return { type: 'none', reason: `can't determine prior ${pkg} version — check yarn.lock and revert manually` };
  }

  // git revert → revert the revert
  if (cmd.startsWith('git revert')) {
    return { type: 'command', command: 'git revert HEAD --no-edit' };
  }

  // Restart-tier commands are stateless — restarting again is the fix
  if (
    /^(pm2|systemctl|service|docker|supervisorctl)\s/.test(cmd) ||
    /^kill\s+-[1H]/.test(cmd) ||
    /^pkill\s+-[1H]/.test(cmd)
  ) {
    return { type: 'none', reason: 'restart commands are stateless — re-run the fix or restart manually' };
  }

  return { type: 'none', reason: 'no rollback strategy known for this command type — revert manually' };
}

/**
 * Execute a rollback strategy via the standard remediation pipeline.
 * Returns a human-readable result message.
 */
export async function executeRollback(
  strategy: RollbackStrategy,
  opts?: { cwd?: string; actor?: string },
): Promise<{ ok: boolean; message: string }> {
  if (strategy.type === 'none') {
    return { ok: false, message: strategy.reason };
  }

  logger.info({ command: strategy.command }, 'rollback: executing');
  const result = await executeRemediation(strategy.command, {
    cwd: opts?.cwd,
    actor: opts?.actor ?? 'autopilot-rollback',
  });

  if (result.blocked) {
    return { ok: false, message: `rollback blocked: ${result.blockReason}` };
  }
  if (!result.ok) {
    return { ok: false, message: `rollback exited ${result.exitCode}: ${result.stderr.slice(0, 200)}` };
  }
  return { ok: true, message: strategy.command };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Pre-implementation rollback planning ──────────────────────────────────────

export interface RollbackPlan {
  /** Files that will be modified by the proposed change. */
  filesModified: string[];
  /**
   * Feature flag that can disable the change without a deploy, or null if
   * the change cannot be toggled at runtime.
   */
  featureFlag: string | null;
  /** Human-readable step-by-step rollback procedure. */
  rollbackProcedure: string[];
  /** Whether the rollback can be executed automatically without human input. */
  canAutoRollback: boolean;
  /** Rough estimate of how long the rollback procedure takes in milliseconds. */
  estimatedRollbackMs: number;
  /**
   * Commands that would be derived by deriveRollback() for each proposed
   * execution command, if known ahead of time.
   */
  anticipatedRollbackCommands: string[];
}

export interface RollbackPlanIntent {
  /** Source files the change will touch. */
  files: string[];
  /** Commands the change will execute (e.g. kubectl, helm, npm). */
  commands?: string[];
  /**
   * Optional feature flag name — if set, the rollback plan lists toggling it
   * as the fastest recovery path.
   */
  featureFlag?: string;
}

/**
 * Generate a rollback plan BEFORE implementation starts.
 *
 * Call this as part of the pre-implementation checklist alongside
 * report_confidence. The returned plan should be reviewed by the engineer
 * (or surfaced by the agent) before any file is written or command executed.
 */
export function generateRollbackPlan(intent: RollbackPlanIntent): RollbackPlan {
  const { files, commands = [], featureFlag = null } = intent;

  const anticipatedRollbackCommands: string[] = [];
  for (const cmd of commands) {
    const strategy = deriveRollback(cmd, '');
    if (strategy.type === 'command') {
      anticipatedRollbackCommands.push(strategy.command);
    }
  }

  const canAutoRollback =
    (featureFlag !== null) ||
    (anticipatedRollbackCommands.length > 0 && anticipatedRollbackCommands.length === commands.length);

  const rollbackProcedure: string[] = [];

  if (featureFlag) {
    rollbackProcedure.push(`Disable feature flag: ${featureFlag}`);
    rollbackProcedure.push('Verify error rates return to baseline via validate_fix or GET /validate');
  }

  if (anticipatedRollbackCommands.length > 0) {
    rollbackProcedure.push('Execute rollback commands:');
    for (const cmd of anticipatedRollbackCommands) {
      rollbackProcedure.push(`  ${cmd}`);
    }
    rollbackProcedure.push('Validate recovery: call validate_fix or check GET /validate after 60 s');
  }

  if (files.length > 0 && anticipatedRollbackCommands.length === 0 && !featureFlag) {
    rollbackProcedure.push('Revert the following files using git:');
    for (const f of files) rollbackProcedure.push(`  git checkout HEAD -- ${f}`);
    rollbackProcedure.push('Or use: git revert HEAD --no-edit');
    rollbackProcedure.push('Redeploy / restart the service after revert');
  }

  if (rollbackProcedure.length === 0) {
    rollbackProcedure.push('No automated rollback available — manual intervention required');
    rollbackProcedure.push('Document the issue in the override corpus before proceeding');
  }

  // Rough time estimates: feature flag ~10 s, command-based ~60 s, git revert ~120 s
  const estimatedRollbackMs = featureFlag
    ? 10_000
    : anticipatedRollbackCommands.length > 0
      ? 60_000
      : 120_000;

  return {
    filesModified: files,
    featureFlag,
    rollbackProcedure,
    canAutoRollback,
    estimatedRollbackMs,
    anticipatedRollbackCommands,
  };
}

/**
 * rollback.ts — Derive and execute rollback strategies for autonomous fixes.
 *
 * When validate_fix / incident-autopilot detects REGRESSED, this module
 * derives the inverse command from the original fix and executes it via the
 * same executeRemediation() pipeline (blocklist, audit log, RBAC).
 *
 * Coverage:
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

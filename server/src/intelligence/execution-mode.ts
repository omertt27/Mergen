/**
 * execution-mode.ts — Single source of truth for autopilot / shadow-mode state.
 *
 * Previously each module read process.env directly with slightly different
 * logic, leading to divergent behaviour:
 *   - incident-autopilot.ts: isShadowMode = !autopilot && SHADOW_MODE=true
 *   - tools-autonomy.ts:     isShadow     = SHADOW_MODE=true && !autopilot
 *   - routes/incidents.ts:   isShadow     = SHADOW_MODE=true  (no autopilot check)
 *
 * Safe-default rule: when MERGEN_AUTOPILOT=true but MERGEN_SHADOW_MODE is not
 * explicitly set to 'false', the system defaults to shadow mode. Operators
 * must set MERGEN_SHADOW_MODE=false to enable live execution. This ensures
 * a new deployment cannot accidentally execute commands before the team has
 * reviewed the shadow track record.
 */

export function isAutopilotEnabled(): boolean {
  return process.env.MERGEN_AUTOPILOT === 'true';
}

/**
 * Returns true when the system should run in shadow mode:
 * diagnose, post Slack alerts, record shadow entries, but never execute.
 *
 * Shadow mode is active when:
 *   - MERGEN_SHADOW_MODE=true (explicit shadow — works with or without autopilot), OR
 *   - MERGEN_AUTOPILOT=true AND MERGEN_SHADOW_MODE is not set to 'false'
 *     (safe default: new deployments start in shadow until operator opts out)
 *
 * Live execution requires: MERGEN_AUTOPILOT=true AND MERGEN_SHADOW_MODE=false
 */
export function isShadowMode(): boolean {
  const shadowEnv = process.env.MERGEN_SHADOW_MODE;
  const autopilot = isAutopilotEnabled();

  // Explicit shadow override always wins
  if (shadowEnv === 'true') return true;

  // With autopilot enabled, default to shadow unless operator explicitly sets MERGEN_SHADOW_MODE=false
  if (autopilot) return shadowEnv !== 'false';

  // Without autopilot, shadow mode is only active when explicitly set
  return false;
}

/**
 * Returns true only when live command execution is permitted:
 * MERGEN_AUTOPILOT=true AND MERGEN_SHADOW_MODE=false (explicit opt-out of shadow).
 */
export function isLiveExecutionEnabled(): boolean {
  return isAutopilotEnabled() && !isShadowMode();
}

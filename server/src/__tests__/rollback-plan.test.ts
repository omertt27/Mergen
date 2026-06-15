/**
 * rollback-plan.test.ts — Tests for generateRollbackPlan() (pre-implementation planning).
 *
 * deriveRollback / executeRollback are tested implicitly via the autonomy tests.
 * This file focuses on the new pre-implementation planning path.
 */

import { describe, it, expect } from 'vitest';
import { generateRollbackPlan } from '../intelligence/rollback.js';

describe('generateRollbackPlan', () => {
  it('returns the list of files to modify', () => {
    const plan = generateRollbackPlan({ files: ['src/routes/foo.ts', 'src/sensor/bar.ts'] });
    expect(plan.filesModified).toEqual(['src/routes/foo.ts', 'src/sensor/bar.ts']);
  });

  it('sets featureFlag when provided', () => {
    const plan = generateRollbackPlan({ files: ['src/foo.ts'], featureFlag: 'ENABLE_NEW_FLOW' });
    expect(plan.featureFlag).toBe('ENABLE_NEW_FLOW');
  });

  it('featureFlag is null when not provided', () => {
    const plan = generateRollbackPlan({ files: ['src/foo.ts'] });
    expect(plan.featureFlag).toBeNull();
  });

  it('canAutoRollback is true when a feature flag is present', () => {
    const plan = generateRollbackPlan({ files: ['src/foo.ts'], featureFlag: 'FF_X' });
    expect(plan.canAutoRollback).toBe(true);
  });

  it('canAutoRollback is true when all commands have known inverse', () => {
    const plan = generateRollbackPlan({
      files: ['deploy/k8s.yaml'],
      commands: ['kubectl rollout restart deploy/api'],
    });
    expect(plan.canAutoRollback).toBe(true);
    expect(plan.anticipatedRollbackCommands).toContain('kubectl rollout undo deploy/api');
  });

  it('canAutoRollback is false when no feature flag and no rollback commands', () => {
    const plan = generateRollbackPlan({ files: ['src/foo.ts'], commands: ['pip install requests==2.32.0'] });
    expect(plan.canAutoRollback).toBe(false);
  });

  it('populates anticipatedRollbackCommands from kubectl set image', () => {
    const plan = generateRollbackPlan({
      files: [],
      commands: ['kubectl set image deploy/api api=myimage:v2'],
    });
    expect(plan.anticipatedRollbackCommands).toContain('kubectl rollout undo deploy/api');
  });

  it('populates anticipatedRollbackCommands from helm upgrade', () => {
    const plan = generateRollbackPlan({
      files: [],
      commands: ['helm upgrade my-release ./chart'],
    });
    expect(plan.anticipatedRollbackCommands).toContain('helm rollback my-release');
  });

  it('estimatedRollbackMs is 10 000 when a feature flag is provided', () => {
    const plan = generateRollbackPlan({ files: ['src/x.ts'], featureFlag: 'FF' });
    expect(plan.estimatedRollbackMs).toBe(10_000);
  });

  it('estimatedRollbackMs is 60 000 for command-based rollback', () => {
    const plan = generateRollbackPlan({
      files: [],
      commands: ['kubectl rollout restart deploy/svc'],
    });
    expect(plan.estimatedRollbackMs).toBe(60_000);
  });

  it('estimatedRollbackMs is 120 000 for git-only rollback', () => {
    const plan = generateRollbackPlan({ files: ['src/foo.ts'] });
    expect(plan.estimatedRollbackMs).toBe(120_000);
  });

  it('rollbackProcedure is non-empty', () => {
    const plan = generateRollbackPlan({ files: ['src/foo.ts'] });
    expect(plan.rollbackProcedure.length).toBeGreaterThan(0);
  });

  it('rollbackProcedure mentions the feature flag when one is set', () => {
    const plan = generateRollbackPlan({ files: [], featureFlag: 'ENABLE_STRIPE_V2' });
    expect(plan.rollbackProcedure.some((s) => s.includes('ENABLE_STRIPE_V2'))).toBe(true);
  });

  it('rollbackProcedure mentions git revert for file-only changes with no commands', () => {
    const plan = generateRollbackPlan({ files: ['src/routes/payment.ts'] });
    expect(plan.rollbackProcedure.some((s) => s.includes('git'))).toBe(true);
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';
import { evaluateEnterprisePolicy, loadEnterprisePolicy } from '../intelligence/enterprise-policy-engine.js';
import { classifyCommandRisk } from '../intelligence/action-risk.js';
import { requestApproval, approveExecution } from '../intelligence/execution-gate.js';
import { executeRemediation } from '../intelligence/autonomy.js';
import { handleSlackActions, postApprovalRequest } from '../intelligence/slack.js';

// Mock the execution gate persistence
vi.mock('../intelligence/execution-gate.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../intelligence/execution-gate.js')>();
  return {
    ...actual,
    requestApproval: vi.fn(actual.requestApproval),
    approveExecution: vi.fn(actual.approveExecution),
  };
});

// Mock autonomy remediation executor
vi.mock('../intelligence/autonomy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../intelligence/autonomy.js')>();
  return {
    ...actual,
    executeRemediation: vi.fn().mockResolvedValue({ ok: true, durationMs: 42 }),
  };
});

// Mock Slack HTTP poster
vi.mock('../sensor/paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../sensor/paths.js')>();
  return {
    ...actual,
    zeroRetentionMode: () => true,
  };
});

describe('Slack Interactive Governance (Phase 2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('riskTier medium/high rules are registered and matched by evaluateEnterprisePolicy', () => {
    const config = loadEnterprisePolicy();
    
    // Create a temporary rule with riskTier: 'high'
    const highRiskRule = {
      id: 'test_high_risk_rule',
      name: 'Nuke Database Check',
      description: 'Require human-in-the-loop for drop database commands',
      action: 'block' as const,
      reason: 'Database drop is high risk',
      riskTier: 'high' as const,
      conditions: {
        commands: ['drop database'],
      },
    };

    config.rules.push(highRiskRule);

    const result = evaluateEnterprisePolicy({
      files: [],
      commands: ['drop database production'],
      actor: 'autopilot',
      service: 'api',
    });

    expect(result.triggeredRules).toContain('test_high_risk_rule');
    
    const triggeredRuleDetails = config.rules.find(r => r.id === 'test_high_risk_rule');
    expect(triggeredRuleDetails?.riskTier).toBe('high');

    // Clean up
    config.rules = config.rules.filter(r => r.id !== 'test_high_risk_rule');
  });

  it('handleSlackActions processes edit_command_modal submission and executes edited command', async () => {
    // 1. Mock a pending execution in the gate
    const pid = 'incident-p2-test';
    const originalCommand = 'kubectl rollout restart deployment/payments';
    const modifiedCommand = 'kubectl rollout restart deployment/payments --namespace=prod';
    
    requestApproval({
      pid,
      command: originalCommand,
      tier: 'deploy',
      service: 'payments',
      remediationConfidence: 0.95,
      cwd: '/workspace',
    });

    // 2. Prepare mock request representing a Slack modal submission
    const mockPayload = {
      type: 'view_submission',
      view: {
        callback_id: 'edit_command_modal',
        private_metadata: pid,
        state: {
          values: {
            command_block: {
              command_input: {
                value: modifiedCommand,
              },
            },
          },
        },
      },
      user: {
        id: 'U12345',
      },
    };

    const req = {
      body: {
        payload: JSON.stringify(mockPayload),
      },
      headers: {},
    } as unknown as Request;

    const res = {
      status: vi.fn().mockReturnThis(),
      send: vi.fn(),
      json: vi.fn(),
    } as unknown as Response;

    // 3. Dispatch to Slack actions handler
    await handleSlackActions(req, res);

    // Verify response was 200 OK
    expect(res.status).toHaveBeenCalledWith(200);

    // Verify the execution was approved and popped from the gate
    expect(approveExecution).toHaveBeenCalledWith(pid);

    // Verify remediation was called with the modified command, not the original one
    expect(executeRemediation).toHaveBeenCalledWith(
      modifiedCommand,
      expect.objectContaining({ actor: 'U12345', cwd: '/workspace' })
    );
  });
});

import { describe, it, expect } from 'vitest';
import { parseRunbookYaml } from '../intelligence/tools-runbook.js';

describe('tools-runbook: parseRunbookYaml', () => {
  it('correctly parses name and description', () => {
    const yaml = `
name: test-runbook
description: "A test runbook description"
steps:
  - name: Step 1
    tool: get_recent_logs
`;
    const res = parseRunbookYaml(yaml);
    expect(res.name).toBe('test-runbook');
    expect(res.description).toBe('A test runbook description');
    expect(res.steps).toHaveLength(1);
    expect(res.steps[0].step).toBe('Step 1');
    expect(res.steps[0].tool).toBe('get_recent_logs');
  });

  it('correctly parses parameters under steps', () => {
    const yaml = `
name: db-pool
description: Pool diagnostics
steps:
  - name: Log check
    tool: get_recent_logs
    params:
      level: error
      limit: 100
  - name: Network check
    tool: get_network_activity
    params:
      limit: 50
      flag: true
`;
    const res = parseRunbookYaml(yaml);
    expect(res.steps).toHaveLength(2);
    expect(res.steps[0].step).toBe('Log check');
    expect(res.steps[0].tool).toBe('get_recent_logs');
    expect(res.steps[0].params).toEqual({
      level: 'error',
      limit: 100,
    });
    expect(res.steps[1].step).toBe('Network check');
    expect(res.steps[1].tool).toBe('get_network_activity');
    expect(res.steps[1].params).toEqual({
      limit: 50,
      flag: true,
    });
  });
});

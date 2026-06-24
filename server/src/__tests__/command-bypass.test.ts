import { describe, it, expect } from 'vitest';
import { registerBypassBlock, approveBypass, checkAndConsumeBypass } from '../intelligence/tool-guard.js';

describe('Command Bypass Logic', () => {
  it('registers a blocked command and returns a 32-character hex token', () => {
    const token = registerBypassBlock('execute_fix', 'terraform destroy prod');
    expect(token).toBeDefined();
    expect(token.length).toBe(32);
    expect(/^[0-9a-f]{32}$/.test(token)).toBe(true);
  });

  it('marks a pending bypass as approved and consumes it on execution', () => {
    const token = registerBypassBlock('execute_fix', 'rm -rf /tmp/test');
    expect(checkAndConsumeBypass('execute_fix', 'rm -rf /tmp/test')).toBe(false);

    const approveResult = approveBypass(token);
    expect(approveResult.ok).toBe(true);
    expect(approveResult.toolName).toBe('execute_fix');
    expect(approveResult.commandArg).toBe('rm -rf /tmp/test');

    // Bypass should now be consumed successfully
    expect(checkAndConsumeBypass('execute_fix', 'rm -rf /tmp/test')).toBe(true);

    // Bypass is single-use, should fail to consume on subsequent check
    expect(checkAndConsumeBypass('execute_fix', 'rm -rf /tmp/test')).toBe(false);
  });

  it('normalizes whitespace in the command before matching', () => {
    const token = registerBypassBlock('execute_fix', 'rm  -rf   /tmp/test ');
    const approveResult = approveBypass(token);
    expect(approveResult.ok).toBe(true);

    // Bypass should be consumed even with normalized spacing
    expect(checkAndConsumeBypass('execute_fix', 'rm -rf /tmp/test')).toBe(true);
  });

  it('returns failure when approving an unknown token', () => {
    const result = approveBypass('fake');
    expect(result.ok).toBe(false);
  });
});

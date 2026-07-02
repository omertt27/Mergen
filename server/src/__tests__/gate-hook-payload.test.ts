/**
 * gate-hook-payload.test.ts — extractCommandFromHookPayload (commands/gate.ts).
 *
 * This is the one piece of the Claude Code PreToolUse hook integration that's
 * cheaply unit-testable in isolation (gateCheckCommand itself calls
 * process.exit()). Covers the defensive multi-path extraction and the
 * fail-closed behavior on anything unexpected.
 */
import { describe, it, expect } from 'vitest';
import { extractCommandFromHookPayload } from '../commands/gate.js';

describe('extractCommandFromHookPayload', () => {
  it('extracts from tool_input.command (primary expected shape)', () => {
    const raw = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'rm -rf /' } });
    expect(extractCommandFromHookPayload(raw)).toBe('rm -rf /');
  });

  it('extracts from tool_input.cmd as a fallback', () => {
    const raw = JSON.stringify({ tool_input: { cmd: 'ls -la' } });
    expect(extractCommandFromHookPayload(raw)).toBe('ls -la');
  });

  it('extracts from a top-level command field as a fallback', () => {
    const raw = JSON.stringify({ command: 'echo hi' });
    expect(extractCommandFromHookPayload(raw)).toBe('echo hi');
  });

  it('returns null (fail closed) for invalid JSON', () => {
    expect(extractCommandFromHookPayload('not json at all')).toBeNull();
  });

  it('returns null (fail closed) when no recognizable command field is present', () => {
    expect(extractCommandFromHookPayload(JSON.stringify({ tool_name: 'Bash' }))).toBeNull();
  });

  it('returns null (fail closed) for an empty string payload', () => {
    expect(extractCommandFromHookPayload('')).toBeNull();
  });

  it('returns null (fail closed) when the payload is a JSON array or primitive, not an object', () => {
    expect(extractCommandFromHookPayload('[1,2,3]')).toBeNull();
    expect(extractCommandFromHookPayload('"just a string"')).toBeNull();
    expect(extractCommandFromHookPayload('42')).toBeNull();
  });

  it('ignores a non-string command field rather than coercing it', () => {
    expect(extractCommandFromHookPayload(JSON.stringify({ command: 12345 }))).toBeNull();
  });
});

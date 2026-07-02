/**
 * claude-code-hook-install.test.ts — installClaudeCodePreToolUseHook
 * (commands/setup.ts). Verifies the settings.json merge/idempotency behavior
 * against a scratch file — never touches the real ~/.claude/settings.json.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installClaudeCodePreToolUseHook } from '../commands/setup.js';

let tmpDir: string;
let settingsPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mergen-claude-settings-test-'));
  settingsPath = path.join(tmpDir, 'settings.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('installClaudeCodePreToolUseHook', () => {
  it('creates settings.json with a PreToolUse hook when none exists', () => {
    installClaudeCodePreToolUseHook(settingsPath);
    const written = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const preToolUse = written.hooks.PreToolUse;
    expect(preToolUse).toHaveLength(1);
    expect(preToolUse[0].matcher).toBe('Bash');
    expect(preToolUse[0].hooks[0].type).toBe('command');
    expect(preToolUse[0].hooks[0].command).toMatch(/gate-check/);
  });

  it('is idempotent — running twice does not duplicate the hook', () => {
    installClaudeCodePreToolUseHook(settingsPath);
    installClaudeCodePreToolUseHook(settingsPath);
    const written = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(written.hooks.PreToolUse).toHaveLength(1);
  });

  it('preserves unrelated existing settings and hooks', () => {
    fs.writeFileSync(settingsPath, JSON.stringify({
      someOtherSetting: 'keep-me',
      hooks: {
        PostToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'echo done' }] }],
      },
    }));

    installClaudeCodePreToolUseHook(settingsPath);

    const written = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(written.someOtherSetting).toBe('keep-me');
    expect(written.hooks.PostToolUse).toHaveLength(1);
    expect(written.hooks.PreToolUse).toHaveLength(1);
  });

  it('does not clobber an existing PreToolUse hook for a different tool', () => {
    fs.writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'some-other-hook' }] }],
      },
    }));

    installClaudeCodePreToolUseHook(settingsPath);

    const written = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(written.hooks.PreToolUse).toHaveLength(2);
    expect(written.hooks.PreToolUse.some((e: { matcher: string }) => e.matcher === 'Write')).toBe(true);
    expect(written.hooks.PreToolUse.some((e: { matcher: string }) => e.matcher === 'Bash')).toBe(true);
  });

  it('does not throw and skips install when the existing file has invalid JSON', () => {
    fs.writeFileSync(settingsPath, '{ not valid json');
    expect(() => installClaudeCodePreToolUseHook(settingsPath)).not.toThrow();
    // File is left untouched rather than overwritten with a guess.
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe('{ not valid json');
  });
});

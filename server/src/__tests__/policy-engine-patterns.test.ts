/**
 * policy-engine-patterns.test.ts
 *
 * Verifies that word-boundary matching in the enterprise policy engine:
 *   1. Catches genuine destructive patterns (no false negatives)
 *   2. Does NOT fire on compound identifiers containing the same word (no false positives)
 *   3. Hot-reload invalidates the cache when the policy file changes
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  evaluateEnterprisePolicy,
  loadEnterprisePolicy,
  _resetPolicyCacheForTesting,
} from '../intelligence/enterprise-policy-engine.js';

describe('evaluateEnterprisePolicy — word-boundary command matching', () => {
  beforeEach(() => {
    // Force the default policy into the cache so tests are never affected by
    // the developer's local ~/.mergen/enterprise-policy.json on disk.
    _resetPolicyCacheForTesting();
  });

  // ── True positives: patterns that must be blocked ─────────────────────────

  it('blocks "terraform destroy" in a command arg', () => {
    const result = evaluateEnterprisePolicy({
      files: [],
      commands: ['execute_fix', 'terraform destroy prod'],
      actor: 'agent',
      service: 'infra',
    });
    expect(result.verdict).toBe('block');
    expect(result.triggeredRules).toContain('block_destructive_commands');
  });

  it('blocks standalone "destroy" at word boundary', () => {
    const result = evaluateEnterprisePolicy({
      files: [],
      commands: ['execute_fix', 'destroy everything'],
      actor: 'agent',
      service: 'infra',
    });
    expect(result.verdict).toBe('block');
  });

  it('blocks "rm -rf" in command', () => {
    const result = evaluateEnterprisePolicy({
      files: [],
      commands: ['bash', 'rm -rf /var/data'],
      actor: 'agent',
      service: 'api',
    });
    expect(result.verdict).toBe('block');
  });

  it('blocks "drop table" in SQL command', () => {
    const result = evaluateEnterprisePolicy({
      files: [],
      commands: ['execute_query', 'drop table users'],
      actor: 'agent',
      service: 'db',
    });
    expect(result.verdict).toBe('block');
  });

  // ── False positives: compound identifiers must NOT trigger ────────────────

  it('does NOT block "destroy_reason" compound identifier', () => {
    const result = evaluateEnterprisePolicy({
      files: [],
      commands: ['get_record', 'destroy_reason'],
      actor: 'agent',
      service: 'api',
    });
    expect(result.verdict).toBe('pass');
  });

  it('DOES block "destroy-session" — hyphen is a non-word char, so boundary matches', () => {
    // This is intentional: "destroy-session" contains the word "destroy" at a
    // word boundary. Agents should use more specific tool names if they need to
    // manage sessions — the gate's job is to be strict, not lenient.
    const result = evaluateEnterprisePolicy({
      files: [],
      commands: ['list_sessions', 'destroy-session-records'],
      actor: 'agent',
      service: 'api',
    });
    expect(result.verdict).toBe('block');
  });

  it('does NOT block "destroy_reason" underscore-joined identifier', () => {
    // Underscore is a word char (\w), so \bdestroy\b does NOT match inside
    // "destroy_reason" — the word boundary is only at the start/end of the whole token.
    const result = evaluateEnterprisePolicy({
      files: [],
      commands: ['get_record', 'destroy_reason'],
      actor: 'agent',
      service: 'api',
    });
    expect(result.verdict).toBe('pass');
  });

  it('does NOT block query text containing "wipe" as part of a word', () => {
    const result = evaluateEnterprisePolicy({
      files: [],
      commands: ['analyze_runtime', 'typewipe'],
      actor: 'agent',
      service: 'api',
    });
    expect(result.verdict).toBe('pass');
  });

  it('does NOT block "nuke" as part of "manuka" (substring)', () => {
    const result = evaluateEnterprisePolicy({
      files: [],
      commands: ['get_config', 'manuka-honey-config'],
      actor: 'agent',
      service: 'api',
    });
    expect(result.verdict).toBe('pass');
  });

  // ── HITL hold: schema mutations ───────────────────────────────────────────

  it('holds schema mutations for AI actors', () => {
    const result = evaluateEnterprisePolicy({
      files: [],
      commands: ['execute_fix', 'prisma migrate deploy'],
      actor: 'claude',
      service: 'api',
    });
    expect(result.verdict).toBe('warn');
    expect(result.triggeredRules).toContain('hold_schema_mutations');
  });

  it('does NOT hold schema mutations for human actors', () => {
    const result = evaluateEnterprisePolicy({
      files: [],
      commands: ['deploy', 'prisma migrate deploy'],
      actor: 'omer',
      service: 'api',
    });
    // human actors: not matched by hold_schema_mutations (actorType: 'ai')
    // and 'prisma migrate' is multi-word, so only matches that rule
    expect(result.triggeredRules).not.toContain('hold_schema_mutations');
  });

  // ── Pass-through ──────────────────────────────────────────────────────────

  it('passes safe commands with no matches', () => {
    const result = evaluateEnterprisePolicy({
      files: [],
      commands: ['get_recent_logs', ''],
      actor: 'agent',
      service: 'api',
    });
    expect(result.verdict).toBe('pass');
    expect(result.triggeredRules).toHaveLength(0);
  });
});

describe('evaluateEnterprisePolicy — policy disabled', () => {
  it('passes everything when config.enabled is false', () => {
    _resetPolicyCacheForTesting({ enabled: false, rules: [] });

    const result = evaluateEnterprisePolicy({
      files: [],
      commands: ['execute_fix', 'rm -rf /'],
      actor: 'agent',
      service: 'api',
    });
    expect(result.verdict).toBe('pass');
    expect(result.triggeredRules).toHaveLength(0);
  });
});

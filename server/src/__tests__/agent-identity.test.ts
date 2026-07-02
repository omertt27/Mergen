/**
 * agent-identity.test.ts — signed agent identity token invariants:
 *   1. issueToken/verifyToken round-trip correctly with the right secret.
 *   2. A token signed with a different secret fails verification (tamper/forge).
 *   3. An expired token fails verification.
 *   4. A malformed token fails verification without throwing.
 *   5. resolveAgentIdentity prefers a verified MERGEN_AGENT_TOKEN over the raw
 *      MERGEN_AGENT_ID, and reports verified:false when only the raw env is set.
 *   6. Issued tokens are recorded for operator visibility (listIssuedTokenRecords).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Module state (DATA_DIR-derived paths, the module-level secret) is computed
// once at import time and cached by Node's ES module loader — importing fresh
// per-test does not give each test a fresh module instance. Import once here,
// against one scratch MERGEN_DATA_DIR, and reset in-memory + on-disk state
// explicitly in beforeEach instead (same pattern as policy-proposals.test.ts).
let tmpDir: string;
let setAgentTokenSecret: typeof import('../intelligence/agent-identity.js').setAgentTokenSecret;
let issueToken: typeof import('../intelligence/agent-identity.js').issueToken;
let verifyToken: typeof import('../intelligence/agent-identity.js').verifyToken;
let resolveAgentIdentity: typeof import('../intelligence/agent-identity.js').resolveAgentIdentity;
let listIssuedTokenRecords: typeof import('../intelligence/agent-identity.js').listIssuedTokenRecords;
let _resetAgentIdentityForTesting: typeof import('../intelligence/agent-identity.js')._resetAgentIdentityForTesting;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mergen-agent-identity-test-'));
  process.env.MERGEN_DATA_DIR = tmpDir;
  ({ setAgentTokenSecret, issueToken, verifyToken, resolveAgentIdentity, listIssuedTokenRecords, _resetAgentIdentityForTesting } =
    await import('../intelligence/agent-identity.js'));
});

afterAll(() => {
  delete process.env.MERGEN_DATA_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  _resetAgentIdentityForTesting();
  delete process.env.MERGEN_AGENT_TOKEN;
  delete process.env.MERGEN_AGENT_ID;
  fs.rmSync(path.join(tmpDir, 'agent-tokens'), { recursive: true, force: true });
});

describe('issueToken / verifyToken round-trip', () => {
  it('a token issued with a secret verifies with the same secret', () => {
    setAgentTokenSecret('test-secret-1');
    const token = issueToken('claude-alice');
    expect(verifyToken(token)).toBe('claude-alice');
  });

  it('a token signed with a different secret fails verification (forge attempt)', () => {
    setAgentTokenSecret('real-secret');
    const token = issueToken('claude-alice');

    _resetAgentIdentityForTesting();
    setAgentTokenSecret('attacker-guessed-secret');
    expect(verifyToken(token)).toBeNull();
  });

  it('an expired token fails verification', () => {
    setAgentTokenSecret('test-secret');
    const token = issueToken('claude-alice', -1000); // already expired
    expect(verifyToken(token)).toBeNull();
  });

  it('a malformed token fails verification without throwing', () => {
    setAgentTokenSecret('test-secret');
    expect(() => verifyToken('not-a-valid-token')).not.toThrow();
    expect(verifyToken('not-a-valid-token')).toBeNull();
    expect(verifyToken('')).toBeNull();
  });

  it('verification returns null when no secret is configured', () => {
    const token = 'irrelevant';
    expect(verifyToken(token)).toBeNull();
  });
});

describe('resolveAgentIdentity', () => {
  it('prefers a verified MERGEN_AGENT_TOKEN over the raw MERGEN_AGENT_ID', () => {
    setAgentTokenSecret('test-secret');
    const token = issueToken('claude-verified');
    process.env.MERGEN_AGENT_TOKEN = token;
    process.env.MERGEN_AGENT_ID = 'claude-spoofed';

    const identity = resolveAgentIdentity();
    expect(identity.verified).toBe(true);
    expect(identity.agentId).toBe('claude-verified');
  });

  it('falls back to the raw MERGEN_AGENT_ID, unverified, when no token is present', () => {
    process.env.MERGEN_AGENT_ID = 'claude-unverified';
    const identity = resolveAgentIdentity();
    expect(identity.verified).toBe(false);
    expect(identity.agentId).toBe('claude-unverified');
  });

  it('an invalid/expired MERGEN_AGENT_TOKEN does not verify, and does not fall back to trusting itself', () => {
    setAgentTokenSecret('test-secret');
    process.env.MERGEN_AGENT_TOKEN = 'garbage-token';
    process.env.MERGEN_AGENT_ID = 'claude-fallback';

    const identity = resolveAgentIdentity();
    expect(identity.verified).toBe(false);
    // Falls back to the raw (unverified) id for labeling purposes only.
    expect(identity.agentId).toBe('claude-fallback');
  });

  it('returns undefined agentId and verified:false when nothing is set', () => {
    const identity = resolveAgentIdentity();
    expect(identity.verified).toBe(false);
    expect(identity.agentId).toBeUndefined();
  });
});

describe('listIssuedTokenRecords', () => {
  it('records every issued token for operator visibility', () => {
    setAgentTokenSecret('test-secret');
    issueToken('claude-alice');
    issueToken('claude-bob');

    const records = listIssuedTokenRecords();
    const ids = records.map((r) => r.agentId).sort();
    expect(ids).toEqual(['claude-alice', 'claude-bob']);
  });

  it('returns an empty list when nothing has been issued', () => {
    expect(listIssuedTokenRecords()).toEqual([]);
  });
});

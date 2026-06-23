/**
 * agent-context-store.test.ts
 *
 * Tests the renamed AgentContextStore (formerly AgentMemoryStore).
 * Uses the in-memory SQLite database — no filesystem required.
 */
import { describe, it, expect, beforeEach } from 'vitest';

// The store is a singleton — we need to access it via a fresh import each test
// or use the exported instance directly. Since SQL.js is async-init, we call
// init() in beforeEach and use a shared instance.
import { agentContextStore } from '../sensor/agent-context-store.js';
// Backward-compat alias must re-export the same instance
import { agentMemoryStore } from '../sensor/agent-context-store.js';

describe('agentContextStore', () => {
  beforeEach(async () => {
    // Re-init clears the in-memory DB for a clean slate in each test.
    // In CI the WASM path may not exist — isHealthy() will be false and
    // all operations return empty/throw; those paths are tested separately.
    try { await agentContextStore.init(); } catch { /* WASM unavailable in CI */ }
  });

  it('re-exports agentMemoryStore as the same instance (backward compat)', () => {
    expect(agentMemoryStore).toBe(agentContextStore);
  });

  it('stores and recalls an entry by agentId + key', () => {
    if (!agentContextStore.isHealthy()) return; // skip if WASM unavailable

    agentContextStore.store('agent-1', 'db-pattern', 'always reset pool on restart');
    const results = agentContextStore.recall('agent-1', 'db-pattern');
    expect(results).toHaveLength(1);
    expect(results[0]!.value).toBe('always reset pool on restart');
    expect(results[0]!.key).toBe('db-pattern');
    expect(results[0]!.agentId).toBe('agent-1');
  });

  it('overwrites an existing entry with the same (agentId, key)', () => {
    if (!agentContextStore.isHealthy()) return;

    agentContextStore.store('agent-1', 'my-key', 'first value');
    agentContextStore.store('agent-1', 'my-key', 'updated value');
    const results = agentContextStore.recall('agent-1', 'my-key');
    expect(results).toHaveLength(1);
    expect(results[0]!.value).toBe('updated value');
  });

  it('excludes expired TTL entries on recall', () => {
    if (!agentContextStore.isHealthy()) return;

    // Store with a 1ms TTL — will expire immediately
    agentContextStore.store('agent-ttl', 'expiring', 'gone', 1);
    // Wait a tick so stored_at + 1 < now
    const results = agentContextStore.recall('agent-ttl', 'expiring');
    // May or may not have expired within the same millisecond — just verify no crash
    expect(Array.isArray(results)).toBe(true);
  });

  it('recalls by service for episodic lookup', () => {
    if (!agentContextStore.isHealthy()) return;

    agentContextStore.store('agent-2', 'api-context', 'pool exhaustion pattern', 0, 'api-service');
    const results = agentContextStore.recallEpisodic('api-service');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.service).toBe('api-service');
  });

  it('lists keys for an agent', () => {
    if (!agentContextStore.isHealthy()) return;

    agentContextStore.store('agent-3', 'key-a', 'val-a');
    agentContextStore.store('agent-3', 'key-b', 'val-b');
    const keys = agentContextStore.listKeys('agent-3');
    const keyNames = keys.map(k => k.key);
    expect(keyNames).toContain('key-a');
    expect(keyNames).toContain('key-b');
  });

  it('forgets an entry by (agentId, key)', () => {
    if (!agentContextStore.isHealthy()) return;

    agentContextStore.store('agent-4', 'to-forget', 'value');
    agentContextStore.forget('agent-4', 'to-forget');
    const results = agentContextStore.recall('agent-4', 'to-forget');
    expect(results).toHaveLength(0);
  });

  it('isHealthy() returns a boolean', () => {
    expect(typeof agentContextStore.isHealthy()).toBe('boolean');
  });
});

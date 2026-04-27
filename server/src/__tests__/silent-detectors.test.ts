/**
 * silent-detectors.test.ts — Silent-failure detectors fire on baselines.
 *
 * These detectors are the watcher pivot's payoff: they produce a hypothesis
 * even when the page never threw an error. We verify both fire on a buffer
 * containing only successful network events.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { buildCausalChain } from '../causal.js';
import { store } from '../buffer.js';

beforeEach(() => store.clear());

describe('silent-failure detectors', () => {
  it('detectSlowApiSilent fires on slow 2xx with no error', async () => {
    store.push({
      type: 'network', method: 'GET', url: 'https://api/x',
      status: 200, statusText: 'OK', duration: 1800,
      timestamp: Date.now(),
    });
    const chain = await buildCausalChain(store.getLogs(50), store.getNetwork(50), store.getContext(20));
    const tags = chain.hypotheses.map(h => h.tag);
    expect(tags).toContain('slow_api_silent');
  });

  it('detectEmptyResponseSilent fires on 200 with empty body', async () => {
    store.push({
      type: 'network', method: 'GET', url: 'https://api/users',
      status: 200, statusText: 'OK', duration: 50,
      responseBody: [],
      timestamp: Date.now(),
    });
    const chain = await buildCausalChain(store.getLogs(50), store.getNetwork(50), store.getContext(20));
    const tags = chain.hypotheses.map(h => h.tag);
    expect(tags).toContain('empty_response_silent');
  });

  it('error-required detectors stay quiet on a clean baseline', async () => {
    store.push({
      type: 'network', method: 'GET', url: 'https://api/health',
      status: 200, statusText: 'OK', duration: 30,
      timestamp: Date.now(),
    });
    const chain = await buildCausalChain(store.getLogs(50), store.getNetwork(50), store.getContext(20));
    const tags = chain.hypotheses.map(h => h.tag);
    expect(tags).not.toContain('failed_request_uninitialised_state');
    expect(tags).not.toContain('null_storage_key');
    expect(tags).not.toContain('warning_preceded_error');
  });
});

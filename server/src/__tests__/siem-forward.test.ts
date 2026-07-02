/**
 * siem-forward.test.ts — P0.5 SIEM forwarder (webhook + Splunk HEC).
 *
 * Mocks global fetch and asserts on request shape rather than hitting a real
 * network endpoint. forwardToSiem() is fire-and-forget (never throws, never
 * awaited by its caller) — these tests await the underlying promises it
 * kicks off directly since forwardToSiem() itself doesn't return one.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

function makeEntry(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'blunder-1',
    recordedAt: 1_700_000_000_000,
    blunderType: 'pipeline_block',
    command: 'terraform destroy',
    blockReason: 'destructive command',
    service: 'infra',
    tag: null,
    actor: 'agent',
    pid: null,
    confidenceScore: null,
    previousHash: 'a'.repeat(64),
    hash: 'b'.repeat(64),
    ...overrides,
  } as never;
}

describe('siem-forward', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.MERGEN_SIEM_WEBHOOK_URL;
    delete process.env.MERGEN_SIEM_WEBHOOK_TOKEN;
    delete process.env.MERGEN_SPLUNK_HEC_URL;
    delete process.env.MERGEN_SPLUNK_HEC_TOKEN;
    fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('siemForwardingConfigured is false when nothing is set', async () => {
    const { siemForwardingConfigured } = await import('../intelligence/siem-forward.js');
    expect(siemForwardingConfigured()).toBe(false);
  });

  it('does not call fetch at all when nothing is configured', async () => {
    const { forwardToSiem } = await import('../intelligence/siem-forward.js');
    forwardToSiem(makeEntry());
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POSTs to the generic webhook when MERGEN_SIEM_WEBHOOK_URL is set', async () => {
    process.env.MERGEN_SIEM_WEBHOOK_URL = 'https://siem.example.com/ingest';
    const { forwardToSiem, siemForwardingConfigured } = await import('../intelligence/siem-forward.js');
    expect(siemForwardingConfigured()).toBe(true);

    forwardToSiem(makeEntry());
    await new Promise((r) => setTimeout(r, 10));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://siem.example.com/ingest');
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body);
    expect(body.source).toBe('mergen_agent_blunder_log');
    expect(body.id).toBe('blunder-1');
    expect(opts.headers.Authorization).toBeUndefined();
  });

  it('includes a bearer token when MERGEN_SIEM_WEBHOOK_TOKEN is set', async () => {
    process.env.MERGEN_SIEM_WEBHOOK_URL = 'https://siem.example.com/ingest';
    process.env.MERGEN_SIEM_WEBHOOK_TOKEN = 'secret-token';
    const { forwardToSiem } = await import('../intelligence/siem-forward.js');

    forwardToSiem(makeEntry());
    await new Promise((r) => setTimeout(r, 10));

    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.headers.Authorization).toBe('Bearer secret-token');
  });

  it('POSTs to Splunk HEC in the {event: {...}} envelope with the Splunk auth header', async () => {
    process.env.MERGEN_SPLUNK_HEC_URL = 'https://splunk.example.com:8088/services/collector';
    process.env.MERGEN_SPLUNK_HEC_TOKEN = 'hec-token';
    const { forwardToSiem } = await import('../intelligence/siem-forward.js');

    forwardToSiem(makeEntry());
    await new Promise((r) => setTimeout(r, 10));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://splunk.example.com:8088/services/collector');
    expect(opts.headers.Authorization).toBe('Splunk hec-token');
    const body = JSON.parse(opts.body);
    expect(body.event.id).toBe('blunder-1');
    expect(body.sourcetype).toBe('mergen:agent_blunder');
    expect(body.time).toBe(1_700_000_000);
  });

  it('does not enable Splunk HEC when only the URL is set without a token', async () => {
    process.env.MERGEN_SPLUNK_HEC_URL = 'https://splunk.example.com:8088/services/collector';
    const { forwardToSiem, siemForwardingConfigured } = await import('../intelligence/siem-forward.js');
    expect(siemForwardingConfigured()).toBe(false);

    forwardToSiem(makeEntry());
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards to both sinks independently when both are configured', async () => {
    process.env.MERGEN_SIEM_WEBHOOK_URL = 'https://siem.example.com/ingest';
    process.env.MERGEN_SPLUNK_HEC_URL = 'https://splunk.example.com:8088/services/collector';
    process.env.MERGEN_SPLUNK_HEC_TOKEN = 'hec-token';
    const { forwardToSiem } = await import('../intelligence/siem-forward.js');

    forwardToSiem(makeEntry());
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not throw when the webhook POST fails (fire-and-forget, gate path must never break)', async () => {
    process.env.MERGEN_SIEM_WEBHOOK_URL = 'https://siem.example.com/ingest';
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    const { forwardToSiem } = await import('../intelligence/siem-forward.js');

    expect(() => forwardToSiem(makeEntry())).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
  });

  it('does not throw when fetch itself rejects (network error)', async () => {
    process.env.MERGEN_SIEM_WEBHOOK_URL = 'https://siem.example.com/ingest';
    fetchMock.mockRejectedValue(new Error('network down'));
    const { forwardToSiem } = await import('../intelligence/siem-forward.js');

    expect(() => forwardToSiem(makeEntry())).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
  });
});

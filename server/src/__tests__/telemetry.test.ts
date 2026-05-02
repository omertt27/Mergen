/**
 * telemetry.test.ts — opt-in / off-by-default telemetry behaviour.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// In-memory FS mock so we can inspect what's written.
const fsState: { content: string | null } = { content: null };

vi.mock('fs/promises', () => ({
  default: {
    mkdir:     vi.fn().mockResolvedValue(undefined),
    readFile:  vi.fn(async () => {
      if (fsState.content === null) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return fsState.content;
    }),
    writeFile: vi.fn(async (_p: string, data: string) => { fsState.content = data; }),
  },
}));

vi.mock('../paths.js', () => ({
  DATA_DIR: '/tmp/.mergen-test',
  TELEMETRY_FILE: '/tmp/.mergen-test/telemetry.json',
}));

vi.mock('../logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

describe('telemetry', () => {
  beforeEach(() => {
    vi.resetModules();
    fsState.content = null;
    delete process.env.MERGEN_TELEMETRY;
    delete process.env.MERGEN_TELEMETRY_URL;
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is disabled by default and assigns a stable installId', async () => {
    const t = await import('../intelligence/telemetry.js');
    await t.initTelemetry();
    const s1 = t.getTelemetryState();
    expect(s1.enabled).toBe(false);
    expect(s1.installId).toMatch(/^[0-9a-f-]{36}$/);

    // Re-init: installId persists.
    vi.resetModules();
    const t2 = await import('../intelligence/telemetry.js');
    await t2.initTelemetry();
    expect(t2.getTelemetryState().installId).toBe(s1.installId);
  });

  it('respects MERGEN_TELEMETRY=1 env override', async () => {
    process.env.MERGEN_TELEMETRY = '1';
    const t = await import('../intelligence/telemetry.js');
    await t.initTelemetry();
    expect(t.getTelemetryState().enabled).toBe(true);
  });

  it('does NOT send when disabled', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    process.env.MERGEN_TELEMETRY_URL = 'https://example.invalid/t';

    const t = await import('../intelligence/telemetry.js');
    await t.initTelemetry();

    const sent = await t.maybeSendTelemetry({
      serverVersion: '1.0.0', nodeVersion: '20',
      planId: 'free', toolCallCounts: {}, bufferedEvents: 0,
    });
    expect(sent).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does NOT send when no endpoint URL configured (even if opted in)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const t = await import('../intelligence/telemetry.js');
    await t.initTelemetry();
    await t.setTelemetryEnabled(true);

    const sent = await t.maybeSendTelemetry({
      serverVersion: '1.0.0', nodeVersion: '20',
      planId: 'free', toolCallCounts: {}, bufferedEvents: 0,
    });
    expect(sent).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends a redacted payload when opted in + endpoint set, and throttles repeats', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    process.env.MERGEN_TELEMETRY_URL = 'https://example.invalid/t';

    const t = await import('../intelligence/telemetry.js');
    await t.initTelemetry();
    await t.setTelemetryEnabled(true);

    const sent = await t.maybeSendTelemetry({
      serverVersion: '1.2.3', nodeVersion: '20',
      planId: 'solo_pro',
      toolCallCounts: { analyze_runtime: 3 },
      bufferedEvents: 17,
    });
    expect(sent).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({
      serverVersion: '1.2.3',
      planId: 'solo_pro',
      toolCallCounts: { analyze_runtime: 3 },
      bufferedEvents: 17,
    });
    // No PII fields.
    expect(body).not.toHaveProperty('email');
    expect(body).not.toHaveProperty('licenseKey');
    expect(body.installId).toMatch(/^[0-9a-f-]{36}$/);

    // Second call within window is throttled.
    const sent2 = await t.maybeSendTelemetry({
      serverVersion: '1.2.3', nodeVersion: '20',
      planId: 'solo_pro', toolCallCounts: {}, bufferedEvents: 0,
    });
    expect(sent2).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

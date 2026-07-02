/**
 * compliance-report.test.ts — P1.2 real compliance report.
 *
 * Verifies buildComplianceReport() assembles an honest snapshot from the
 * real (scratch-dir-backed) policy engine, RBAC store, and blunder log —
 * and that renderComplianceHtml() doesn't throw and includes the key
 * sections. Uses a scratch MERGEN_DATA_DIR (same pattern as the other
 * file-backed tests in this suite).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

let tmpDir: string;
let buildComplianceReport: typeof import('../intelligence/compliance-report.js').buildComplianceReport;
let renderComplianceHtml: typeof import('../intelligence/compliance-report.js').renderComplianceHtml;
let upsertMember: typeof import('../sensor/rbac.js').upsertMember;
let _resetRbacForTesting: typeof import('../sensor/rbac.js')._resetForTesting;
let recordBlunder: typeof import('../sensor/agent-blunder-store.js').recordBlunder;
let saveEnterprisePolicy: typeof import('../intelligence/enterprise-policy-engine.js').saveEnterprisePolicy;
let loadEnterprisePolicy: typeof import('../intelligence/enterprise-policy-engine.js').loadEnterprisePolicy;
let DEFAULT_ENTERPRISE_POLICY: typeof import('../intelligence/enterprise-policy-engine.js').DEFAULT_ENTERPRISE_POLICY;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mergen-compliance-report-test-'));
  process.env.MERGEN_DATA_DIR = tmpDir;
  ({ buildComplianceReport, renderComplianceHtml } = await import('../intelligence/compliance-report.js'));
  ({ upsertMember, _resetForTesting: _resetRbacForTesting } = await import('../sensor/rbac.js'));
  ({ recordBlunder } = await import('../sensor/agent-blunder-store.js'));
  ({ saveEnterprisePolicy, loadEnterprisePolicy, DEFAULT_ENTERPRISE_POLICY } = await import('../intelligence/enterprise-policy-engine.js'));
});

afterAll(() => {
  delete process.env.MERGEN_DATA_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  _resetRbacForTesting();
});

describe('buildComplianceReport', () => {
  it('reflects the actual RBAC membership', async () => {
    upsertMember('alice@example.com', 'admin');
    upsertMember('bob@example.com', 'responder');
    upsertMember('carol@example.com', 'viewer');

    const report = await buildComplianceReport(Date.now() - 1000, Date.now() + 1000);
    expect(report.security.rbac.totalMembers).toBe(3);
    expect(report.security.rbac.admins).toBe(1);
    expect(report.security.rbac.responders).toBe(1);
    expect(report.security.rbac.viewers).toBe(1);
  });

  it('counts blocked actions within the window and buckets by type', async () => {
    const now = Date.now();
    recordBlunder({
      blunderType: 'injection_attempt', command: 'x', blockReason: 'r',
      service: 'svc', tag: null, actor: 'agent', pid: null, confidenceScore: null,
      recordedAt: now,
    });
    recordBlunder({
      blunderType: 'injection_attempt', command: 'y', blockReason: 'r',
      service: 'svc', tag: null, actor: 'agent', pid: null, confidenceScore: null,
      recordedAt: now,
    });

    const report = await buildComplianceReport(now - 1000, now + 1000);
    expect(report.security.blockedActionsInWindow).toBeGreaterThanOrEqual(2);
    expect(report.security.blockedActionsByType.injection_attempt).toBeGreaterThanOrEqual(2);
  });

  it('excludes blunders outside the requested window', async () => {
    const longAgo = Date.now() - 365 * 24 * 60 * 60 * 1000;
    recordBlunder({
      blunderType: 'rbac_block', command: 'old', blockReason: 'r',
      service: 'svc', tag: null, actor: 'agent', pid: null, confidenceScore: null,
      recordedAt: longAgo,
    });

    const report = await buildComplianceReport(Date.now() - 1000, Date.now() + 1000);
    expect(report.security.blockedActionsByType.rbac_block ?? 0).toBe(0);
  });

  it('reflects the actual policy rule count and enabled state', async () => {
    saveEnterprisePolicy(DEFAULT_ENTERPRISE_POLICY);
    const policy = loadEnterprisePolicy(true);
    const report = await buildComplianceReport(Date.now() - 1000, Date.now() + 1000);
    expect(report.security.policyRulesActive).toBe(policy.rules.length);
    expect(report.security.policyEnabled).toBe(policy.enabled);
  });

  it('marks availability as not applicable', async () => {
    const report = await buildComplianceReport(Date.now() - 1000, Date.now() + 1000);
    expect(report.availability.applicable).toBe(false);
    expect(report.availability.note).toMatch(/not applicable/i);
  });

  it('always reports the PII shield as active', async () => {
    const report = await buildComplianceReport(Date.now() - 1000, Date.now() + 1000);
    expect(report.confidentiality.piiShieldActive).toBe(true);
  });
});

describe('renderComplianceHtml', () => {
  it('renders without throwing and includes the three report sections', async () => {
    const report = await buildComplianceReport(Date.now() - 1000, Date.now() + 1000);
    const html = renderComplianceHtml(report);
    expect(html).toContain('Security');
    expect(html).toContain('Confidentiality');
    expect(html).toContain('Availability');
  });

  it('escapes HTML-significant characters in dynamic content', async () => {
    const report = await buildComplianceReport(Date.now() - 1000, Date.now() + 1000);
    report.security.blockedActionsByType['<script>evil</script>'] = 1;
    const html = renderComplianceHtml(report);
    expect(html).not.toContain('<script>evil</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

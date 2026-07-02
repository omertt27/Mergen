/**
 * compliance-report.ts — SOC 2-structured compliance report.
 *
 * Distinct from routes/audit-export.ts's `format=soc2`, which is a raw NDJSON
 * data export for auditors who want to independently verify the hash chain.
 * This module is the human-readable report: what controls exist, whether
 * they're active in THIS deployment's actual configuration, and a summary of
 * enforcement activity in the requested window. Sections follow the SOC 2
 * Trust Service Criteria this product can genuinely speak to — Security and
 * Confidentiality. Availability is marked N/A: Mergen doesn't host customer
 * production systems, so uptime/DR controls aren't something this report can
 * meaningfully assert.
 *
 * See docs/enterprise-security.md ("SOC 2 readiness" table) for the static
 * control-to-criteria mapping this report's live snapshot corresponds to.
 */
import fs from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { loadEnterprisePolicy, IMMUTABLE_RULE_IDS } from './enterprise-policy-engine.js';
import { listMembers } from '../sensor/rbac.js';
import { zeroRetentionMode } from '../sensor/paths.js';
import { fetchBlunderEntries, fetchHttpAuditEntries, fetchChainVerification } from '../sensor/audit-fetch.js';

export interface ComplianceReport {
  generatedAt: number;
  windowFrom: number;
  windowTo: number;
  security: {
    policyRulesActive: number;
    immutableRulesActive: number;
    policyEnabled: boolean;
    blockedActionsInWindow: number;
    blockedActionsByType: Record<string, number>;
    auditChain: {
      valid: boolean;
      verified: number;
      truncated: boolean;
      tamperEvidenceLevel: string;
      hmacProtected: boolean;
    };
    rbac: {
      totalMembers: number;
      admins: number;
      responders: number;
      viewers: number;
    };
  };
  confidentiality: {
    zeroRetentionMode: boolean;
    piiShieldActive: boolean;
    customPiiConfigPresent: boolean;
  };
  availability: {
    applicable: false;
    note: string;
  };
  httpAuditEntryCount: number;
}

export async function buildComplianceReport(from: number, to: number): Promise<ComplianceReport> {
  const [blunders, httpEntries, chainVerification] = await Promise.all([
    fetchBlunderEntries(from, to),
    fetchHttpAuditEntries(from, to),
    fetchChainVerification(),
  ]);

  const policy = loadEnterprisePolicy();
  const members = listMembers();

  const blockedByType: Record<string, number> = {};
  for (const b of blunders) {
    blockedByType[b.blunderType] = (blockedByType[b.blunderType] ?? 0) + 1;
  }

  const customPiiConfigPresent = fs.existsSync(join(homedir(), '.mergen', 'pii-config.json'));

  return {
    generatedAt: Date.now(),
    windowFrom: from,
    windowTo: to,
    security: {
      policyRulesActive: policy.rules.length,
      immutableRulesActive: policy.rules.filter((r) => IMMUTABLE_RULE_IDS.has(r.id)).length,
      policyEnabled: policy.enabled,
      blockedActionsInWindow: blunders.length,
      blockedActionsByType: blockedByType,
      auditChain: {
        valid: chainVerification.valid,
        verified: chainVerification.verified ?? 0,
        truncated: chainVerification.truncated ?? false,
        tamperEvidenceLevel: chainVerification.tamperEvidenceLevel ?? 'unknown',
        hmacProtected: chainVerification.hmacProtected ?? false,
      },
      rbac: {
        totalMembers: members.length,
        admins: members.filter((m) => m.role === 'admin').length,
        responders: members.filter((m) => m.role === 'responder').length,
        viewers: members.filter((m) => m.role === 'viewer').length,
      },
    },
    confidentiality: {
      zeroRetentionMode: zeroRetentionMode(),
      // Always-on regex PII redaction (email, phone, AWS keys, PEM certs, JWTs,
      // credit cards) — not configurable off, per this product's own design.
      piiShieldActive: true,
      customPiiConfigPresent,
    },
    availability: {
      applicable: false,
      note: 'Not applicable — Mergen runs on customer infrastructure and does not host customer production systems. Uptime/DR controls for the systems Mergen governs are the customer\'s own responsibility.',
    },
    httpAuditEntryCount: httpEntries.length,
  };
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Printable-to-PDF via the browser — no PDF rendering dependency in this project. */
export function renderComplianceHtml(report: ComplianceReport): string {
  const fmt = (ts: number) => new Date(ts).toISOString();
  const typeRows = Object.entries(report.security.blockedActionsByType)
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => `<tr><td>${esc(type)}</td><td>${count}</td></tr>`)
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mergen Compliance Report</title>
<style>
  :root{--bg:#0f1117;--surface:#1a1d26;--border:#2a2d3a;--text:#e2e8f0;--muted:#64748b;
    --green:#22c55e;--yellow:#f59e0b;--red:#ef4444;--blue:#3b82f6;}
  *{box-sizing:border-box}
  body{background:var(--bg);color:var(--text);font-family:-apple-system,ui-sans-serif,sans-serif;font-size:14px;line-height:1.6;margin:0;padding:32px;max-width:860px;margin:0 auto}
  h1{font-size:22px;margin:0 0 4px}
  .sub{color:var(--muted);font-size:13px;margin-bottom:28px}
  section{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:20px 24px;margin-bottom:20px}
  h2{font-size:15px;margin:0 0 12px;letter-spacing:.02em}
  table{width:100%;border-collapse:collapse;font-size:13px}
  td{padding:6px 8px;border-bottom:1px solid var(--border)}
  td:first-child{color:var(--muted)}
  td:last-child{text-align:right;font-weight:600}
  .badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700}
  .badge.ok{background:rgba(34,197,94,.15);color:var(--green)}
  .badge.warn{background:rgba(245,158,11,.15);color:var(--yellow)}
  .badge.bad{background:rgba(239,68,68,.15);color:var(--red)}
  .na{color:var(--muted);font-style:italic}
  footer{color:var(--muted);font-size:11px;margin-top:24px}
  @media print{body{padding:0}}
</style>
</head>
<body>
<h1>Mergen Compliance Report</h1>
<div class="sub">Generated ${esc(fmt(report.generatedAt))} · Window ${esc(fmt(report.windowFrom))} → ${esc(fmt(report.windowTo))}</div>

<section>
<h2>Security</h2>
<table>
<tr><td>Policy enabled</td><td>${report.security.policyEnabled ? '<span class="badge ok">Yes</span>' : '<span class="badge bad">No</span>'}</td></tr>
<tr><td>Active policy rules</td><td>${report.security.policyRulesActive} (${report.security.immutableRulesActive} immutable)</td></tr>
<tr><td>Blocked actions in window</td><td>${report.security.blockedActionsInWindow}</td></tr>
<tr><td>Audit chain</td><td>${report.security.auditChain.valid ? '<span class="badge ok">Valid</span>' : '<span class="badge bad">INVALID</span>'}</td></tr>
<tr><td>Tamper-evidence level</td><td>${
    report.security.auditChain.tamperEvidenceLevel === 'hmac-sealed'
      ? '<span class="badge ok">hmac-sealed</span>'
      : report.security.auditChain.tamperEvidenceLevel === 'hash-chain'
        ? '<span class="badge warn">hash-chain only</span>'
        : '<span class="badge bad">none</span>'
  }</td></tr>
<tr><td>Chain truncated (ring buffer wrapped)</td><td>${report.security.auditChain.truncated ? 'Yes' : 'No'}</td></tr>
<tr><td>RBAC members</td><td>${report.security.rbac.totalMembers} (${report.security.rbac.admins} admin, ${report.security.rbac.responders} responder, ${report.security.rbac.viewers} viewer)</td></tr>
</table>
${typeRows ? `<h2 style="margin-top:20px">Blocked actions by type</h2><table>${typeRows}</table>` : ''}
</section>

<section>
<h2>Confidentiality</h2>
<table>
<tr><td>Zero-retention mode</td><td>${report.confidentiality.zeroRetentionMode ? '<span class="badge ok">Enabled</span>' : 'Disabled'}</td></tr>
<tr><td>PII shield (always-on)</td><td><span class="badge ok">Active</span></td></tr>
<tr><td>Custom PII patterns configured</td><td>${report.confidentiality.customPiiConfigPresent ? 'Yes' : 'No (default patterns only)'}</td></tr>
</table>
</section>

<section>
<h2>Availability</h2>
<p class="na">${esc(report.availability.note)}</p>
</section>

<footer>
Control-to-criteria mapping: docs/enterprise-security.md. Raw tamper-evident audit data: GET /audit/export?format=soc2.
Print this page to PDF for distribution — no server-side PDF generation is used.
</footer>
</body>
</html>`;
}

/**
 * audit-export.ts — Compliance-grade audit log export.
 *
 *   GET /audit/export?format=soc2&from=<ms>&to=<ms>&type=blunders|http|all
 *
 * Produces a tamper-evident NDJSON (newline-delimited JSON) export suitable
 * for SOC 2 Type II and ISO 27001 auditors. Each line is a self-contained
 * JSON object. The export includes:
 *
 *   - Agent blunder log entries (hash-chained, tamper-evident)
 *   - HTTP audit log entries (all non-trivial requests)
 *
 * The blunder entries carry `previousHash` and `hash` fields so an external
 * auditor can verify the chain without trusting the server:
 *   SHA-256(previousHash + JSON(entry fields)) === entry.hash
 *
 * format=soc2 wraps the output in a header object with metadata:
 *   { mergenVersion, exportedAt, chainValid, entryCount, ... }
 *
 * format=siem is the pull-based counterpart to intelligence/siem-forward.ts's
 * push (webhook/Splunk HEC) delivery — same blunder-log NDJSON body, for
 * connectors that prefer polling this endpoint over receiving a push.
 *
 * Query params:
 *   format  — "ndjson" (default) | "soc2" (adds header metadata line) | "siem" (blunders only, polling-friendly filename)
 *   type    — "blunders" | "http" | "all" (default: "all"; ignored for format=siem, which is always blunders-only)
 *   from    — Unix ms start (default: 30 days ago)
 *   to      — Unix ms end (default: now)
 *   limit   — max entries (default: 5000, max: 50000)
 */

import { Router } from 'express';
import { fetchBlunderEntries, fetchHttpAuditEntries, fetchChainVerification } from '../sensor/audit-fetch.js';

export function createAuditExportRouter(): Router {
  const router = Router();

  router.get('/audit/export', async (req, res) => {
    const now      = Date.now();
    const format   = ((req.query.format as string) ?? 'ndjson').toLowerCase();
    const type     = format === 'siem' ? 'blunders' : ((req.query.type as string) ?? 'all').toLowerCase();
    const from     = Number(req.query.from  ?? now - 30 * 24 * 60 * 60 * 1_000);
    const to       = Number(req.query.to    ?? now);
    const limit    = Math.min(50_000, Math.max(1, Number(req.query.limit ?? 5_000)));

    const lines: string[] = [];

    // ── Blunder entries (hash-chained) ────────────────────────────────────────
    if (type === 'blunders' || type === 'all') {
      const blunders = await fetchBlunderEntries(from, to);
      for (const b of blunders) {
        lines.push(JSON.stringify({
          source:        'blunder_log',
          ts:            new Date(b.recordedAt).toISOString(),
          ts_ms:         b.recordedAt,
          id:            b.id,
          actor:         b.actor ?? 'agent',
          blunderType:   b.blunderType,
          tool:          b.command ?? null,
          blockReason:   b.blockReason,
          service:       b.service ?? null,
          tag:           b.tag ?? null,
          pid:           b.pid ?? null,
          gateDecision:  'block',
          previousHash:  b.previousHash,
          hash:          b.hash,
        }));
      }
    }

    // ── HTTP audit entries ────────────────────────────────────────────────────
    if (type === 'http' || type === 'all') {
      const httpEntries = await fetchHttpAuditEntries(from, to);
      for (const e of httpEntries) {
        lines.push(JSON.stringify({
          source:     'http_audit',
          ts:         e.ts,
          ts_ms:      new Date(e.ts).getTime(),
          actor:      e.actor,
          method:     e.method,
          path:       e.path,
          status:     e.status,
          durationMs: e.durationMs,
          ip:         e.ip,
        }));
      }
    }

    // Apply limit (blunders first — they carry the tamper-evident chain)
    const trimmed = lines.slice(0, limit);

    if (format === 'soc2') {
      // Prepend a metadata header line for auditors
      const chainVerification = await fetchChainVerification();
      const header = JSON.stringify({
        source:         '__export_header__',
        exportFormat:   'mergen-soc2-v1',
        exportedAt:     new Date(now).toISOString(),
        windowFrom:     new Date(from).toISOString(),
        windowTo:       new Date(to).toISOString(),
        entryCount:     trimmed.length,
        limitApplied:   lines.length > limit,
        chainValid:     chainVerification.valid,
        chainVerified:  chainVerification.verified ?? 0,
        chainTruncated: (chainVerification as { truncated?: boolean }).truncated ?? false,
        // What guarantee actually applies given this deployment's configuration —
        // not a blanket "tamper-evident" claim regardless of setup. See
        // agent-blunder-store.ts's tamperEvidenceLevel() for the precise semantics.
        tamperEvidenceLevel: (chainVerification as { tamperEvidenceLevel?: string }).tamperEvidenceLevel ?? 'unknown',
        hmacProtected:       (chainVerification as { hmacProtected?: boolean }).hmacProtected ?? false,
        note:           'Verify blunder log integrity: SHA-256(previousHash + JSON(fields)) === hash for each entry. Chain starts from the genesis hash (64 zeros) or the oldest surviving entry when the ring buffer has wrapped. tamperEvidenceLevel "hash-chain" (not "hmac-sealed") means an attacker with the same local filesystem access as the Mergen process could re-link the chain around a deletion — set MERGEN_AUDIT_SECRET for hmac-sealed protection.',
      });
      res.setHeader('Content-Type', 'application/x-ndjson');
      res.setHeader('Content-Disposition', `attachment; filename="mergen-audit-soc2-${new Date(now).toISOString().slice(0, 10)}.ndjson"`);
      res.setHeader('Cache-Control', 'no-store');
      res.send([header, ...trimmed].join('\n') + '\n');
      return;
    }

    if (format === 'siem') {
      res.setHeader('Content-Type', 'application/x-ndjson');
      res.setHeader('Content-Disposition', `attachment; filename="mergen-siem-${new Date(now).toISOString().slice(0, 10)}.ndjson"`);
      res.setHeader('Cache-Control', 'no-store');
      res.send(trimmed.join('\n') + '\n');
      return;
    }

    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Content-Disposition', `attachment; filename="mergen-audit-${new Date(now).toISOString().slice(0, 10)}.ndjson"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(trimmed.join('\n') + '\n');
  });

  return router;
}

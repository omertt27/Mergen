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
 * Query params:
 *   format  — "ndjson" (default) | "soc2" (adds header metadata line)
 *   type    — "blunders" | "http" | "all" (default: "all")
 *   from    — Unix ms start (default: 30 days ago)
 *   to      — Unix ms end (default: now)
 *   limit   — max entries (default: 5000, max: 50000)
 */

import { Router } from 'express';
import { getBlunders, verifyChain } from '../sensor/agent-blunder-store.js';
import { getAuditLog } from '../sensor/audit-log.js';

export function createAuditExportRouter(): Router {
  const router = Router();

  router.get('/audit/export', (req, res) => {
    const now      = Date.now();
    const format   = ((req.query.format as string) ?? 'ndjson').toLowerCase();
    const type     = ((req.query.type   as string) ?? 'all').toLowerCase();
    const from     = Number(req.query.from  ?? now - 30 * 24 * 60 * 60 * 1_000);
    const to       = Number(req.query.to    ?? now);
    const limit    = Math.min(50_000, Math.max(1, Number(req.query.limit ?? 5_000)));

    const lines: string[] = [];

    // ── Blunder entries (hash-chained) ────────────────────────────────────────
    if (type === 'blunders' || type === 'all') {
      const blunders = getBlunders().filter(
        (b) => b.recordedAt >= from && b.recordedAt <= to,
      );
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
      const httpEntries = getAuditLog(50_000).filter((e) => {
        const ts = new Date(e.ts).getTime();
        return ts >= from && ts <= to;
      });
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
      const chainVerification = getBlunders().length > 0 ? verifyChain() : { valid: true, verified: 0 };
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
        note:           'Verify blunder log integrity: SHA-256(previousHash + JSON(fields)) === hash for each entry. Chain starts from the genesis hash (64 zeros) or the oldest surviving entry when the ring buffer has wrapped.',
      });
      res.setHeader('Content-Type', 'application/x-ndjson');
      res.setHeader('Content-Disposition', `attachment; filename="mergen-audit-soc2-${new Date(now).toISOString().slice(0, 10)}.ndjson"`);
      res.setHeader('Cache-Control', 'no-store');
      res.send([header, ...trimmed].join('\n') + '\n');
      return;
    }

    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Content-Disposition', `attachment; filename="mergen-audit-${new Date(now).toISOString().slice(0, 10)}.ndjson"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(trimmed.join('\n') + '\n');
  });

  return router;
}

/**
 * routes/compliance-report.ts
 *
 *   GET /compliance/report?format=json|html&from=<ms>&to=<ms>
 *
 * The human-readable compliance report (intelligence/compliance-report.ts) —
 * distinct from GET /audit/export?format=soc2's raw NDJSON data export.
 * format=html is printable to PDF via the browser; no server-side PDF
 * rendering dependency is used.
 */
import { Router } from 'express';
import { buildComplianceReport, renderComplianceHtml } from '../intelligence/compliance-report.js';

export function createComplianceReportRouter(): Router {
  const router = Router();

  router.get('/compliance/report', async (req, res) => {
    const now    = Date.now();
    const format = ((req.query.format as string) ?? 'json').toLowerCase();
    const from   = Number(req.query.from ?? now - 30 * 24 * 60 * 60 * 1_000);
    const to     = Number(req.query.to   ?? now);

    const report = await buildComplianceReport(from, to);

    if (format === 'html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
      res.setHeader('Cache-Control', 'no-store');
      res.send(renderComplianceHtml(report));
      return;
    }

    res.json({ ok: true, report });
  });

  return router;
}

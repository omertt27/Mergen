/**
 * routes/incident-webhook.ts — Generic incident creation webhook.
 *
 * Triggers the same autonomous triage pipeline as a PagerDuty webhook,
 * without requiring a PagerDuty account. Any monitoring tool that can POST
 * a JSON webhook (UptimeRobot, Cronitor, Checkly, Grafana, custom scripts)
 * can trigger Mergen.
 *
 * POST /incident
 * Body: {
 *   title:        string   — what's broken (shown in Slack/Discord)
 *   service:      string   — service name, used for override corpus lookup
 *   severity?:    'critical' | 'high' | 'medium' | 'low'  (default: 'high')
 *   description?: string   — optional additional context
 *   source?:      string   — webhook source (e.g. 'uptimerobot', 'grafana')
 *   environment?: string   — 'production' | 'staging' | ...  (default: 'production')
 * }
 *
 * Returns: { ok: true, pid: '<uuid>', message: 'Autopilot started' }
 *
 * Examples:
 *
 *   # UptimeRobot / Cronitor / custom script
 *   curl -X POST http://localhost:3000/incident \
 *     -H 'Content-Type: application/json' \
 *     -d '{"title":"api is down","service":"api"}'
 *
 *   # Grafana alert webhook
 *   # Map Grafana's payload fields in the body above
 */

import { Router, type Request, type Response } from 'express';
import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { z } from 'zod';
import { incidentStore } from '../sensor/incident-store.js';
import { notify } from '../intelligence/notifications.js';
import { runIncidentAutopilot } from '../intelligence/incident-autopilot.js';
import logger from '../sensor/logger.js';

/**
 * Validate a caller-supplied working directory for use in remediation.
 * Accepts only real, existing directories that are rooted under the
 * server's cwd or the current user's home directory. Rejects path-
 * traversal attempts and any path that does not exist on disk.
 */
function validateCwd(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const resolved = path.resolve(raw);
  const safePrefixes = [process.cwd(), os.homedir()];
  const isUnderSafeRoot = safePrefixes.some(
    (p) => resolved === p || resolved.startsWith(p + path.sep),
  );
  if (!isUnderSafeRoot) {
    logger.warn({ cwd: raw, resolved }, 'incident-webhook: rejected cwd outside safe root');
    return undefined;
  }
  try {
    if (!fs.statSync(resolved).isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  return resolved;
}

const IncidentBody = z.object({
  title:       z.string().min(1).max(500),
  service:     z.string().min(1).max(200),
  severity:    z.enum(['critical', 'high', 'medium', 'low']).optional().default('high'),
  description: z.string().max(2000).optional(),
  source:      z.string().max(100).optional(),
  environment: z.string().max(100).optional().default('production'),
  cwd:         z.string().max(500).optional(),
});

export function createIncidentWebhookRouter(): Router {
  const router = Router();

  router.post('/incident', (req: Request, res: Response): void => {
    const parsed = IncidentBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: parsed.error.issues.map((i) => i.message).join(', ') });
      return;
    }

    const { title, service, severity, description, source, environment } = parsed.data;
    const cwd = validateCwd(parsed.data.cwd);
    const pid    = randomUUID();
    const firedAt = Date.now();

    // Create the incident record immediately so it shows in /incidents
    incidentStore.upsert(pid, {
      status: 'open',
      hypothesis: title,
      tag: 'generic_webhook',
      environment: environment ?? null,
      confidence: 0,
    });

    logger.info({ pid, title, service, severity, source }, 'incident-webhook: incident created');

    // Post initial notification to all configured channels
    const severityIcon = severity === 'critical' ? '🚨' : severity === 'high' ? '⚠️' : '🔔';
    const sourceLabel = source ? ` via ${source}` : '';
    void notify(pid, [
      `${severityIcon} *Incident Created${sourceLabel}* — ${service}`,
      `*${title}*`,
      description ? `\n${description}` : '',
      `_Mergen autopilot starting…_`,
    ].filter(Boolean).join('\n'), { priority: severity === 'critical' ? 'urgent' : 'high', tags: ['rotating_light'] });

    // Start autopilot in background — don't block the HTTP response
    void runIncidentAutopilot({ service, pid, firedAt, cwd });

    res.status(202).json({
      ok: true,
      pid,
      message: 'Incident created. Autopilot analysis started.',
      links: {
        status:      `GET /incidents/${pid}`,
        shadowReport: `GET /shadow-report/entries`,
        impactReport: `GET /impact-report`,
      },
    });
  });

  return router;
}

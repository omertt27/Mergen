/**
 * routes/otel.ts — Configure and manage OpenTelemetry log export.
 *
 * GET    /otel-config         → current config (endpoint, serviceName, enabled)
 * POST   /otel-config         → configure OTLP export
 * DELETE /otel-config         → disable OTLP export
 *
 * Gated behind Solo Pro / Team plan (isOtelPlan).
 */

import { Router, type Request, type Response } from 'express';
import {
  configureOtel,
  disableOtel,
  getOtelConfig,
  type OtelConfig,
} from '../sensor/otel-exporter.js';
import { getActivePlanId } from '../intelligence/license.js';
import logger from '../sensor/logger.js';

export const otelRouter = Router();

function isOtelPlan(): boolean {
  const plan = getActivePlanId();
  return plan === 'solo_pro' || plan === 'team';
}

/** GET /otel-config */
otelRouter.get('/otel-config', (_req: Request, res: Response): void => {
  const cfg = getOtelConfig();
  if (!cfg) {
    res.json({ enabled: false });
    return;
  }
  // Never expose headers (may contain auth tokens)
  res.json({
    enabled: cfg.enabled,
    endpoint: cfg.endpoint,
    serviceName: cfg.serviceName ?? 'mergen',
    configuredAt: cfg.configuredAt,
    headerCount: Object.keys(cfg.headers ?? {}).length,
  });
});

/** POST /otel-config { endpoint, headers?, serviceName? } */
otelRouter.post('/otel-config', async (req: Request, res: Response): Promise<void> => {
  if (!isOtelPlan()) {
    res.status(403).json({
      error: 'OpenTelemetry export requires Solo Pro or Team plan',
      upgradeUrl: 'https://mergen.dev/pricing',
    });
    return;
  }

  const { endpoint, headers, serviceName } = req.body as {
    endpoint?: string;
    headers?: Record<string, string>;
    serviceName?: string;
  };

  if (!endpoint || typeof endpoint !== 'string' || !endpoint.startsWith('http')) {
    res.status(400).json({ error: 'endpoint must be a valid HTTP(S) URL' });
    return;
  }

  if (headers !== undefined && (typeof headers !== 'object' || Array.isArray(headers))) {
    res.status(400).json({ error: 'headers must be a flat object of string values' });
    return;
  }

  const cfg: OtelConfig = {
    endpoint: endpoint.trim(),
    headers: headers ?? {},
    serviceName: (serviceName ?? 'mergen').trim(),
    enabled: true,
    configuredAt: new Date().toISOString(),
  };

  try {
    await configureOtel(cfg);
    logger.info({ endpoint: cfg.endpoint }, 'OTel config updated via API');
    res.json({ ok: true, endpoint: cfg.endpoint, serviceName: cfg.serviceName });
  } catch (err) {
    logger.error({ err }, 'OTel provider setup failed');
    res.status(500).json({ error: 'Failed to initialize OTLP exporter', detail: String(err) });
  }
});

/** DELETE /otel-config */
otelRouter.delete('/otel-config', async (_req: Request, res: Response): Promise<void> => {
  await disableOtel();
  res.json({ ok: true });
});

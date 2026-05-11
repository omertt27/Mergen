/**
 * routes/telemetry.ts — Opt-in anonymous telemetry endpoints.
 *
 * GET  /telemetry                    — current opt-in state + installId
 * POST /telemetry { enabled: bool }  — opt in or out
 */
import { Router } from 'express';
import { getTelemetryState, setTelemetryEnabled } from '../intelligence/telemetry.js';

export function createTelemetryRouter(): Router {
  const router = Router();

  router.get('/telemetry', (_req, res) => {
    const t = getTelemetryState();
    res.json({
      ok: true,
      enabled: t.enabled,
      installId: t.installId,
      lastSentAt: t.lastSentAt,
      endpointConfigured: Boolean(process.env.MERGEN_TELEMETRY_URL),
    });
  });

  router.post('/telemetry', async (req, res) => {
    const { enabled } = (req.body ?? {}) as { enabled?: boolean };
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled (boolean) is required' });
      return;
    }
    await setTelemetryEnabled(enabled);
    res.json({ ok: true, enabled });
  });

  return router;
}

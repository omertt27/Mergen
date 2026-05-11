/**
 * routes/license.ts — License activation / deactivation endpoints.
 *
 * GET  /license          — current plan + activation state
 * POST /license { key }  — activate a LemonSqueezy key
 * DELETE /license        — deactivate and revert to free
 */
import { Router } from 'express';
import { getLicenseState, activateKey, deactivateKey, getActivePlanId } from '../intelligence/license.js';
import { getPlan } from '../intelligence/plans.js';
import logger from '../sensor/logger.js';

export function createLicenseRouter(): Router {
  const router = Router();

  router.get('/license', (_req, res) => {
    const state = getLicenseState();
    const planId = getActivePlanId();
    const plan = getPlan(planId);
    res.json({
      plan: {
        id: plan.id,
        name: plan.name,
        bufferSize: plan.bufferSize,
        analyzeCreditsPerMonth: plan.analyzeCreditsPerMonth === Infinity ? null : plan.analyzeCreditsPerMonth,
        teamSync: plan.teamSync,
      },
      license: state
        ? { status: state.status, email: state.customerEmail, name: state.customerName, activatedAt: state.activatedAt }
        : null,
    });
  });

  router.post('/license', async (req, res) => {
    const { key } = req.body as { key?: string };
    if (!key || typeof key !== 'string' || key.trim().length === 0) {
      res.status(400).json({ error: 'key is required' });
      return;
    }
    try {
      const state = await activateKey(key.trim());
      res.json({ ok: true, plan: state.planId, email: state.customerEmail });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'activation failed';
      logger.warn({ err }, 'license activation failed');
      res.status(422).json({ error: msg });
    }
  });

  router.delete('/license', async (_req, res) => {
    await deactivateKey();
    res.json({ ok: true, plan: 'free' });
  });

  return router;
}

/**
 * routes/license.ts — License activation / deactivation endpoints.
 *
 * GET  /license          — current plan + activation state
 * POST /license { key }  — activate a LemonSqueezy key
 * DELETE /license        — deactivate and revert to free
 */
import { Router } from 'express';
import { getLicenseState, activateKey, deactivateKey, getActivePlanId } from '../intelligence/license.js';
import { getPlan, PLANS, PLAN_ORDER } from '../intelligence/plans.js';
import logger from '../sensor/logger.js';

export function createLicenseRouter(): Router {
  const router = Router();

  router.get('/license', (_req, res) => {
    const state  = getLicenseState();
    const planId = getActivePlanId();
    const plan   = getPlan(planId);

    // The next plan up the ladder (if any) — drives the extension's upgrade CTA.
    const nextPlanId = PLAN_ORDER.find((id) => PLANS[id].rank === plan.rank + 1);
    const nextPlan   = nextPlanId ? getPlan(nextPlanId) : null;

    res.json({
      plan: {
        id:   plan.id,
        name: plan.name,
        rank: plan.rank,
        bufferSize: plan.bufferSize,
        maxServices: plan.maxServices === Infinity ? null : plan.maxServices,
        capabilities: plan.capabilities,
        ctaUrl: plan.ctaUrl,
        analyzeCreditsPerMonth: (plan.analyzeCreditsPerMonth as number) === Infinity
          ? null : plan.analyzeCreditsPerMonth,
      },
      nextPlan: nextPlan ? {
        id:               nextPlan.id,
        name:             nextPlan.name,
        tagline:          nextPlan.tagline,
        priceDescription: nextPlan.priceDescription,
        ctaUrl:           nextPlan.ctaUrl,
        capabilities:     nextPlan.capabilities,
      } : null,
      license: state ? {
        status:      (state as Record<string, unknown>).status ?? 'active',
        email:       state.customerEmail ?? null,
        name:        (state as Record<string, unknown>).customerName as string ?? null,
        activatedAt: (state as Record<string, unknown>).validatedAt ?? null,
      } : null,
    });
  });

  router.post('/license', async (req, res) => {
    const { key } = req.body as { key?: string };
    if (!key || typeof key !== 'string' || key.trim().length === 0) {
      res.status(400).json({ error: 'key is required' });
      return;
    }
    try {
      const result = await activateKey(key.trim());
      res.json({ ok: true, plan: result['planId'], email: result['email'] });
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

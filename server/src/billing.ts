/**
 * billing.ts — LemonSqueezy webhook handler.
 *
 * Handles these events:
 *   subscription_created  → activate / upgrade plan
 *   subscription_updated  → plan change
 *   subscription_expired  → downgrade to free
 *   order_created         → one-time PAYG top-up (future)
 *
 * Webhook signature is verified using HMAC-SHA256.
 * Set LS_WEBHOOK_SECRET in your environment (from LS Dashboard → Webhooks).
 */

import crypto from 'crypto';
import { Router, type Request, type Response } from 'express';
import { lemonSqueezySetup } from '@lemonsqueezy/lemonsqueezy.js';
import logger from './logger.js';
import { getLicenseState, getActivePlanId } from './license.js';
import { getPlan, PLANS, type PlanId } from './plans.js';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const LS_WEBHOOK_SECRET = process.env.LS_WEBHOOK_SECRET ?? '';
const DATA_DIR  = path.join(os.homedir(), '.mergen');
const LICENSE_FILE = path.join(DATA_DIR, 'license.json');

export const billingRouter = Router();

function verifySignature(rawBody: Buffer, signature: string): boolean {
  if (!LS_WEBHOOK_SECRET) return true; // dev mode: skip verification
  const expected = crypto
    .createHmac('sha256', LS_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

function planFromVariantId(variantId: string | number | undefined): PlanId {
  const vid = String(variantId ?? '');
  for (const plan of Object.values(PLANS)) {
    if (plan.lsVariantId && plan.lsVariantId === vid) return plan.id;
  }
  return 'solo_standard';
}

billingRouter.post(
  '/billing/webhook',
  // Must use raw body for HMAC — express.json() must NOT parse this route
  express_rawBody(),
  async (req: Request, res: Response): Promise<void> => {
    const signature = req.headers['x-signature'] as string;

    if (!verifySignature(req.body as Buffer, signature ?? '')) {
      logger.warn('webhook signature mismatch');
      res.status(401).json({ error: 'invalid signature' });
      return;
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse((req.body as Buffer).toString('utf8'));
    } catch {
      res.status(400).json({ error: 'invalid JSON' });
      return;
    }

    const eventName = payload.meta && (payload.meta as Record<string, unknown>).event_name as string;
    const attrs = (payload.data as Record<string, unknown>)?.attributes as Record<string, unknown> | undefined;

    logger.info({ eventName }, 'LS webhook received');

    switch (eventName) {
      case 'subscription_created':
      case 'subscription_updated': {
        const variantId = attrs?.variant_id as string | number | undefined;
        const status    = attrs?.status as string;
        const email     = (attrs?.user_email as string) ?? '';
        const name      = (attrs?.user_name as string) ?? '';
        const planId    = planFromVariantId(variantId);

        // Extract the first subscription item ID for usage-based billing
        // LS puts items in attrs.first_subscription_item or we fetch from relationships
        const subItemId = (attrs?.first_subscription_item as Record<string, unknown> | undefined)?.id
          ?? (payload.data as Record<string, unknown>)?.id; // fallback to subscription id

        const current = await readLicenseFile();
        const updated: Record<string, unknown> = {
          ...(current ?? {}),
          planId,
          status: status === 'active' ? 'active' : 'inactive',
          customerEmail: email,
          customerName: name,
          validatedAt: new Date().toISOString(),
        };

        // Store subscription item ID for usage-based billing (overage / PAYG)
        if (subItemId) updated['lsSubscriptionItemId'] = String(subItemId);

        await writeLicenseFile(updated);
        logger.info({ planId, email, subItemId }, `subscription ${eventName}`);
        break;
      }

      case 'order_created': {
        // For PAYG one-time orders, store the order item so we can report usage
        const orderId = (payload.data as Record<string, unknown>)?.id;
        const email   = (attrs?.user_email as string) ?? '';
        const variantId = (attrs?.first_order_item as Record<string, unknown> | undefined)?.variant_id as string | number | undefined;
        const planId = planFromVariantId(variantId);

        const current = await readLicenseFile();
        if (current) {
          const updated = {
            ...current,
            planId,
            status: 'active',
            customerEmail: email,
            validatedAt: new Date().toISOString(),
            ...(orderId ? { lsSubscriptionItemId: String(orderId) } : {}),
          };
          await writeLicenseFile(updated);
          logger.info({ planId, email, orderId }, 'order_created — license patched');
        }
        break;
      }

      case 'subscription_expired':
      case 'subscription_cancelled': {
        const current = await readLicenseFile();
        if (current) {
          await writeLicenseFile({ ...current, planId: 'free', status: 'inactive' });
        }
        logger.info('subscription expired — downgraded to free');
        break;
      }

      default:
        logger.info({ eventName }, 'unhandled webhook event');
    }

    res.status(200).json({ ok: true });
  }
);

// ── Helpers ───────────────────────────────────────────────────────────────────

/** express middleware that captures the raw body as a Buffer */
function express_rawBody() {
  return function rawBodyMiddleware(
    req: Request,
    _res: Response,
    next: (err?: unknown) => void
  ): void {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      req.body = Buffer.concat(chunks);
      next();
    });
    req.on('error', next);
  };
}

async function readLicenseFile(): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fs.readFile(LICENSE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeLicenseFile(data: Record<string, unknown>): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(LICENSE_FILE, JSON.stringify(data, null, 2), 'utf8');
}

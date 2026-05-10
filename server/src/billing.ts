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
import fs from 'fs/promises';
import { Router, type Request, type Response } from 'express';
import { lemonSqueezySetup } from '@lemonsqueezy/lemonsqueezy.js';
import logger from './logger.js';
import { planFromVariantId } from './license.js';   // P1.1 — single source of truth
import { DATA_DIR, LICENSE_FILE } from './paths.js'; // P4.1 — no more local path strings

const LS_WEBHOOK_SECRET = process.env.LS_WEBHOOK_SECRET ?? '';

// P1.2: Log a startup warning when the secret is missing so it's caught early.
if (!LS_WEBHOOK_SECRET) {
  logger.warn(
    'LS_WEBHOOK_SECRET is not set — webhook signature verification is DISABLED. ' +
    'Set this env var before going to production.',
  );
}

export const billingRouter = Router();

function verifySignature(rawBody: Buffer, signature: string, secret = LS_WEBHOOK_SECRET): boolean {
  // P1.2: Hard-reject if secret is not configured (fail-closed in production).
  if (!secret) return false;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');
  // timingSafeEqual requires equal-length buffers — a short/long forged
  // signature must be treated as a mismatch, not throw a RangeError.
  const expBuf = Buffer.from(expected);
  const sigBuf = Buffer.from(signature);
  if (expBuf.length !== sigBuf.length) return false;
  return crypto.timingSafeEqual(expBuf, sigBuf);
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
        const planId    = planFromVariantId(variantId);   // P1.1 — no local duplicate

        // Extract the first subscription item ID for usage-based billing
        const subItemId = (attrs?.first_subscription_item as Record<string, unknown> | undefined)?.id
          ?? (payload.data as Record<string, unknown>)?.id;

        const current = await readLicenseFile();
        const updated: Record<string, unknown> = {
          ...(current ?? {}),
          planId,
          status: status === 'active' ? 'active' : 'inactive',
          customerEmail: email,
          customerName: name,
          validatedAt: new Date().toISOString(),
        };

        if (subItemId) updated['lsSubscriptionItemId'] = String(subItemId);

        await writeLicenseFile(updated);
        logger.info({ planId, email, subItemId }, `subscription ${eventName}`);
        break;
      }

      case 'order_created': {
        const orderId   = (payload.data as Record<string, unknown>)?.id;
        const email     = (attrs?.user_email as string) ?? '';
        const variantId = (attrs?.first_order_item as Record<string, unknown> | undefined)?.variant_id as string | number | undefined;
        const planId    = planFromVariantId(variantId);

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

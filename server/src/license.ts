/**
 * license.ts — LemonSqueezy license key activation, validation & local persistence.
 *
 * Flow:
 *   1. User buys a plan on LemonSqueezy → receives a license key by email.
 *   2. Extension popup POST /license { key } → server activates it with LS API.
 *   3. Activation response contains the variant_id → we resolve the PlanId.
 *   4. State is saved to ~/.mergen/license.json and kept in memory.
 *   5. On startup we re-validate the cached key (once) to catch revocations.
 *   6. GET /license returns the current state (plan, status, name, email).
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { lemonSqueezySetup, activateLicense, validateLicense, deactivateLicense } from '@lemonsqueezy/lemonsqueezy.js';
import { getPlan, PLANS, type PlanId } from './plans.js';
import logger from './logger.js';

// ── Config ────────────────────────────────────────────────────────────────────

const LS_API_KEY = process.env.LS_API_KEY ?? '';
const LS_STORE_ID = process.env.LS_STORE_ID ?? '';

// The instance name identifies this machine's activation (LS allows multiple
// activations per key up to the plan limit).
const INSTANCE_NAME = `mergen-${os.hostname()}`;

const DATA_DIR = path.join(os.homedir(), '.mergen');
const LICENSE_FILE = path.join(DATA_DIR, 'license.json');

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LicenseState {
  key: string;
  instanceId: string;
  planId: PlanId;
  status: 'active' | 'inactive' | 'expired' | 'disabled';
  customerName: string;
  customerEmail: string;
  activatedAt: string; // ISO
  validatedAt: string; // ISO — last successful remote check
}

// ── In-memory state ───────────────────────────────────────────────────────────

let _state: LicenseState | null = null;

export function getLicenseState(): LicenseState | null {
  return _state;
}

export function getActivePlanId(): PlanId {
  if (_state?.status === 'active') return _state.planId;
  return 'free';
}

// ── Persistence ───────────────────────────────────────────────────────────────

async function persist(state: LicenseState): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(LICENSE_FILE, JSON.stringify(state, null, 2), 'utf8');
  _state = state;
}

async function loadFromDisk(): Promise<LicenseState | null> {
  try {
    const raw = await fs.readFile(LICENSE_FILE, 'utf8');
    return JSON.parse(raw) as LicenseState;
  } catch {
    return null;
  }
}

// ── Variant → Plan mapping ────────────────────────────────────────────────────

function planFromVariantId(variantId: number | string | undefined): PlanId {
  const vid = String(variantId ?? '');
  for (const plan of Object.values(PLANS)) {
    if (plan.lsVariantId && plan.lsVariantId === vid) return plan.id;
  }
  // Fallback: if we can't map the variant treat as solo_standard
  logger.warn({ variantId }, 'unknown variant ID — defaulting to solo_standard');
  return 'solo_standard';
}

// ── Init (called at startup) ──────────────────────────────────────────────────

export async function initLicense(): Promise<void> {
  if (!LS_API_KEY) {
    logger.info('LS_API_KEY not set — running in free mode');
    return;
  }

  lemonSqueezySetup({ apiKey: LS_API_KEY });

  const cached = await loadFromDisk();
  if (!cached) {
    logger.info('no license found — running in free mode');
    return;
  }

  // Re-validate against LS to catch revocations / expirations
  try {
    const { data, error } = await validateLicense(cached.key, cached.instanceId);
    if (error || !data?.valid) {
      logger.warn({ error }, 'license validation failed — falling back to free');
      cached.status = 'inactive';
      _state = cached;
      return;
    }

    const updated: LicenseState = {
      ...cached,
      status: 'active',
      validatedAt: new Date().toISOString(),
    };
    await persist(updated);
    logger.info({ plan: updated.planId }, 'license validated on startup');
  } catch (err) {
    // Network error during validation — trust the cached state for now
    logger.warn({ err }, 'could not reach LS API — trusting cached license');
    _state = cached;
  }
}

// ── Activate (called from POST /license) ─────────────────────────────────────

export async function activateKey(key: string): Promise<LicenseState> {
  if (!LS_API_KEY) throw new Error('LS_API_KEY not configured on this server');

  lemonSqueezySetup({ apiKey: LS_API_KEY });

  const { data, error } = await activateLicense(key, INSTANCE_NAME);

  if (error || !data?.activated) {
    throw new Error(error?.message ?? 'activation failed');
  }

  const meta = data.meta;
  const variantId = meta?.variant_id;
  const planId = planFromVariantId(variantId);

  const state: LicenseState = {
    key,
    instanceId: data.instance?.id ?? '',
    planId,
    status: 'active',
    customerName: meta?.customer_name ?? '',
    customerEmail: meta?.customer_email ?? '',
    activatedAt: new Date().toISOString(),
    validatedAt: new Date().toISOString(),
  };

  await persist(state);
  logger.info({ planId, customer: state.customerEmail }, 'license activated');
  return state;
}

// ── Deactivate (called from DELETE /license) ──────────────────────────────────

export async function deactivateKey(): Promise<void> {
  if (!_state) return;

  lemonSqueezySetup({ apiKey: LS_API_KEY });

  try {
    await deactivateLicense(_state.key, _state.instanceId);
  } catch (err) {
    logger.warn({ err }, 'LS deactivation request failed (continuing local deactivation)');
  }

  await fs.rm(LICENSE_FILE, { force: true });
  _state = null;
  logger.info('license deactivated');
}

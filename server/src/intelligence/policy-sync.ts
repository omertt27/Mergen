import crypto from 'crypto';
import { loadEnterprisePolicy, saveEnterprisePolicy, EnterprisePolicyConfig } from './enterprise-policy-engine.js';
import logger from '../sensor/logger.js';

export interface PolicySyncOptions {
  url:         string;
  intervalMs?: number;
  mergeMode?:  'replace' | 'merge';
}

// Rule IDs that are never removed or overridden by a remote policy, regardless
// of merge mode. These are the hard-safety guardrails that must always be active.
const IMMUTABLE_RULE_IDS = new Set(['block_destructive_commands']);

let _lastEtag = '';

function verifyPolicySignature(body: string, signature: string | null, secret: string): boolean {
  if (!signature) return false;
  // Expected format: "sha256=<hex>"
  const [algo, hex] = signature.split('=');
  if (algo !== 'sha256' || !hex) return false;
  const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(hex, 'hex'), Buffer.from(expected, 'hex'));
}

async function fetchAndApply(opts: PolicySyncOptions): Promise<void> {
  const hmacSecret = process.env.MERGEN_POLICY_HMAC_SECRET;

  const headers: Record<string, string> = { 'Accept': 'application/json' };
  if (_lastEtag) headers['If-None-Match'] = _lastEtag;

  let resp: Response;
  try {
    resp = await fetch(opts.url, { headers, signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    logger.warn({ err, url: opts.url }, 'policy-sync: fetch failed (non-fatal)');
    return;
  }

  if (resp.status === 304) {
    logger.debug({ url: opts.url }, 'policy-sync: policy unchanged');
    return;
  }

  if (!resp.ok) {
    logger.warn({ status: resp.status, url: opts.url }, 'policy-sync: remote returned non-2xx (non-fatal)');
    return;
  }

  const etag = resp.headers.get('etag') ?? '';

  // Read raw body text so we can verify HMAC before parsing JSON.
  let rawBody: string;
  try {
    rawBody = await resp.text();
  } catch (err) {
    logger.warn({ err }, 'policy-sync: could not read response body');
    return;
  }

  // If MERGEN_POLICY_HMAC_SECRET is configured, reject responses with a missing
  // or invalid X-Mergen-Policy-Signature header. This prevents a DNS-hijack or
  // MITM from injecting a permissive policy that disables the safety gates.
  if (hmacSecret) {
    const sig = resp.headers.get('x-mergen-policy-signature');
    if (!verifyPolicySignature(rawBody, sig, hmacSecret)) {
      logger.error(
        { url: opts.url, hasSignature: !!sig },
        'policy-sync: HMAC signature verification failed — remote policy rejected. ' +
        'Ensure the policy server sends X-Mergen-Policy-Signature: sha256=<hmac> keyed with MERGEN_POLICY_HMAC_SECRET.',
      );
      return;
    }
    logger.debug({ url: opts.url }, 'policy-sync: HMAC signature verified');
  }

  let incoming: EnterprisePolicyConfig;
  try {
    incoming = JSON.parse(rawBody) as EnterprisePolicyConfig;
  } catch (err) {
    logger.warn({ err }, 'policy-sync: could not parse remote policy JSON');
    return;
  }

  const local  = loadEnterprisePolicy();
  const mode   = opts.mergeMode ?? 'replace';
  let merged: EnterprisePolicyConfig;

  if (mode === 'merge') {
    const existingIds = new Set(local.rules.map(r => r.id));
    merged = { ...local, rules: [...local.rules, ...incoming.rules.filter(r => !existingIds.has(r.id))] };
  } else {
    // In replace mode, remote policy fully replaces local — EXCEPT immutable hard-safety
    // rules (block_destructive_commands). Those survive any remote replace so a misconfigured
    // or compromised policy server cannot disable the destructive-command gate.
    const immutableRules = local.rules.filter(r => IMMUTABLE_RULE_IDS.has(r.id));
    const remoteRulesWithoutImmutable = incoming.rules.filter(r => !IMMUTABLE_RULE_IDS.has(r.id));
    merged = { ...incoming, rules: [...immutableRules, ...remoteRulesWithoutImmutable] };

    const keptIds = immutableRules.map(r => r.id);
    if (keptIds.length > 0) {
      logger.info({ keptIds }, 'policy-sync: preserved immutable local rules during replace');
    }
  }

  try {
    saveEnterprisePolicy(merged);
    _lastEtag = etag;
    logger.info({ url: opts.url, mode, ruleCount: merged.rules.length }, 'policy-sync: policy synced');
  } catch (err) {
    logger.warn({ err }, 'policy-sync: failed to save synced policy (non-fatal)');
  }
}

export function startPolicySync(opts: PolicySyncOptions): void {
  const intervalMs = opts.intervalMs ?? 5 * 60 * 1_000;

  // Enforce HTTPS for remote policy URLs — plain HTTP allows a passive observer
  // or MITM to inject a permissive policy even without HMAC being configured.
  if (!opts.url.startsWith('https://')) {
    logger.error(
      { url: opts.url },
      'policy-sync: MERGEN_POLICY_URL must use HTTPS to prevent policy injection over plain HTTP. ' +
      'Update MERGEN_POLICY_URL to an https:// address and restart.',
    );
    return;
  }

  const hmacSecret = process.env.MERGEN_POLICY_HMAC_SECRET;
  if (!hmacSecret) {
    logger.warn(
      { url: opts.url },
      'policy-sync: MERGEN_POLICY_HMAC_SECRET is not set — remote policy responses are not signature-verified. ' +
      'A compromised MERGEN_POLICY_URL could inject permissive rules. ' +
      'Set MERGEN_POLICY_HMAC_SECRET to a shared secret and configure the policy server to sign responses.',
    );
  }

  void fetchAndApply(opts);
  const timer = setInterval(() => void fetchAndApply(opts), intervalMs);
  timer.unref();
  logger.info({ url: opts.url, intervalMs, mergeMode: opts.mergeMode ?? 'replace', hmacVerification: !!hmacSecret }, 'policy-sync: started');
}

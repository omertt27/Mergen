import { loadEnterprisePolicy, saveEnterprisePolicy, EnterprisePolicyConfig } from './enterprise-policy-engine.js';
import logger from '../sensor/logger.js';

export interface PolicySyncOptions {
  url:         string;
  intervalMs?: number;
  mergeMode?:  'replace' | 'merge';
}

let _lastEtag = '';

async function fetchAndApply(opts: PolicySyncOptions): Promise<void> {
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
  let incoming: EnterprisePolicyConfig;
  try {
    incoming = await resp.json() as EnterprisePolicyConfig;
  } catch (err) {
    logger.warn({ err }, 'policy-sync: could not parse remote policy JSON');
    return;
  }

  const mode = opts.mergeMode ?? 'replace';
  let merged: EnterprisePolicyConfig;

  if (mode === 'merge') {
    const local = loadEnterprisePolicy();
    const existingIds = new Set(local.rules.map(r => r.id));
    merged = { ...local, rules: [...local.rules, ...incoming.rules.filter(r => !existingIds.has(r.id))] };
  } else {
    merged = incoming;
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
  void fetchAndApply(opts);
  const timer = setInterval(() => void fetchAndApply(opts), intervalMs);
  timer.unref();
  logger.info({ url: opts.url, intervalMs, mergeMode: opts.mergeMode ?? 'replace' }, 'policy-sync: started');
}

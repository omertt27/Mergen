/**
 * k8s-events.ts — Kubernetes events poller.
 *
 * Polls `kubectl get events -n <namespace> -o json` every 30 seconds and
 * normalizes Warning events into InfraEvent[] for the causal engine.
 *
 * Why kubectl and not the k8s API?
 *   kubectl is what engineers have. No SDK, no KUBECONFIG parsing, no cert
 *   management in Node — just the same CLI the on-call engineer would run.
 *   If kubectl works from the terminal, it works here.
 *
 * Activation: set MERGEN_K8S_NAMESPACE=production (or comma-separated list)
 *
 * Covered k8s event reasons:
 *   OOMKilling           → oom_kill
 *   BackOff (crashloop)  → pod_crash
 *   Evicted              → oom_kill or disk_pressure
 *   Failed (ImagePull)   → pod_crash
 *   NodeNotReady         → service_unavailable
 *   NodeHasDiskPressure  → disk_pressure
 *   Unhealthy            → pod_crash (readiness/liveness probe fail)
 *   FailedMount          → pod_crash (volume mount failure)
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import type { InfraEvent } from './infra-normalizer.js';
import logger from './logger.js';

const execFileAsync = promisify(execFile);

const POLL_INTERVAL_MS = 30_000;
const MAX_BUFFERED    = 500;

// Events window: only surface events from the last 10 minutes to avoid
// replaying old events on restart. k8s events have their own timestamps.
const EVENT_WINDOW_MS = 10 * 60 * 1000;

interface K8sEventItem {
  metadata:       { uid: string; creationTimestamp: string };
  involvedObject: { name: string; namespace?: string; kind: string };
  reason:         string;
  message:        string;
  type:           'Normal' | 'Warning';
  count:          number;
  firstTimestamp: string | null;
  lastTimestamp:  string | null;
  eventTime:      string | null;
}

interface K8sEventList {
  items: K8sEventItem[];
}

// ── Ring buffer of normalized events ─────────────────────────────────────────

const _buffer: InfraEvent[] = [];
const _seenUids = new Set<string>();

function push(event: InfraEvent): void {
  _buffer.push(event);
  if (_buffer.length > MAX_BUFFERED) _buffer.shift();
}

// ── Normalization ─────────────────────────────────────────────────────────────

function toTimestamp(item: K8sEventItem): number {
  const raw = item.lastTimestamp ?? item.firstTimestamp ?? item.eventTime ?? item.metadata.creationTimestamp;
  return raw ? new Date(raw).getTime() : Date.now();
}

function normalizeEvent(item: K8sEventItem, namespace: string): InfraEvent | null {
  if (item.type === 'Normal') return null;

  const reason  = (item.reason ?? '').toLowerCase();
  const message = item.message ?? '';
  const msgLow  = message.toLowerCase();
  const service = item.involvedObject.name;
  const ts      = toTimestamp(item);
  const attrs: Record<string, string | number> = {
    namespace,
    objectKind: item.involvedObject.kind,
    k8sReason: item.reason,
    count: item.count ?? 1,
  };

  // OOM kill
  if (reason === 'oomkilling' || reason === 'oom' || msgLow.includes('oom')) {
    return { kind: 'oom_kill', timestamp: ts, service, severity: 'critical', message, attributes: attrs, source: 'k8s' };
  }

  // CrashLoopBackOff / container back-off
  if (reason === 'backoff' || msgLow.includes('back-off') || msgLow.includes('crashloop')) {
    return { kind: 'pod_crash', timestamp: ts, service, severity: 'critical', message, attributes: attrs, source: 'k8s' };
  }

  // Pod eviction (OOM-driven or disk-driven)
  if (reason === 'evicting' || reason === 'evicted') {
    const isDisk = msgLow.includes('disk') || msgLow.includes('ephemeral') || msgLow.includes('storage');
    return { kind: isDisk ? 'disk_pressure' : 'oom_kill', timestamp: ts, service, severity: 'critical', message, attributes: attrs, source: 'k8s' };
  }

  // Image pull failure
  if ((reason === 'failed' || reason === 'failedsync') && (msgLow.includes('imagepull') || msgLow.includes('errimagepull') || msgLow.includes('image pull'))) {
    return { kind: 'pod_crash', timestamp: ts, service, severity: 'critical', message, attributes: { ...attrs, k8sReason: 'ImagePullError' }, source: 'k8s' };
  }

  // Readiness / liveness probe failure
  if (reason === 'unhealthy') {
    return { kind: 'pod_crash', timestamp: ts, service, severity: 'high', message, attributes: attrs, source: 'k8s' };
  }

  // Volume / secret / configmap mount failure
  if (reason === 'failedmount' || reason === 'failedattachvolume') {
    return { kind: 'pod_crash', timestamp: ts, service, severity: 'critical', message, attributes: attrs, source: 'k8s' };
  }

  // Node disk pressure
  if (reason === 'nodehasdiskcapacity' || msgLow.includes('disk pressure')) {
    return { kind: 'disk_pressure', timestamp: ts, service, severity: 'high', message, attributes: attrs, source: 'k8s' };
  }

  // Node not ready
  if (reason === 'nodenotready' || reason === 'notready') {
    return { kind: 'service_unavailable', timestamp: ts, service, severity: 'critical', message, attributes: attrs, source: 'k8s' };
  }

  // Rate limiting from Kubernetes API / admission webhooks
  if (reason === 'toomanyrequests' || msgLow.includes('rate limit') || msgLow.includes('429')) {
    return { kind: 'rate_limit_cascade', timestamp: ts, service, severity: 'high', message, attributes: attrs, source: 'k8s' };
  }

  return null;
}

// ── Polling ───────────────────────────────────────────────────────────────────

async function pollNamespace(namespace: string): Promise<void> {
  let stdout: string;
  try {
    const result = await execFileAsync('kubectl', ['get', 'events', '-n', namespace, '-o', 'json'], {
      timeout: 10_000,
      maxBuffer: 4 * 1024 * 1024, // 4 MB
    });
    stdout = result.stdout;
  } catch {
    // kubectl not available or namespace doesn't exist — silent fail
    return;
  }

  let list: K8sEventList;
  try {
    list = JSON.parse(stdout) as K8sEventList;
  } catch {
    return;
  }

  if (!Array.isArray(list?.items)) return;

  const cutoff = Date.now() - EVENT_WINDOW_MS;
  for (const item of list.items) {
    const uid = item.metadata?.uid;
    if (!uid || _seenUids.has(uid)) continue;

    const normalized = normalizeEvent(item, namespace);
    if (!normalized) { _seenUids.add(uid); continue; }
    if (normalized.timestamp < cutoff) { _seenUids.add(uid); continue; }

    _seenUids.add(uid);
    push(normalized);
    logger.debug({ kind: normalized.kind, service: normalized.service, namespace }, 'k8s-events: new event');
  }

  // Bound the seen-uid set to avoid unbounded growth
  if (_seenUids.size > 10_000) {
    const arr = [..._seenUids];
    arr.slice(0, 5_000).forEach((uid) => _seenUids.delete(uid));
  }
}

let _pollHandle: ReturnType<typeof setInterval> | null = null;
let _namespaces: string[] = [];

/**
 * Start the k8s events poller. No-op if MERGEN_K8S_NAMESPACE is not set.
 * Returns a cleanup function that stops the poll loop.
 */
export function startK8sEventsPoller(): () => void {
  const raw = process.env.MERGEN_K8S_NAMESPACE;
  if (!raw) return () => { /* no-op */ };

  _namespaces = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (_namespaces.length === 0) return () => { /* no-op */ };

  logger.info({ namespaces: _namespaces }, 'k8s-events: polling started');

  // Initial poll immediately, then every 30s
  void Promise.all(_namespaces.map(pollNamespace));
  _pollHandle = setInterval(() => {
    void Promise.all(_namespaces.map(pollNamespace));
  }, POLL_INTERVAL_MS);
  _pollHandle.unref();

  return () => {
    if (_pollHandle) { clearInterval(_pollHandle); _pollHandle = null; }
    logger.info('k8s-events: polling stopped');
  };
}

/**
 * Returns all buffered k8s InfraEvents, optionally filtered to those at or
 * after `since` (ms epoch). Called by incident-autopilot before building
 * the causal chain.
 */
export function getK8sEvents(since?: number): InfraEvent[] {
  if (since === undefined) return [..._buffer];
  return _buffer.filter((e) => e.timestamp >= since);
}

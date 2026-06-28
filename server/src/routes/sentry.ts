/**
 * routes/sentry.ts — Sentry webhook ingest endpoint.
 *
 * Accepts Sentry error webhooks (action: "triggered" on issue.created /
 * issue.resolved / event.alert) and maps them into Mergen's BrowserEvent
 * format so they appear in the ring buffer alongside browser telemetry.
 *
 * This turns Sentry into a distribution channel: teams that already have
 * Sentry for production can forward errors here and get Mergen's causal
 * analysis in their IDE without uninstalling Sentry.
 *
 * Sentry webhook payload reference:
 * https://docs.sentry.io/organization/integrations/integration-platform/webhooks/
 *
 * Endpoint:  POST /webhook/sentry
 * Auth:      optional MERGEN_SENTRY_SECRET env var (Sentry's "client_secret")
 *            verified via HMAC-SHA256 on the raw body (sentry-hook-signature header)
 */

import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { store } from '../sensor/buffer.js';
import { hypothesisHistory } from '../intelligence/hypothesis-history.js';
import logger from '../sensor/logger.js';

export const sentryRouter = Router();

// ── Optional HMAC verification ────────────────────────────────────────────────
// Sentry signs webhook payloads with HMAC-SHA256 using the client_secret.
// Set MERGEN_SENTRY_SECRET to the Sentry Integration client_secret to enable.
const SENTRY_SECRET = process.env.MERGEN_SENTRY_SECRET;

function verifySignature(rawBody: Buffer, signature: string | undefined): boolean {
  if (!SENTRY_SECRET) return true; // verification disabled
  if (!signature) return false;
  const expected = crypto
    .createHmac('sha256', SENTRY_SECRET)
    .update(rawBody)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ── Sentry payload types (minimal, only what we need) ─────────────────────────

interface SentryException {
  type?: string;
  value?: string;
  stacktrace?: {
    frames?: Array<{
      filename?: string;
      lineno?: number;
      colno?: number;
      function?: string;
      abs_path?: string;
    }>;
  };
}

interface SentryEvent {
  event_id?: string;
  title?: string;
  culprit?: string;
  level?: string;
  environment?: string;
  release?: string;
  url?: string;
  request?: { url?: string; method?: string; data?: unknown };
  exception?: { values?: SentryException[] };
  logentry?: { message?: string; params?: unknown[] };
  breadcrumbs?: { values?: Array<{ type?: string; category?: string; message?: string; level?: string; timestamp?: number }> };
  timestamp?: number;
  tags?: Array<{ key: string; value: string }> | Record<string, string>;
}

interface SentryWebhookPayload {
  action?: string;
  data?: {
    issue?: {
      id?: string;
      title?: string;
      culprit?: string;
      level?: string;
      permalink?: string;
      project?: { name?: string; slug?: string };
    };
    event?: SentryEvent;
  };
  installation?: { uuid?: string };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildStackString(exc: SentryException): string {
  const frames = exc.stacktrace?.frames ?? [];
  const lines = frames
    .slice(-10) // most recent 10 frames
    .reverse()
    .map((f) => {
      const loc = f.filename ?? f.abs_path ?? '<unknown>';
      const line = f.lineno ? `:${f.lineno}` : '';
      const col  = f.colno  ? `:${f.colno}`  : '';
      const fn   = f.function ? ` (${f.function})` : '';
      return `  at ${loc}${line}${col}${fn}`;
    });
  const header = `${exc.type ?? 'Error'}: ${exc.value ?? ''}`;
  return [header, ...lines].join('\n');
}

function extractUrl(payload: SentryWebhookPayload): string {
  return (
    payload.data?.event?.request?.url ??
    payload.data?.issue?.permalink ??
    payload.data?.event?.url ??
    'sentry://webhook'
  );
}

// ── Route ─────────────────────────────────────────────────────────────────────

sentryRouter.post(
  '/webhook/sentry',
  // Raw body capture for HMAC verification — must run before express.json()
  // parses the body. We buffer the raw bytes here and then parse manually.
  (req: Request, res: Response) => {
    const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2 MB
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    req.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        res.status(413).json({ error: 'payload too large' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (res.headersSent) return;
      const rawBody = Buffer.concat(chunks);
      const signature = req.headers['sentry-hook-signature'] as string | undefined;

      if (!verifySignature(rawBody, signature)) {
        res.status(401).json({ error: 'invalid sentry-hook-signature' });
        return;
      }

      let payload: SentryWebhookPayload;
      try {
        payload = JSON.parse(rawBody.toString('utf8')) as SentryWebhookPayload;
      } catch {
        res.status(400).json({ error: 'malformed JSON' });
        return;
      }

      // Acknowledge immediately — Sentry retries on non-2xx within 30s
      res.status(200).json({ ok: true });

      // ── Map Sentry payload → BrowserEvents ─────────────────────────────────

      const action  = payload.action ?? 'unknown';
      const issue   = payload.data?.issue;
      const event   = payload.data?.event;
      const url     = extractUrl(payload);
      const now     = Date.now();

      // Only process error/warning issues and alerts
      if (!['created', 'triggered', 'assigned'].includes(action) && action !== 'unknown') {
        logger.debug({ action }, 'sentry webhook: ignoring non-error action');
        return;
      }

      const level = (issue?.level ?? event?.level ?? 'error').toLowerCase();
      const logLevel = level === 'warning' ? 'warn' : level === 'error' ? 'error' : 'log';

      // ── 1. Primary console event from the issue title ─────────────────────
      const title = issue?.title ?? event?.title ?? event?.logentry?.message ?? 'Sentry error';
      const culprit = issue?.culprit ?? event?.culprit ?? '';
      const env     = event?.environment ? ` [${event.environment}]` : '';
      const project = issue?.project?.name ? ` (${issue.project.name})` : '';

      const primaryArgs: string[] = [
        `[sentry${env}${project}] ${title}`,
        ...(culprit ? [`  at ${culprit}`] : []),
      ];

      // Build stack string from exception values
      let stackStr: string | undefined;
      const excValues = event?.exception?.values ?? [];
      if (excValues.length > 0) {
        stackStr = excValues.map(buildStackString).join('\n\nCaused by:\n');
      }

      store.push({
        type: 'console',
        level: logLevel,
        args: primaryArgs,
        stack: stackStr,
        url,
        timestamp: event?.timestamp ? Math.round(event.timestamp * 1000) : now,
      });

      // ── 2. Network event if there's a request context ──────────────────────
      if (event?.request?.url) {
        const method = (event.request.method ?? 'GET').toUpperCase();
        const reqUrl = event.request.url;
        // We don't have a status from the Sentry request context, so use 0 (network error)
        // unless the event level is not an error (in which case 200)
        const status = logLevel === 'error' ? 0 : 200;
        store.push({
          type: 'network',
          method,
          url: reqUrl,
          status,
          statusText: logLevel === 'error' ? 'Sentry Error Context' : 'ok',
          duration: 0,
          requestBody: event.request.data ?? undefined,
          error: logLevel === 'error' ? `Sentry captured: ${title}` : undefined,
          timestamp: event?.timestamp ? Math.round(event.timestamp * 1000) : now,
        });
      }

      // ── 3. Breadcrumbs as console.log events ─────────────────────────────
      const breadcrumbs = event?.breadcrumbs?.values ?? [];
      for (const crumb of breadcrumbs.slice(-10)) {
        const crumbLevel = (crumb.level ?? 'log').toLowerCase();
        const crumbLogLevel = crumbLevel === 'warning' ? 'warn'
          : crumbLevel === 'error' ? 'error' : 'log';
        const crumbMsg = [crumb.category, crumb.message].filter(Boolean).join(': ');
        if (!crumbMsg) continue;
        store.push({
          type: 'console',
          level: crumbLogLevel,
          args: [`[sentry:breadcrumb] ${crumbMsg}`],
          url,
          timestamp: crumb.timestamp ? Math.round(crumb.timestamp * 1000) : now - 1,
        });
      }

      // ── Trigger hypothesis rebuild on errors ──────────────────────────────
      if (logLevel === 'error') {
        hypothesisHistory.notifyError();
      }

      logger.info(
        { action, title: title.slice(0, 80), level: logLevel, breadcrumbs: breadcrumbs.length },
        'sentry webhook ingested',
      );
    });
  },
);

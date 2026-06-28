import crypto from 'crypto';
import { Router } from 'express';
import { z } from 'zod';
import { CLOUD_MODE } from '../sensor/cloud-auth.js';
import { fetchLatestErrorTrace, isConfigured } from '../datadog/client.js';
import { compact } from '../datadog/compactor.js';
import { setActiveIncident } from '../datadog/incident-state.js';
import { memoryStore } from '../datadog/memory-store.js';
import { fingerprintFromFact } from '../datadog/fingerprinter.js';
import { computeBlameAttribution } from '../datadog/blame-attribution.js';
import { postIncidentAlert } from '../intelligence/slack.js';
import { store } from '../sensor/buffer.js';
import { runIncidentAutopilot } from '../intelligence/incident-autopilot.js';
import { getRecords, recordVerdict } from '../intelligence/calibration.js';
import logger from '../sensor/logger.js';

const DASHBOARD_URL = process.env.MERGEN_DASHBOARD_URL ?? 'http://127.0.0.1:3000';

// Optional HMAC-SHA256 verification using PagerDuty V3 webhook signing.
// Set MERGEN_PAGERDUTY_SECRET to the signing secret from your PagerDuty webhook config.
// Header format: "X-PagerDuty-Signature: v1=<hex>[,v1=<hex>]" (multiple for key rotation).
const PD_WEBHOOK_SECRET = process.env.MERGEN_PAGERDUTY_SECRET;
if (PD_WEBHOOK_SECRET) {
  logger.info('pagerduty: webhook signature verification enabled');
} else if (CLOUD_MODE) {
  logger.error(
    'pagerduty: MERGEN_PAGERDUTY_SECRET is not set in cloud mode — all webhook requests will be rejected. ' +
    'Set MERGEN_PAGERDUTY_SECRET to the signing secret from your PagerDuty webhook config.',
  );
} else {
  logger.warn(
    'pagerduty: MERGEN_PAGERDUTY_SECRET is not set — webhook signature verification is DISABLED. ' +
    'Any caller can forge PagerDuty incident.triggered events and trigger autonomous execution. ' +
    'Set MERGEN_PAGERDUTY_SECRET to the signing secret from your PagerDuty webhook config.',
  );
}

function verifyPagerDutySignature(rawBody: Buffer, header: string | undefined): boolean {
  if (!PD_WEBHOOK_SECRET) {
    // When autopilot is enabled, reject all requests without a secret —
    // this endpoint triggers autonomous command execution and must not be left open.
    if (process.env.MERGEN_AUTOPILOT === 'true') return false;
    // In cloud mode, reject unconditionally (validated at boot too).
    if (CLOUD_MODE) return false;
    // Diagnosis-only local mode: allow (warning already logged at startup).
    return true;
  }
  if (!header) return false;
  const expected = 'v1=' + crypto
    .createHmac('sha256', PD_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');
  return header.split(',').some((sig) => {
    const s = sig.trim();
    try {
      return s.length === expected.length &&
        crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected));
    } catch { return false; }
  });
}

const PdMessageSchema = z.object({
  messages: z.array(
    z.object({
      event: z.object({
        event_type: z.string(),
        data: z.object({
          id: z.string(),
          summary: z.string().optional(),
          html_url: z.string().optional(),
          created_at: z.string().optional(),
          resolved_at: z.string().optional(),
          service: z.object({ summary: z.string() }).optional(),
        }),
      }),
    }),
  ),
});

export function createPagerDutyRouter(): Router {
  const router = Router();

  function handleWebhook(req: import('express').Request, res: import('express').Response): void {
    const tenantId = (req.params as Record<string, string>).tenantId as string | undefined;

    // In cloud mode, reject requests to the no-tenant path to prevent data
    // from landing in the wrong tenant's analysis context.
    if (CLOUD_MODE && !tenantId) {
      res.status(400).json({
        error: 'Cloud mode requires a tenant-scoped webhook URL: /webhooks/pagerduty/<tenantId>',
        docs: 'https://github.com/omertt27/Mergen/blob/main/INSTALL.md#pagerduty-cloud-mode',
      });
      return;
    }

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
      const signature = req.headers['x-pagerduty-signature'] as string | undefined;

      if (!verifyPagerDutySignature(rawBody, signature)) {
        res.status(401).json({ error: 'invalid x-pagerduty-signature' });
        return;
      }

      let body: unknown;
      try {
        body = JSON.parse(rawBody.toString('utf8'));
      } catch {
        res.status(400).json({ error: 'malformed JSON' });
        return;
      }

      const parsed = PdMessageSchema.safeParse(body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid PagerDuty payload' });
        return;
      }

      processMessages(parsed.data.messages, res, tenantId);
    });
  }

  // Local mode: no tenant segment (backwards-compatible)
  router.post('/webhooks/pagerduty', handleWebhook);
  // Cloud mode: tenant-scoped URL so autopilot reads only that tenant's events
  router.post('/webhooks/pagerduty/:tenantId', handleWebhook);

  function processMessages(
    messages: z.infer<typeof PdMessageSchema>['messages'],
    res: import('express').Response,
    tenantId?: string,
  ): void {
    for (const msg of messages) {
      const { event_type, data } = msg.event;

      // ── incident.resolved — record calibration verdict then close memory ────
      if (event_type === 'incident.resolved') {
        const resolvedAt = data.resolved_at
          ? new Date(data.resolved_at).getTime()
          : Date.now();

        // Feed calibration: for incidents resolved within 45 min without an
        // override, record a 'correct' verdict so the detector accuracy improves.
        const openRecord = memoryStore.listOpen().find((r) => r.pdIncidentId === data.id);
        if (openRecord) {
          const mttrMs = resolvedAt - openRecord.firedAt;
          const QUICK_RESOLVE_MS = 45 * 60 * 1000;
          // Only credit 'correct' for fast resolutions that weren't already
          // handled by autopilot. The autopilot records its own verdicts via
          // recordVerdict; we add feedback here only for manual quick-resolves
          // where resolutionType is still 'unknown' (no fix PR was correlated yet).
          if (mttrMs < QUICK_RESOLVE_MS && openRecord.resolutionType === 'unknown') {
            const fingerprint = openRecord.fingerprint;
            const unverifiedRecords = getRecords().filter(
              (r) => r.pid === fingerprint && r.verdict === null,
            );
            for (const cr of unverifiedRecords) {
              recordVerdict(cr.pid, 'correct', `pd-resolved-in-${Math.round(mttrMs / 60_000)}m`);
            }
          }
        }

        memoryStore.closeIncident({ pdIncidentId: data.id, resolvedAt });
        logger.info({ pdId: data.id }, 'pagerduty incident resolved');
        continue;
      }

      if (event_type !== 'incident.triggered') continue;

      // ── incident.triggered ─────────────────────────────────────────────────
      const service = data.service?.summary ?? 'unknown';
      const alertTitle = data.summary ?? `Incident ${data.id}`;
      const alertUrl = data.html_url;
      const firedAt = data.created_at ? new Date(data.created_at).getTime() : Date.now();

      logger.info({ service, alertTitle }, 'pagerduty incident triggered');

      // Immediately set in-memory active incident (MCP tool can respond before Datadog fetch)
      setActiveIncident({ service, traceId: '', alertTitle, alertUrl, firedAt });

      // Background: fetch trace, compact, open memory record
      if (isConfigured()) {
        void (async () => {
          try {
            const result = await fetchLatestErrorTrace(service, 10);
            if (!result) {
              // Open memory record without trace context
              memoryStore.openIncident({
                fingerprint: 'unknown',
                service,
                endpoint: 'unknown',
                errorType: '',
                errorMessage: alertTitle,
                pdIncidentId: data.id,
                pdAlertTitle: alertTitle,
                pdAlertUrl: alertUrl,
                traceId: '',
                firedAt,
              });
              return;
            }

            const to = new Date();
            const from = new Date(to.getTime() - 10 * 60 * 1000);
            const { fact } = await compact({
              spans: result.spans,
              traceId: result.traceId,
              timeWindow: { from, to },
            });

            const fingerprint = fingerprintFromFact(fact);

            // ── Blame attribution (must run before openIncident) ───────────────
            const deploys = store.getDeployments(50);
            const blame = computeBlameAttribution({
              implicatedFile: fact.failingFile ?? null,
              deployedSha: fact.deployedSha ?? null,
              firedAt,
              candidates: deploys,
            });

            if (blame) {
              logger.info(
                { confidence: blame.confidence, label: blame.confidenceLabel, sha: blame.topCandidate?.sha },
                'blame attribution computed',
              );
            }

            // Open persistent memory record
            memoryStore.openIncident({
              fingerprint,
              service: fact.service,
              endpoint: fact.endpoint,
              errorType: fact.errorMessage.split(':')[0],
              errorMessage: fact.errorMessage,
              implicatedFile: fact.failingFile,
              implicatedLine: fact.failingLine,
              deployedSha: fact.deployedSha,
              pdIncidentId: data.id,
              pdAlertTitle: alertTitle,
              pdAlertUrl: alertUrl,
              traceId: fact.traceId,
              rawFact: fact.markdown,
              firedAt,
              attributionConfidence: blame?.confidence,
              attributionSha: blame?.topCandidate?.sha,
            });

            // Update active incident with full context + attribution
            setActiveIncident({
              service,
              traceId: result.traceId,
              alertTitle,
              alertUrl,
              firedAt,
              runtimeFact: fact.markdown,
              implicatedFile: fact.failingFile ?? null,
              implicatedLine: fact.failingLine ?? null,
              blameAttribution: blame,
            });

            // ── Slack incident alert ──────────────────────────────────────────
            const blastRadius = store.getBlastRadius({ since: firedAt });
            const openIncident = memoryStore.listOpen()[0];
            void postIncidentAlert({
              alertTitle,
              service,
              firedAt,
              incidentId: openIncident?.id,
              pid: fingerprint, // use fingerprint as pid for thread ownership
              pdUrl: alertUrl,
              blame,
              blastRadius,
              dashboardUrl: DASHBOARD_URL,
            });

            // ── Incident autopilot ────────────────────────────────────────────
            // Runs in the background: causal analysis → autonomous fix if confidence ≥ 0.85.
            // The MERGEN_AUTOPILOT env var must be set to "true" to enable.
            void runIncidentAutopilot({ service, pid: fingerprint, firedAt, tenantId });

            logger.info({ service, traceId: result.traceId, fingerprint }, 'runtime fact pre-computed');
          } catch (err) {
            logger.warn({ err }, 'failed to pre-compute runtime fact');
          }
        })();
      }
    }

    res.json({ status: 'accepted' });
  }

  return router;
}

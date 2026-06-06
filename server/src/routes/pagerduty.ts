import { Router } from 'express';
import { z } from 'zod';
import { fetchLatestErrorTrace, isConfigured } from '../datadog/client.js';
import { compact } from '../datadog/compactor.js';
import { setActiveIncident } from '../datadog/incident-state.js';
import { memoryStore } from '../datadog/memory-store.js';
import { fingerprintFromFact } from '../datadog/fingerprinter.js';
import { computeBlameAttribution } from '../datadog/blame-attribution.js';
import { postIncidentAlert } from '../intelligence/slack.js';
import { store } from '../sensor/buffer.js';
import logger from '../sensor/logger.js';

const DASHBOARD_URL = process.env.MERGEN_DASHBOARD_URL ?? 'http://127.0.0.1:3000';

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

  router.post('/webhooks/pagerduty', (req, res) => {
    const parsed = PdMessageSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid PagerDuty payload' });
      return;
    }

    for (const msg of parsed.data.messages) {
      const { event_type, data } = msg.event;

      // ── incident.resolved — close memory record and compute MTTR ────────────
      if (event_type === 'incident.resolved') {
        const resolvedAt = data.resolved_at
          ? new Date(data.resolved_at).getTime()
          : Date.now();
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
            void postIncidentAlert({
              alertTitle,
              service,
              firedAt,
              incidentId: memoryStore.listOpen()[0]?.id,
              pdUrl: alertUrl,
              blame,
              blastRadius,
              dashboardUrl: DASHBOARD_URL,
            });

            logger.info({ service, traceId: result.traceId, fingerprint }, 'runtime fact pre-computed');
          } catch (err) {
            logger.warn({ err }, 'failed to pre-compute runtime fact');
          }
        })();
      }
    }

    res.json({ status: 'accepted' });
  });

  return router;
}

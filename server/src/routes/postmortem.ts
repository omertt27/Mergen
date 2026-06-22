import express from 'express';
import { z } from 'zod';
import { fetchSlackThread } from '../intelligence/slack.js';
import { draftPostmortemDoc } from '../intelligence/tools-runbook.js';
import { generatePostmortem } from '../intelligence/postmortem-store.js';
import { updateRunbookFromPostmortem } from '../intelligence/runbook-updater.js';
import { compileOverrideFromSlackThread } from '../intelligence/override-corpus.js';

const BodySchema = z.object({
  thread_url:       z.string().url(),
  service:          z.string().optional(),
  summary:          z.string().optional(),
  severity:         z.enum(['sev1', 'sev2', 'sev3']).optional(),
  duration_minutes: z.number().int().min(1).max(1440).optional(),
  affected_users:   z.string().optional(),
});

export function createPostmortemRouter(): express.Router {
  const router = express.Router();

  /**
   * POST /postmortem/from-slack
   *
   * Fetches a Slack thread via conversations.replies (requires MERGEN_SLACK_BOT_TOKEN
   * with channels:history scope), then drafts a blameless post-mortem from the thread
   * content combined with live telemetry and the incident corpus.
   *
   * Body:
   *   thread_url       — Slack thread URL (https://*.slack.com/archives/C.../p...)
   *   service          — affected service name (optional, improves corpus search)
   *   summary          — one-sentence description (optional)
   *   severity         — sev1|sev2|sev3 (default: sev2)
   *   duration_minutes — incident window for telemetry lookup (default: 60)
   *   affected_users   — who was impacted (optional)
   *
   * Returns:
   *   { markdown: string, overrideCompiled: boolean, overrideId?: string } — blameless post-mortem draft and override compilation state
   *   { error: string }      — if thread fetch fails or body is invalid
   */
  router.post('/postmortem/from-slack', async (req, res) => {
    const parsed = BodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid request', details: parsed.error.flatten() });
      return;
    }

    const { thread_url, service = 'unknown', summary, severity, duration_minutes, affected_users } = parsed.data;

    const slackThread = await fetchSlackThread(thread_url);
    if (slackThread === null) {
      res.status(422).json({
        error: 'Could not fetch Slack thread. Ensure MERGEN_SLACK_BOT_TOKEN is set with channels:history scope and the URL is a valid Slack thread link.',
      });
      return;
    }

    const markdown = await draftPostmortemDoc({
      service,
      summary,
      severity,
      duration_minutes,
      affected_users,
      slack_thread: slackThread,
    });

    const overrideEvent = compileOverrideFromSlackThread(slackThread, service);

    const responsePayload: any = { markdown };
    if (overrideEvent) {
      responsePayload.overrideCompiled = true;
      responsePayload.overrideId = overrideEvent.id;
    } else {
      responsePayload.overrideCompiled = false;
    }

    res.json(responsePayload);
  });

  /**
   * POST /postmortem/generate
   *
   * Persists a structured postmortem for a resolved incident (manual or
   * autonomous) and triggers a runbook update for the failure mode.
   * This is the manual-resolution path for the runbook flywheel:
   *   engineer resolves incident → calls this endpoint → runbook updated.
   *
   * Body:
   *   pid               — hypothesis pid (from triage_incident output)
   *   tag               — failure mode tag (e.g. "db_connection_pool_exhausted")
   *   service           — affected service name
   *   rootCause         — one-sentence root cause description
   *   fixCommand        — shell command that resolved the incident (optional)
   *   confidence        — diagnosis confidence 0–1
   *   mttrMs            — incident duration in milliseconds
   *   resolvedAutonomously — false for manual resolutions
   *   causallyCorrect   — true if error rate verifiably dropped after fix
   *   evidence          — array of evidence strings (optional)
   *   fixHint           — free-text fix description (optional)
   *
   * Returns:
   *   { pid, tag, service, mttrMs, causallyCorrect, runbookUpdated }
   */
  const GenerateSchema = z.object({
    pid:                  z.string().uuid(),
    tag:                  z.string().min(1),
    service:              z.string().min(1),
    rootCause:            z.string().min(1),
    fixCommand:           z.string().nullable().optional(),
    confidence:           z.number().min(0).max(1),
    mttrMs:               z.number().int().min(0).nullable(),
    resolvedAutonomously: z.boolean().default(false),
    causallyCorrect:      z.boolean().default(false),
    evidence:             z.array(z.string()).optional(),
    fixHint:              z.string().nullable().optional(),
  });

  router.post('/postmortem/generate', async (req, res) => {
    const parsed = GenerateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid request', details: parsed.error.flatten() });
      return;
    }

    const input = parsed.data;
    const pm = generatePostmortem({
      pid:                  input.pid,
      tag:                  input.tag,
      service:              input.service,
      rootCause:            input.rootCause,
      fixCommand:           input.fixCommand ?? null,
      confidence:           input.confidence,
      mttrMs:               input.mttrMs,
      resolvedAutonomously: input.resolvedAutonomously,
      causallyCorrect:      input.causallyCorrect,
      evidence:             input.evidence,
      fixHint:              input.fixHint ?? null,
    });

    // Non-blocking: runbook update must not fail the HTTP response if the
    // postmortem corpus has fewer than 2 entries for this tag yet.
    let runbookUpdated = false;
    try {
      updateRunbookFromPostmortem(pm);
      runbookUpdated = true;
    } catch { /* logged inside updateRunbookFromPostmortem */ }

    res.json({
      pid:             pm.pid,
      tag:             pm.tag,
      service:         pm.service,
      mttrMs:          pm.mttrMs,
      causallyCorrect: pm.causallyCorrect,
      runbookUpdated,
    });
  });

  return router;
}

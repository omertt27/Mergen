/**
 * routes/ci.ts — CI/CD and deployment event ingestion.
 *
 *   POST /ci/github        — GitHub Actions webhook (X-GitHub-Event header)
 *   POST /ci/gitlab        — GitLab CI webhook
 *   POST /ci/azure-devops  — Azure DevOps Pipelines webhook
 *   POST /ci/jenkins       — Jenkins Notification Plugin webhook
 *   POST /ci/generic       — Universal JSON format (any CI system)
 *   POST /deployments      — Deployment notifications (any system)
 *
 * All routes push structured CIEvent / DeploymentEvent into the shared buffer
 * so the causal engine can correlate browser errors with the CI run that
 * shipped the breaking commit.
 *
 * The commit SHA is the causal key that joins browser ↔ CI ↔ deployment.
 */

import { Router } from 'express';
import { store } from '../sensor/buffer.js';
import type { CIEvent, DeploymentEvent } from '../sensor/buffer.js';
import logger from '../sensor/logger.js';

export function createCIRouter(): Router {
  const router = Router();

  // ── GitHub Actions ──────────────────────────────────────────────────────────
  // Triggered by a `workflow_run` or `check_run` webhook, or directly by a
  // step in any workflow:
  //
  //   curl -X POST $MERGEN_URL/ci/github \
  //     -H 'Content-Type: application/json' \
  //     -d '{"action":"completed","workflow_run":{...}}'
  //
  router.post('/ci/github', (req, res) => {
    try {
      const body = req.body as Record<string, unknown>;
      const eventType = req.headers['x-github-event'] as string | undefined;

      let event: CIEvent | null = null;

      // workflow_run completed
      if (eventType === 'workflow_run' || body.workflow_run) {
        const wr = body.workflow_run as Record<string, unknown> | undefined
          ?? body as Record<string, unknown>;
        const sha = String(wr.head_sha ?? wr.sha ?? '');
        event = {
          type: 'ci',
          provider: 'github_actions',
          sha,
          shortSha: sha.slice(0, 7),
          branch: String(wr.head_branch ?? wr.branch ?? ''),
          workflow: String(wr.name ?? wr.workflow ?? 'workflow'),
          job: String(wr.name ?? 'run'),
          status: normalizeGitHubStatus(String(wr.conclusion ?? wr.status ?? 'unknown')),
          durationMs: computeGitHubDuration(wr),
          url: String(wr.html_url ?? wr.url ?? ''),
          failedTests: [],
          timestamp: parseGitHubTs(wr.updated_at ?? wr.created_at) ?? Date.now(),
        };
      }

      // check_run completed (individual job)
      if (eventType === 'check_run' || body.check_run) {
        const cr = body.check_run as Record<string, unknown> | undefined
          ?? body as Record<string, unknown>;
        const sha = String((cr.head_sha as string | undefined) ?? '');
        event = {
          type: 'ci',
          provider: 'github_actions',
          sha,
          shortSha: sha.slice(0, 7),
          branch: '',
          workflow: String((cr.app as Record<string,unknown> | undefined)?.name ?? 'GitHub'),
          job: String(cr.name ?? 'check'),
          status: normalizeGitHubStatus(String(cr.conclusion ?? cr.status ?? 'unknown')),
          durationMs: computeGitHubDuration(cr),
          url: String(cr.html_url ?? ''),
          failedTests: [],
          timestamp: parseGitHubTs(cr.completed_at ?? cr.started_at) ?? Date.now(),
        };
      }

      // Direct push format (from our GitHub Action step):
      //   { sha, branch, workflow, job, status, failed_tests?, url?, duration_ms? }
      if (!event && body.sha) {
        const sha = String(body.sha);
        event = {
          type: 'ci',
          provider: 'github_actions',
          sha,
          shortSha: sha.slice(0, 7),
          branch: String(body.branch ?? ''),
          workflow: String(body.workflow ?? 'workflow'),
          job: String(body.job ?? 'job'),
          status: normalizeGitHubStatus(String(body.status ?? 'unknown')),
          durationMs: typeof body.duration_ms === 'number' ? body.duration_ms : undefined,
          url: String(body.url ?? body.run_url ?? ''),
          failedTests: parseFailedTests(body.failed_tests),
          timestamp: Date.now(),
        };
      }

      if (!event) {
        res.status(400).json({ error: 'unrecognised GitHub event shape' });
        return;
      }

      store.push(event);
      logger.info({ sha: event.sha.slice(0, 7), status: event.status, job: event.job }, 'ci: github event ingested');
      res.json({ ok: true, sha: event.sha, status: event.status });
    } catch (err) {
      logger.warn({ err }, 'ci/github: parse error');
      res.status(400).json({ error: 'parse error' });
    }
  });

  // ── GitLab CI ───────────────────────────────────────────────────────────────
  router.post('/ci/gitlab', (req, res) => {
    try {
      const body = req.body as Record<string, unknown>;
      const sha = String(body.sha ?? body.checkout_sha ?? '');
      const statusRaw = String(body.status ?? body.build_status ?? 'unknown');

      const event: CIEvent = {
        type: 'ci',
        provider: 'gitlab_ci',
        sha,
        shortSha: sha.slice(0, 7),
        branch: String(body.ref ?? body.branch ?? '').replace('refs/heads/', ''),
        workflow: String((body.pipeline as Record<string,unknown>|undefined)?.name ?? (body.project as Record<string,unknown>|undefined)?.name ?? 'pipeline'),
        job: String(body.build_name ?? body.name ?? 'job'),
        status: normalizeGitLabStatus(statusRaw),
        url: String(body.build_url ?? (body.pipeline as Record<string,unknown>|undefined)?.url ?? ''),
        failedTests: parseFailedTests(body.failed_tests),
        timestamp: Date.now(),
      };

      store.push(event);
      res.json({ ok: true, sha: event.sha, status: event.status });
    } catch (err) {
      logger.warn({ err }, 'ci/gitlab: parse error');
      res.status(400).json({ error: 'parse error' });
    }
  });

  // ── Azure DevOps Pipelines ────────────────────────────────────────────────
  // Configure a Service Hook in Azure DevOps:
  //   Project Settings → Service Hooks → Web Hooks → Build completed
  //   URL: http(s)://<mergen-host>/ci/azure-devops
  //
  // Payload shape (Azure DevOps "Build completed" event):
  //   { eventType: "build.complete", resource: { buildNumber, result, sourceVersion, ... } }
  router.post('/ci/azure-devops', (req, res) => {
    try {
      const body = req.body as Record<string, unknown>;
      const resource = (body.resource ?? body) as Record<string, unknown>;
      const eventType = String(body.eventType ?? body.event ?? '');

      // Only process build.complete events (skip build.queued, build.started)
      if (eventType && eventType !== 'build.complete' && eventType !== 'ms.vss-build.build-completed-event') {
        res.json({ ok: true, skipped: true, reason: `eventType ${eventType} not processed` });
        return;
      }

      const sha        = String(resource.sourceVersion ?? resource.sourceVersionId ?? resource.commitId ?? '');
      const definition = (resource.definition ?? resource.plan ?? {}) as Record<string, unknown>;
      const project    = (resource.project ?? (body.resourceContainers as Record<string,unknown>|undefined)?.project ?? {}) as Record<string, unknown>;
      const links      = (resource._links ?? {}) as Record<string, Record<string, string>>;

      const resultRaw = String(resource.result ?? resource.buildResult ?? 'unknown').toLowerCase();
      const status: CIEvent['status'] =
        resultRaw === 'succeeded'                    ? 'success'
        : resultRaw === 'failed' || resultRaw === 'partiallySucceeded' ? 'failure'
        : resultRaw === 'canceled' || resultRaw === 'cancelled'         ? 'cancelled'
        : 'failure';

      // Duration from startTime / finishTime ISO strings
      const startMs  = resource.startTime  ? new Date(String(resource.startTime)).getTime()  : null;
      const finishMs = resource.finishTime ? new Date(String(resource.finishTime)).getTime() : null;
      const durationMs = startMs && finishMs && finishMs > startMs ? finishMs - startMs : undefined;

      const event: CIEvent = {
        type:     'ci',
        provider: 'azure_devops',
        sha,
        shortSha: sha.slice(0, 7),
        branch:   String(resource.sourceBranch ?? resource.branch ?? '').replace('refs/heads/', ''),
        workflow: String(project.name ?? definition.name ?? 'pipeline'),
        job:      String(resource.buildNumber ?? definition.name ?? 'build'),
        status,
        durationMs,
        url: links.web?.href ?? String(resource.url ?? resource.buildUrl ?? ''),
        failedTests: [],
        timestamp: finishMs ?? Date.now(),
      };

      store.push(event);
      logger.info({ sha: event.sha.slice(0, 7), status: event.status }, 'ci/azure-devops: event ingested');
      res.json({ ok: true, sha: event.sha, status: event.status });
    } catch (err) {
      logger.warn({ err }, 'ci/azure-devops: parse error');
      res.status(400).json({ error: 'parse error' });
    }
  });

  // ── Jenkins ────────────────────────────────────────────────────────────────
  // Requires the Jenkins Notification Plugin (jenkins-notifier-plugin).
  // Configure: Jenkins job → Post-build Actions → Notification → Endpoint URL
  //   URL: http(s)://<mergen-host>/ci/jenkins
  //   Format: JSON
  //
  // Payload shape:
  //   { name: "job-name", build: { number, status, phase, url, scm: { commit, branch } } }
  router.post('/ci/jenkins', (req, res) => {
    try {
      const body  = req.body as Record<string, unknown>;
      const build = (body.build ?? body) as Record<string, unknown>;
      const scm   = (build.scm   ?? {}) as Record<string, unknown>;
      const phase = String(build.phase ?? '').toUpperCase();

      // Only process COMPLETED phase — skip QUEUED, STARTED, FINALIZED
      if (phase && phase !== 'COMPLETED' && phase !== 'FINISHED') {
        res.json({ ok: true, skipped: true, reason: `phase ${phase} not processed` });
        return;
      }

      const sha       = String(scm.commit ?? scm.sha ?? build.sha ?? '');
      const statusRaw = String(build.status ?? build.result ?? 'UNKNOWN').toUpperCase();
      const status: CIEvent['status'] =
        statusRaw === 'SUCCESS'                         ? 'success'
        : statusRaw === 'FAILURE' || statusRaw === 'FAILED'  ? 'failure'
        : statusRaw === 'ABORTED'                       ? 'cancelled'
        : statusRaw === 'UNSTABLE'                      ? 'failure'
        : 'failure';

      const event: CIEvent = {
        type:     'ci',
        provider: 'jenkins',
        sha,
        shortSha: sha.slice(0, 7),
        branch:   String(scm.branch ?? build.branch ?? '').replace('refs/heads/', ''),
        workflow: String(body.name ?? body.job ?? 'pipeline'),
        job:      `${body.name ?? 'build'} #${build.number ?? '?'}`,
        status,
        durationMs: typeof build.duration === 'number' ? build.duration : undefined,
        url:      String(build.full_url ?? build.url ?? ''),
        failedTests: parseFailedTests(build.test_summary ?? build.failedTests),
        timestamp: Date.now(),
      };

      store.push(event);
      logger.info({ sha: event.sha.slice(0, 7), status: event.status }, 'ci/jenkins: event ingested');
      res.json({ ok: true, sha: event.sha, status: event.status });
    } catch (err) {
      logger.warn({ err }, 'ci/jenkins: parse error');
      res.status(400).json({ error: 'parse error' });
    }
  });

  // ── Generic / universal ────────────────────────────────────────────────────
  // Accepts any CI system with a minimal JSON body:
  //   { sha, status, job?, workflow?, branch?, url?, failed_tests?, provider? }
  router.post('/ci/generic', (req, res) => {
    try {
      const body = req.body as Record<string, unknown>;
      if (!body.sha || !body.status) {
        res.status(400).json({ error: 'sha and status are required' });
        return;
      }
      const sha = String(body.sha);
      const event: CIEvent = {
        type: 'ci',
        provider: (body.provider as CIEvent['provider']) ?? 'unknown',
        sha,
        shortSha: sha.slice(0, 7),
        branch: String(body.branch ?? ''),
        workflow: String(body.workflow ?? ''),
        job: String(body.job ?? 'job'),
        status: normalizeGenericStatus(String(body.status)),
        durationMs: typeof body.duration_ms === 'number' ? body.duration_ms : undefined,
        url: String(body.url ?? ''),
        failedTests: parseFailedTests(body.failed_tests),
        timestamp: Date.now(),
      };

      store.push(event);
      res.json({ ok: true, sha: event.sha, status: event.status });
    } catch (err) {
      logger.warn({ err }, 'ci/generic: parse error');
      res.status(400).json({ error: 'parse error' });
    }
  });

  // ── Deployments ────────────────────────────────────────────────────────────
  // Called by deploy scripts, GitHub Actions deploy steps, Vercel webhooks, etc.
  //   { sha, environment, status, service?, version?, url?, actor? }
  router.post('/deployments', (req, res) => {
    try {
      const body = req.body as Record<string, unknown>;
      if (!body.sha || !body.environment || !body.status) {
        res.status(400).json({ error: 'sha, environment, and status are required' });
        return;
      }
      const sha = String(body.sha);
      const event: DeploymentEvent = {
        type: 'deployment',
        environment: String(body.environment),
        sha,
        shortSha: sha.slice(0, 7),
        version: String(body.version ?? body.tag ?? ''),
        service: String(body.service ?? body.app ?? ''),
        status: normalizeDeployStatus(String(body.status)),
        url: String(body.url ?? ''),
        actor: String(body.actor ?? body.deployer ?? ''),
        timestamp: Date.now(),
      };

      store.push(event);
      logger.info(
        { sha: event.sha.slice(0, 7), env: event.environment, status: event.status },
        'ci: deployment event ingested',
      );
      res.json({ ok: true, sha: event.sha, environment: event.environment, status: event.status });
    } catch (err) {
      logger.warn({ err }, 'deployments: parse error');
      res.status(400).json({ error: 'parse error' });
    }
  });

  return router;
}

// ── Normalise status strings ──────────────────────────────────────────────────

function normalizeGitHubStatus(s: string): CIEvent['status'] {
  if (s === 'success')           return 'success';
  if (s === 'failure' || s === 'timed_out' || s === 'startup_failure') return 'failure';
  if (s === 'cancelled')         return 'cancelled';
  if (s === 'skipped' || s === 'neutral') return 'skipped';
  return 'failure';
}

function normalizeGitLabStatus(s: string): CIEvent['status'] {
  if (s === 'success' || s === 'passed') return 'success';
  if (s === 'failed')            return 'failure';
  if (s === 'canceled')          return 'cancelled';
  if (s === 'skipped')           return 'skipped';
  return 'failure';
}

function normalizeGenericStatus(s: string): CIEvent['status'] {
  const lower = s.toLowerCase();
  if (lower === 'success' || lower === 'pass' || lower === 'passed') return 'success';
  if (lower === 'failure' || lower === 'fail' || lower === 'failed') return 'failure';
  if (lower === 'cancelled' || lower === 'canceled')                 return 'cancelled';
  if (lower === 'skipped')                                            return 'skipped';
  return 'failure';
}

function normalizeDeployStatus(s: string): DeploymentEvent['status'] {
  const lower = s.toLowerCase();
  if (lower === 'started' || lower === 'in_progress') return 'started';
  if (lower === 'success' || lower === 'deployed')    return 'success';
  if (lower === 'failure' || lower === 'failed')      return 'failure';
  if (lower === 'rollback')                           return 'rollback';
  return 'started';
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function computeGitHubDuration(obj: Record<string, unknown>): number | undefined {
  const start = parseGitHubTs(obj.run_started_at ?? obj.started_at ?? obj.created_at);
  const end   = parseGitHubTs(obj.updated_at ?? obj.completed_at);
  if (start && end && end > start) return end - start;
  return undefined;
}

function parseGitHubTs(val: unknown): number | null {
  if (!val) return null;
  const d = new Date(String(val));
  return isNaN(d.getTime()) ? null : d.getTime();
}

function parseFailedTests(val: unknown): CIEvent['failedTests'] {
  if (!Array.isArray(val)) return [];
  return val.slice(0, 50).map((t) => {
    if (typeof t === 'string') return { name: t };
    const obj = t as Record<string, unknown>;
    return {
      name: String(obj.name ?? obj.title ?? 'unknown'),
      error: obj.error ? String(obj.error) : undefined,
      file: obj.file ? String(obj.file) : undefined,
    };
  });
}

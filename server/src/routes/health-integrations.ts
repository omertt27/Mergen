/**
 * routes/health-integrations.ts — Machine-readable integration health check.
 *
 *   GET /health/integrations
 *
 * Returns status for every optional integration as a structured list.
 * Powers both `mergen-server doctor` (CLI) and any admin dashboard UI.
 *
 * Each integration entry:
 *   { id, name, status: 'ok'|'warn'|'missing', detail, fix?, docsUrl? }
 *
 * `missing` = env var not set at all (feature disabled).
 * `warn`    = partially configured or config is present but unverified.
 * `ok`      = configured and (where possible) verified live.
 */

import { Router } from 'express';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getAuditHealth } from '../sensor/audit-log.js';
import { getStaleErrors } from '../sensor/buffer.js';

export interface IntegrationHealth {
  id:       string;
  name:     string;
  status:   'ok' | 'warn' | 'missing';
  detail:   string;
  fix?:     string;
  docsUrl?: string;
}

async function checkSlack(): Promise<IntegrationHealth> {
  const token   = process.env.MERGEN_SLACK_BOT_TOKEN;
  const channel = process.env.MERGEN_SLACK_CHANNEL;
  if (!token) return {
    id: 'slack', name: 'Slack', status: 'missing',
    detail: 'MERGEN_SLACK_BOT_TOKEN not set — incident threads and PR comments disabled',
    fix: 'export MERGEN_SLACK_BOT_TOKEN=xoxb-...',
    docsUrl: 'https://api.slack.com/apps',
  };
  if (!channel) return {
    id: 'slack', name: 'Slack', status: 'warn',
    detail: 'Token set but MERGEN_SLACK_CHANNEL not configured',
    fix: 'export MERGEN_SLACK_CHANNEL=#incidents',
  };
  try {
    const r = await fetch('https://slack.com/api/auth.test', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(3000),
    });
    const d = await r.json() as { ok: boolean; team?: string; error?: string };
    return d.ok
      ? { id: 'slack', name: 'Slack', status: 'ok', detail: `Connected — workspace: ${d.team ?? 'unknown'}, channel: ${channel}` }
      : { id: 'slack', name: 'Slack', status: 'warn', detail: `Auth failed: ${d.error}`, fix: 'Check MERGEN_SLACK_BOT_TOKEN — needs chat:write scope', docsUrl: 'https://api.slack.com/apps' };
  } catch {
    return { id: 'slack', name: 'Slack', status: 'warn', detail: 'Token set but Slack API unreachable', fix: 'Check network connectivity' };
  }
}

async function checkPagerDuty(): Promise<IntegrationHealth> {
  const secret = process.env.MERGEN_PAGERDUTY_SECRET;
  if (!secret) return {
    id: 'pagerduty', name: 'PagerDuty', status: 'missing',
    detail: 'MERGEN_PAGERDUTY_SECRET not set — webhook signature verification disabled',
    fix: 'export MERGEN_PAGERDUTY_SECRET=...  # from PagerDuty webhook config',
    docsUrl: 'https://developer.pagerduty.com/docs/webhooks',
  };
  return { id: 'pagerduty', name: 'PagerDuty', status: 'ok', detail: 'Secret configured — signature verification enabled' };
}

async function checkGitHub(): Promise<IntegrationHealth> {
  const token  = process.env.GITHUB_TOKEN;
  const secret = process.env.GITHUB_WEBHOOK_SECRET
    ?? (existsSync(join(homedir(), '.mergen', 'github-webhook-secret'))
      ? '[file]' : null);
  if (!token && !secret) return {
    id: 'github', name: 'GitHub', status: 'missing',
    detail: 'GITHUB_TOKEN and GITHUB_WEBHOOK_SECRET not set',
    fix: 'mergen-server connect github --repo owner/repo',
    docsUrl: 'https://github.com/settings/tokens',
  };
  if (token) {
    try {
      const r = await fetch('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'mergen' },
        signal: AbortSignal.timeout(3000),
      });
      const d = await r.json() as { login?: string; message?: string };
      if (!r.ok) return { id: 'github', name: 'GitHub', status: 'warn', detail: `Token auth failed: ${d.message}`, fix: 'Check GITHUB_TOKEN at https://github.com/settings/tokens' };
      return {
        id: 'github', name: 'GitHub', status: 'ok',
        detail: `Connected — user: ${d.login}${secret ? ', webhook secret set' : ', no webhook secret'}`,
      };
    } catch {
      return { id: 'github', name: 'GitHub', status: 'warn', detail: 'Token set but GitHub API unreachable', fix: 'Check network connectivity' };
    }
  }
  return { id: 'github', name: 'GitHub', status: 'ok', detail: 'Webhook secret configured (token not set — PR commenting disabled)' };
}

async function checkDatadog(): Promise<IntegrationHealth> {
  const apiKey = process.env.DD_API_KEY;
  const appKey = process.env.DD_APP_KEY;
  if (!apiKey) return {
    id: 'datadog', name: 'Datadog', status: 'missing',
    detail: 'DD_API_KEY not set',
    fix: 'export DD_API_KEY=...  # https://app.datadoghq.com/organization-settings/api-keys',
  };
  if (!appKey) return {
    id: 'datadog', name: 'Datadog', status: 'warn',
    detail: 'DD_API_KEY set but DD_APP_KEY missing',
    fix: 'export DD_APP_KEY=...  # https://app.datadoghq.com/organization-settings/application-keys',
  };
  const site = process.env.DATADOG_SITE ?? 'datadoghq.com';
  try {
    const r = await fetch(`https://api.${site}/api/v1/validate`, {
      headers: { 'DD-API-KEY': apiKey, 'DD-APPLICATION-KEY': appKey },
      signal: AbortSignal.timeout(4000),
    });
    return r.ok
      ? { id: 'datadog', name: 'Datadog', status: 'ok', detail: `Connected — site: ${site}` }
      : { id: 'datadog', name: 'Datadog', status: 'warn', detail: `Auth failed (${r.status})`, fix: 'Run: mergen-server init to re-configure' };
  } catch {
    return { id: 'datadog', name: 'Datadog', status: 'warn', detail: `Keys set but ${site} unreachable` };
  }
}

function checkLinear(): IntegrationHealth {
  const apiKey = process.env.LINEAR_API_KEY;
  const teamId = process.env.LINEAR_TEAM_ID;
  if (!apiKey) return {
    id: 'linear', name: 'Linear', status: 'missing',
    detail: 'LINEAR_API_KEY not set — ticket creation disabled',
    fix: 'export LINEAR_API_KEY=lin_api_...',
    docsUrl: 'https://linear.app/settings/api',
  };
  if (!teamId) return {
    id: 'linear', name: 'Linear', status: 'warn',
    detail: 'LINEAR_API_KEY set but LINEAR_TEAM_ID missing',
    fix: 'export LINEAR_TEAM_ID=<team-id>  # from https://linear.app/settings/api',
  };
  return { id: 'linear', name: 'Linear', status: 'ok', detail: `Configured — team: ${teamId}` };
}

function checkJira(): IntegrationHealth {
  const baseUrl = process.env.JIRA_BASE_URL;
  const email   = process.env.JIRA_EMAIL;
  const token   = process.env.JIRA_API_TOKEN;
  const projKey = process.env.JIRA_PROJECT_KEY;
  if (!baseUrl) return {
    id: 'jira', name: 'Jira', status: 'missing',
    detail: 'JIRA_BASE_URL not set — ticket creation disabled',
    fix: 'export JIRA_BASE_URL=https://yourco.atlassian.net',
    docsUrl: 'https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/',
  };
  if (!email || !token) return {
    id: 'jira', name: 'Jira', status: 'warn',
    detail: `JIRA_BASE_URL set but ${!email ? 'JIRA_EMAIL' : 'JIRA_API_TOKEN'} missing`,
    fix: !email ? 'export JIRA_EMAIL=you@company.com' : 'export JIRA_API_TOKEN=...',
  };
  return {
    id: 'jira', name: 'Jira', status: 'ok',
    detail: `Configured — ${baseUrl}${projKey ? ` · project: ${projKey}` : ' (JIRA_PROJECT_KEY not set — pass per request)'}`,
  };
}

function checkSentry(): IntegrationHealth {
  const secret = process.env.MERGEN_SENTRY_SECRET;
  if (!secret) return {
    id: 'sentry', name: 'Sentry', status: 'missing',
    detail: 'MERGEN_SENTRY_SECRET not set — Sentry webhooks accepted without verification',
    fix: 'export MERGEN_SENTRY_SECRET=...  # from your Sentry project webhook settings',
  };
  return { id: 'sentry', name: 'Sentry', status: 'ok', detail: 'Webhook secret configured' };
}

function checkRedis(): IntegrationHealth {
  const url = process.env.MERGEN_REDIS_URL;
  if (!url) return {
    id: 'redis', name: 'Redis', status: 'missing',
    detail: 'MERGEN_REDIS_URL not set — ring buffer is in-memory only (lost on restart)',
    fix: 'export MERGEN_REDIS_URL=redis://localhost:6379',
  };
  return { id: 'redis', name: 'Redis', status: 'ok', detail: `Configured — ${url}` };
}

function checkAutopilot(): IntegrationHealth {
  const enabled = process.env.MERGEN_AUTOPILOT === 'true';
  const shadow  = process.env.MERGEN_SHADOW_MODE === 'true';
  if (shadow) return {
    id: 'autopilot', name: 'Autopilot', status: 'warn',
    detail: 'Shadow mode: Mergen diagnoses but never executes fixes',
    fix: 'Set MERGEN_AUTOPILOT=true and remove MERGEN_SHADOW_MODE to enable autonomous execution',
  };
  if (enabled) return { id: 'autopilot', name: 'Autopilot', status: 'ok', detail: 'Autonomous execution enabled at ≥85% confidence' };
  return {
    id: 'autopilot', name: 'Autopilot', status: 'missing',
    detail: 'MERGEN_AUTOPILOT not set — diagnosis-only mode',
    fix: 'export MERGEN_AUTOPILOT=true  (run in MERGEN_SHADOW_MODE=true first for 30 days)',
  };
}

export function createHealthIntegrationsRouter(): Router {
  const router = Router();

  router.get('/health/integrations', async (_req, res) => {
    const [slack, pagerduty, github, datadog] = await Promise.all([
      checkSlack(),
      checkPagerDuty(),
      checkGitHub(),
      checkDatadog(),
    ]);

    const staleErrors = getStaleErrors();
    const staleCheck: IntegrationHealth = staleErrors.length > 0
      ? {
          id: 'stale_errors',
          name: 'Active Errors',
          status: 'warn',
          detail: `${staleErrors.length} error pattern${staleErrors.length !== 1 ? 's' : ''} active for >1 hour without triage`,
          fix: 'Run: curl http://127.0.0.1:3000/health/integrations | jq .staleErrors',
        }
      : { id: 'stale_errors', name: 'Active Errors', status: 'ok', detail: 'No untriaged errors older than 1 hour' };

    const integrations: IntegrationHealth[] = [
      slack,
      pagerduty,
      github,
      datadog,
      checkLinear(),
      checkJira(),
      checkSentry(),
      checkRedis(),
      checkAutopilot(),
      staleCheck,
    ];

    const ok      = integrations.filter((i) => i.status === 'ok').length;
    const warn    = integrations.filter((i) => i.status === 'warn').length;
    const missing = integrations.filter((i) => i.status === 'missing').length;

    res.json({
      ok: true,
      summary: { ok, warn, missing, total: integrations.length },
      integrations,
      staleErrors,
      staleErrorCount: staleErrors.length,
    });
  });

  router.get('/audit-health', (_req, res) => {
    const health = getAuditHealth();
    res.status(health.ok ? 200 : 503).json(health);
  });

  return router;
}

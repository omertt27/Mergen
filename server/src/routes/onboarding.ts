/**
 * routes/onboarding.ts — Progressive onboarding status API.
 *
 *   GET  /onboarding/status    — returns completion state for all setup steps
 *   POST /onboarding/dismiss   — mark onboarding as dismissed for this install
 *
 * Each step has: id, label, description, status (done|pending|skipped), nextStep.
 * The response includes a percentComplete and a single `nextStep` string pointing
 * to the first incomplete action.
 *
 * Steps are derived from live system state — no manual setup tracking required.
 * The server checks env vars, IDE config files, and the event buffer automatically.
 */

import { Router } from 'express';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { store } from '../sensor/buffer.js';
import { getActivePlanId } from '../intelligence/license.js';
import { DATA_DIR } from '../sensor/paths.js';

const DISMISSED_FILE = join(DATA_DIR, 'onboarding-dismissed.json');

interface OnboardingStep {
  id:          string;
  label:       string;
  description: string;
  status:      'done' | 'pending' | 'skipped';
  docsUrl?:    string;
  command?:    string;
}

function isDismissed(): boolean {
  try {
    const raw = readFileSync(DISMISSED_FILE, 'utf8');
    return (JSON.parse(raw) as { dismissed?: boolean }).dismissed === true;
  } catch { return false; }
}

function ideConfigured(): boolean {
  // Claude Code
  try {
    const { execSync } = require('child_process') as typeof import('child_process');
    const out = execSync('claude mcp list 2>&1', { encoding: 'utf8' });
    if (out.includes('mergen')) return true;
  } catch {}
  // Cursor
  const cursorCfg = join(homedir(), '.cursor', 'mcp.json');
  if (existsSync(cursorCfg)) {
    try { const c = JSON.parse(readFileSync(cursorCfg, 'utf8')); if (c?.mcpServers?.mergen) return true; } catch {}
  }
  // Windsurf
  const wsurfCfg = join(homedir(), '.codeium', 'windsurf', 'mcp_config.json');
  if (existsSync(wsurfCfg)) {
    try { const c = JSON.parse(readFileSync(wsurfCfg, 'utf8')); if (c?.mcpServers?.mergen) return true; } catch {}
  }
  // VS Code
  const vscodeCfg = join(homedir(), '.vscode', 'settings.json');
  if (existsSync(vscodeCfg)) {
    try { const c = JSON.parse(readFileSync(vscodeCfg, 'utf8')); if (c?.['mcp.servers']?.mergen) return true; } catch {}
  }
  return false;
}

function hasReceivedEvents(): boolean {
  return store.getLogs(1).length > 0 || store.getNetwork(1).length > 0;
}

function isSlackConfigured(): boolean {
  return !!process.env.MERGEN_SLACK_BOT_TOKEN && !!process.env.MERGEN_SLACK_CHANNEL;
}

function isPagerDutyConfigured(): boolean {
  return !!process.env.MERGEN_PAGERDUTY_SECRET;
}

function isGitHubConnected(): boolean {
  const secretFile = join(homedir(), '.mergen', 'github-webhook-secret');
  return existsSync(secretFile) || !!process.env.GITHUB_WEBHOOK_SECRET;
}

function isOnPaidPlan(): boolean {
  return getActivePlanId() !== 'free';
}

export function createOnboardingRouter(): Router {
  const router = Router();

  router.get('/onboarding/status', (_req, res) => {
    const dismissed = isDismissed();

    const steps: OnboardingStep[] = [
      {
        id:          'server_running',
        label:       'Server is running',
        description: 'Mergen HTTP server is accepting events.',
        status:      'done', // if this endpoint is reachable, the server is running
      },
      {
        id:          'ide_configured',
        label:       'IDE connected via MCP',
        description: 'Your AI IDE (Claude Code, Cursor, VS Code, Windsurf) is configured to use Mergen.',
        status:      ideConfigured() ? 'done' : 'pending',
        command:     'mergen-server setup',
        docsUrl:     'https://github.com/omertt27/Mergen/blob/main/QUICKSTART.md',
      },
      {
        id:          'first_event',
        label:       'First telemetry event received',
        description: 'Mergen has received at least one event from your application.',
        status:      hasReceivedEvents() ? 'done' : 'pending',
        command:     'mergen-server watch npm start',
        docsUrl:     'https://github.com/omertt27/Mergen#backend-instrumentation',
      },
      {
        id:          'slack_configured',
        label:       'Slack connected',
        description: 'Mergen can post incident alerts and thread replies to Slack.',
        status:      isSlackConfigured() ? 'done' : 'pending',
        command:     'export MERGEN_SLACK_BOT_TOKEN=xoxb-...',
        docsUrl:     'https://github.com/omertt27/Mergen#environment-variables',
      },
      {
        id:          'pagerduty_configured',
        label:       'PagerDuty webhook registered',
        description: 'Mergen receives PagerDuty incident triggers for autonomous triage.',
        status:      isPagerDutyConfigured() ? 'done' : 'pending',
        command:     'export MERGEN_PAGERDUTY_SECRET=...',
        docsUrl:     'https://github.com/omertt27/Mergen#environment-variables',
      },
      {
        id:          'github_connected',
        label:       'GitHub intent archive connected',
        description: 'Mergen populates the PR history that powers "why was this changed?" answers.',
        status:      isGitHubConnected() ? 'done' : 'pending',
        command:     'mergen-server connect github --repo owner/repo',
        docsUrl:     'https://github.com/omertt27/Mergen#mcp-tools-reference',
      },
      {
        id:          'paid_plan',
        label:       'Upgraded to a paid plan',
        description: 'Unlock backend observability, more analysis credits, and autonomous execution.',
        status:      isOnPaidPlan() ? 'done' : 'pending',
        docsUrl:     'https://mergen.dev/pricing',
      },
    ];

    const done    = steps.filter((s) => s.status === 'done').length;
    const total   = steps.length;
    const pct     = Math.round((done / total) * 100);
    const nextStep = steps.find((s) => s.status === 'pending') ?? null;

    res.json({
      ok: true,
      dismissed,
      percentComplete: pct,
      stepsComplete:   done,
      stepsTotal:      total,
      nextStep: nextStep ? {
        id:      nextStep.id,
        label:   nextStep.label,
        command: nextStep.command ?? null,
        docsUrl: nextStep.docsUrl ?? null,
      } : null,
      steps,
    });
  });

  router.post('/onboarding/dismiss', (_req, res) => {
    try {
      mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(DISMISSED_FILE, JSON.stringify({ dismissed: true, dismissedAt: new Date().toISOString() }));
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'write failed' });
    }
  });

  return router;
}

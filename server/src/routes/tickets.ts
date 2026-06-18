/**
 * tickets.ts — One-click ticket creation for Linear and Jira.
 *
 *   POST /tickets/linear   — create a Linear issue
 *   POST /tickets/jira     — create a Jira issue
 *
 * Both endpoints accept a hypothesis pid and auto-fill: title, description,
 * reproduction steps, affected SHA, CODEOWNERS, and the Mergen dashboard URL.
 *
 * Configuration (env vars):
 *   LINEAR_API_KEY           — Personal API key from Linear settings
 *   LINEAR_TEAM_ID           — Linear team ID (find in Linear > Settings > API)
 *   JIRA_BASE_URL            — e.g. https://yourco.atlassian.net
 *   JIRA_API_TOKEN           — Jira API token (Atlassian account settings)
 *   JIRA_EMAIL               — Jira account email
 *   JIRA_PROJECT_KEY         — e.g. "ENG" or "BUGS"
 */

import { Router } from 'express';
import https from 'https';
import { store } from '../sensor/buffer.js';
import { hypothesisHistory } from '../intelligence/hypothesis-history.js';
import { generateReproSteps } from '../intelligence/repro-steps.js';
import { findCodeOwners } from '../sensor/git-suspect.js';
import logger from '../sensor/logger.js';

export function createTicketsRouter(): Router {
  const router = Router();

  // ── Linear ────────────────────────────────────────────────────────────────
  router.post('/tickets/linear', async (req, res) => {
    const { pid, team_id } = (req.body ?? {}) as { pid?: string; team_id?: string };
    const apiKey  = process.env.LINEAR_API_KEY ?? '';
    const teamId  = team_id ?? process.env.LINEAR_TEAM_ID ?? '';

    if (!apiKey)  { res.status(400).json({ error: 'LINEAR_API_KEY not configured', fix: 'export LINEAR_API_KEY=lin_api_...', docs: 'https://linear.app/settings/api' }); return; }
    if (!teamId)  { res.status(400).json({ error: 'LINEAR_TEAM_ID not configured', fix: 'export LINEAR_TEAM_ID=<team-id>  # or pass team_id in the request body', docs: 'https://linear.app/settings/api' }); return; }

    const { title, description } = await buildTicketContent(pid);

    const mutation = `
      mutation CreateIssue($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue { id identifier url title }
        }
      }
    `;

    try {
      const result = await httpPost(
        'https://api.linear.app/graphql',
        JSON.stringify({ query: mutation, variables: { input: { teamId, title, description, priority: 2 } } }),
        { 'Authorization': apiKey, 'Content-Type': 'application/json' },
      );

      const parsed = JSON.parse(result) as { data?: { issueCreate?: { success: boolean; issue?: { url: string; identifier: string } } }; errors?: unknown[] };
      if (parsed.errors) {
        res.status(400).json({ error: 'Linear API error', details: parsed.errors });
        return;
      }
      const issue = parsed.data?.issueCreate?.issue;
      logger.info({ id: issue?.identifier }, 'linear: ticket created');
      res.json({ ok: true, url: issue?.url, id: issue?.identifier });
    } catch (err) {
      logger.warn({ err }, 'linear: ticket creation failed');
      res.status(500).json({ error: err instanceof Error ? err.message : 'Linear API failed' });
    }
  });

  // ── Jira ──────────────────────────────────────────────────────────────────
  router.post('/tickets/jira', async (req, res) => {
    const { pid, project_key } = (req.body ?? {}) as { pid?: string; project_key?: string };
    const baseUrl    = process.env.JIRA_BASE_URL ?? '';
    const email      = process.env.JIRA_EMAIL ?? '';
    const apiToken   = process.env.JIRA_API_TOKEN ?? '';
    const projectKey = project_key ?? process.env.JIRA_PROJECT_KEY ?? '';

    if (!baseUrl)    { res.status(400).json({ error: 'JIRA_BASE_URL not configured',    fix: 'export JIRA_BASE_URL=https://yourco.atlassian.net', docs: 'https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/' }); return; }
    if (!email)      { res.status(400).json({ error: 'JIRA_EMAIL not configured',       fix: 'export JIRA_EMAIL=you@company.com', docs: 'https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/' }); return; }
    if (!apiToken)   { res.status(400).json({ error: 'JIRA_API_TOKEN not configured',   fix: 'export JIRA_API_TOKEN=<token>  # create at https://id.atlassian.com/manage-profile/security/api-tokens', docs: 'https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/' }); return; }
    if (!projectKey) { res.status(400).json({ error: 'JIRA_PROJECT_KEY not configured', fix: 'export JIRA_PROJECT_KEY=ENG  # or pass project_key in the request body', docs: 'https://support.atlassian.com/jira-software-cloud/docs/what-is-a-jira-project/' }); return; }

    const { title, description } = await buildTicketContent(pid);

    const jiraPayload = {
      fields: {
        project: { key: projectKey },
        summary: title,
        description: {
          type: 'doc', version: 1,
          content: [{ type: 'paragraph', content: [{ type: 'text', text: description }] }],
        },
        issuetype: { name: 'Bug' },
      },
    };

    const auth = Buffer.from(`${email}:${apiToken}`).toString('base64');
    const jiraUrl = baseUrl.replace(/\/$/, '') + '/rest/api/3/issue';

    try {
      const result = await httpPost(
        jiraUrl,
        JSON.stringify(jiraPayload),
        { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
      );
      const parsed = JSON.parse(result) as { key?: string; self?: string; errors?: unknown };
      if (parsed.errors) {
        res.status(400).json({ error: 'Jira API error', details: parsed.errors });
        return;
      }
      const issueUrl = `${baseUrl.replace(/\/$/, '')}/browse/${parsed.key}`;
      logger.info({ key: parsed.key }, 'jira: ticket created');
      res.json({ ok: true, url: issueUrl, key: parsed.key });
    } catch (err) {
      logger.warn({ err }, 'jira: ticket creation failed');
      res.status(500).json({ error: err instanceof Error ? err.message : 'Jira API failed' });
    }
  });

  return router;
}

// ── Ticket content builder ─────────────────────────────────────────────────────

async function buildTicketContent(pid?: string): Promise<{ title: string; description: string }> {
  const latest = hypothesisHistory.latest();
  const hyp    = pid
    ? latest?.chain?.hypotheses?.find((h) => h.pid === pid) ?? latest?.topHypothesis
    : latest?.topHypothesis;

  const logs     = store.getLogs(200);
  const network  = store.getNetwork(200);
  const contexts = store.getContext(20);
  const deploys  = store.getDeployments(1);
  const deploy   = deploys[0] ?? null;

  const repro = generateReproSteps(logs, network, contexts);

  // CODEOWNERS for the primary error file
  let ownersLine = '';
  if (latest?.chain?.errors?.[0]?.primaryFrame?.file) {
    const owners = findCodeOwners(latest.chain.errors[0].primaryFrame.file, process.cwd());
    if (owners?.owners?.length) ownersLine = `\nOwners: ${owners.owners.join(', ')}`;
  }

  const title = hyp?.summary ?? 'Bug report from Mergen';

  const parts: string[] = [];
  if (hyp?.summary) parts.push(`**Issue:** ${hyp.summary}`);
  if (hyp?.fixHint) parts.push(`**Suggested fix:** ${hyp.fixHint}`);
  if (deploy)       parts.push(`**Affected SHA:** ${deploy.shortSha ?? deploy.sha.slice(0, 7)} (${deploy.environment})`);
  if (ownersLine)   parts.push(ownersLine);

  if (repro.steps.length > 0) {
    parts.push('\n**Steps to reproduce:**');
    repro.steps.forEach((s, i) => parts.push(`${i + 1}. ${s}`));
  }

  if (hyp?.evidence?.length) {
    parts.push('\n**Evidence:**');
    hyp.evidence.slice(0, 5).forEach((e) => parts.push(`- ${e}`));
  }

  const dashUrl = process.env.MERGEN_DASHBOARD_URL;
  if (dashUrl) parts.push(`\n[View in Mergen](${dashUrl}/dashboard)`);
  parts.push('\n_Generated automatically by Mergen_');

  return { title, description: parts.join('\n') };
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

function httpPost(url: string, body: string, headers: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (c: Buffer) => { data += c.toString(); });
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

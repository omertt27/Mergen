# Mergen Quick Start

> Prompts are not enforcement. Mergen is the inline gate that physically blocks hazardous AI agent actions before they reach your runtime, databases, or cloud infrastructure.

**Pilot success condition:** Mergen is running on your machine, the local policy gate is intercepting tool calls, and the Agent Blunder Log has at least one entry.

---

## Install

```bash
npm install -g mergen-server
```

Or run without installing:

```bash
npx mergen-server
```

---

## Step 1 — Start the server (30 seconds)

```bash
mergen-server start
```

The server binds to `127.0.0.1:3000` by default. Nothing leaves your machine.

Verify the gate is live:

```bash
curl http://127.0.0.1:3000/health
```

Expected: `{ "ok": true, "gate": "active", ... }`

---

## Step 2 — Add to your AI IDE

The gate only intercepts calls that pass through Mergen's MCP server. Register it:

```bash
# Guided setup — detects your IDE automatically
mergen-server setup

# Or manually for Claude Code
claude mcp add mergen --transport stdio -- mergen-server start
```

One-click installs:

[![Install in Cursor](https://img.shields.io/badge/Cursor-Install%20MCP-000?logo=cursor&logoColor=white)](cursor://anysphere.cursor-deeplink/mcp/install?name=mergen&command=npx&args=mergen-server%20start)
[![Install in VS Code](https://img.shields.io/badge/VS%20Code-Install%20MCP-007ACC?logo=visualstudiocode&logoColor=white)](vscode://github.copilot-chat/installMcpServer?name=mergen&command=npx&args=mergen-server%20start)
[![Install in Windsurf](https://img.shields.io/badge/Windsurf-Install%20MCP-4A90D9?logo=windsurf&logoColor=white)](windsurf://mcp/install?name=mergen&command=npx&args=mergen-server%20start)
[![Install in Claude Code](https://img.shields.io/badge/Claude%20Code-Add%20MCP-D97706?logo=anthropic&logoColor=white)](https://claude.ai/code?addMcp=mergen)

Restart your IDE after setup.

---

## Step 3 — Verify the gate is intercepting

Ask your AI agent to run a destructive command. The gate should block it before the handler runs:

```
# In your AI IDE, ask:
"Run: terraform destroy prod"
```

Expected response from Mergen:

```
🚫 Tool call blocked by Mergen local policy gate.
Tool: execute_fix
Reason: Local Gate: Destructive command pattern matched.
This action was logged to the Agent Blunder Log (GET /agent-blunders).
```

Check the Agent Blunder Log:

```bash
curl http://127.0.0.1:3000/agent-blunders | jq '{total: .stats.total, byType: .stats.byType}'
```

If you see `"total": 1` — the gate is working. Pilot complete.

---

## Step 4 — Configure HITL approval for schema mutations

Schema migrations are held (not blocked) until a human approves. Set a webhook URL and any migration command will suspend until you click Approve or Deny:

```bash
MERGEN_HITL_WEBHOOK_URL=https://hooks.slack.com/... mergen-server start
```

In team/cloud mode, also set the externally reachable URL so Slack can POST the callback:

```bash
MERGEN_PUBLIC_URL=https://mergen.your-company.com mergen-server start
```

Test it — ask your agent to run a migration:

```
"Run: prisma migrate deploy"
```

Mergen suspends the call and fires the Slack webhook. Your IDE waits. Click Approve — execution resumes. Click Deny — MCP error returned.

---

## Step 5 — Connect your incident data (optional)

Once the gate is running, connect production signals to enable root cause analysis:

```bash
# Docker logs — streams all running containers, zero config
curl -X POST http://127.0.0.1:3000/watchers/docker

# PagerDuty — in PagerDuty: Service → Integrations → Webhooks
# URL: https://your-host:3000/webhooks/pagerduty
export MERGEN_PAGERDUTY_SECRET=your-pd-signing-secret

# OpenTelemetry (any language — one env var)
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:3000 node app.js

# Datadog (trace fetch + blame attribution)
export DD_API_KEY=... DD_APP_KEY=...
```

In your IDE:

```
"What caused the last incident?"
"Triage the api-service"
```

---

## Step 6 — Shadow mode (30-day trust track record before autopilot)

Before enabling autonomous execution, run in shadow mode. Mergen evaluates every incident, records what it would have done, and posts to Slack — without executing anything:

```bash
MERGEN_SHADOW_MODE=true \
MERGEN_SLACK_BOT_TOKEN=xoxb-... \
MERGEN_SLACK_CHANNEL=#incidents \
mergen-server start
```

After 30 days, pull the shadow report:

```bash
curl http://127.0.0.1:3000/shadow-report
# → totalEvaluated, wouldHaveBlocked, corpusMatches
```

This is the evidence package your CISO needs before you flip the autopilot switch.

---

## Step 7 — Build the Override Corpus

Every human override becomes enforcement policy. Two automatic sources:

**Slack postmortems** — scans your incident channel for override patterns and encodes them:

```bash
MERGEN_SLACK_OVERRIDE_LOOP=true mergen-server start
```

**Git ADRs** — reads architectural decision records and materialises operational constraints:

```bash
MERGEN_GIT_ADR_SYNC=true mergen-server start
```

Check what's been encoded:

```bash
curl http://127.0.0.1:3000/override-corpus | jq '.summary'
```

After 30–90 days the corpus contains your team's specific enforcement policy — Friday settlement windows, compliance holds, infrastructure constraints — impossible to replicate from a standing start.

---

## Step 8 — Enable autopilot (after shadow track record)

```bash
MERGEN_AUTOPILOT=true \
MERGEN_SHADOW_MODE=false \
MERGEN_PAGERDUTY_SECRET=... \
mergen-server start
```

PagerDuty triggers → Mergen analyzes → fixes at ≥85% confidence → validates → posts audit trail to Slack. Every action stays within the policy bounds the gate enforces.

---

## CI/CD Safety Gate

Add the Mergen AEG gate to any PR workflow:

```yaml
# .github/workflows/mergen-gate.yml
name: Mergen AEG Gate
on: [pull_request]
jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - uses: omertt27/Mergen@main
        with:
          mergen-url: ${{ secrets.MERGEN_URL }}
          mergen-secret: ${{ secrets.MERGEN_SECRET }}
          fail-on-block: 'true'
          post-comment: 'true'
```

AI-generated PRs that touch areas your team has historically overridden get blocked before merge. The gate posts a structured PR comment with verdict, risk score, and reasons.

---

## Policy configuration

The local gate is configured by `~/.mergen/enterprise-policy.json` — created automatically on first start. Edit it to add your own rules:

```json
{
  "enabled": true,
  "rules": [
    {
      "id": "no_prod_deploys_friday",
      "name": "Block production deploys on Fridays",
      "action": "block",
      "reason": "No production deploys after 14:00 UTC on Fridays.",
      "conditions": {
        "commands": ["deploy", "helm upgrade", "kubectl apply"],
        "actorType": "ai",
        "daysOfWeek": [5],
        "hourWindow": [14, 24]
      }
    }
  ]
}
```

Changes are hot-reloaded — no server restart required.

---

## Check integration status

```bash
mergen-server doctor
```

Prints a health report of every integration with exact `export` commands for anything missing.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `mergen-server: command not found` | Use `npx mergen-server` instead |
| Port 3000 in use | Server auto-tries 3000–3010. Kill: `lsof -ti:3000 \| xargs kill` |
| IDE not showing Mergen tools | Restart IDE after `mergen-server setup` |
| Gate not blocking destructive commands | Verify MCP is registered: `claude mcp list` |
| HITL webhook not firing | Set `MERGEN_HITL_WEBHOOK_URL` and `MERGEN_PUBLIC_URL` |
| PagerDuty not triggering | Set `MERGEN_PAGERDUTY_SECRET`; check webhook URL includes your public host |

---

**Questions?** [Open an issue](https://github.com/omertt27/Mergen/issues) · [Full docs →](README.md) · [Design partner program →](docs/design-partner/outreach-email.md)

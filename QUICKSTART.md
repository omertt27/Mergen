# Mergen Quick Start

> AI coding agents made writing code free. Mergen makes debugging production automatic.

Connect your AI IDE to live incident telemetry in under 2 minutes.
Once connected, ask *"Triage the api-service"* — get a causal chain with a fix command, not a log dump.

**Pilot success condition:** Mergen correctly analyzes 1 real incident in your environment.

---

## One-click install

[![Install in Cursor](https://img.shields.io/badge/Cursor-Install%20MCP-000?logo=cursor&logoColor=white)](cursor://anysphere.cursor-deeplink/mcp/install?name=mergen&command=npx&args=mergen-server%20start)
[![Install in VS Code](https://img.shields.io/badge/VS%20Code-Install%20MCP-007ACC?logo=visualstudiocode&logoColor=white)](vscode://github.copilot-chat/installMcpServer?name=mergen&command=npx&args=mergen-server%20start)
[![Install in Windsurf](https://img.shields.io/badge/Windsurf-Install%20MCP-4A90D9?logo=windsurf&logoColor=white)](windsurf://mcp/install?name=mergen&command=npx&args=mergen-server%20start)
[![Install in Claude Code](https://img.shields.io/badge/Claude%20Code-Add%20MCP-D97706?logo=anthropic&logoColor=white)](https://claude.ai/code?addMcp=mergen)

---

## Step 1 — See it work immediately (60 seconds, no config)

```bash
npx mergen-server
```

Opens `http://localhost:3000/demo` with 50 real incident scenarios pre-loaded from public postmortems. Click "Trigger P1 Incident" — Mergen runs causal analysis and shows the root cause. No PagerDuty. No OTLP. No IDE setup.

This is the fastest path to understanding what Mergen does.

---

## Step 2 — Set up your IDE (30 seconds)

```bash
npx mergen-server@latest setup
```

Detects your IDE (Claude Code, Cursor, VS Code, Windsurf), writes the MCP config, and guides you through optional integrations.

**Non-interactive / CI mode:**

```bash
# Skip all prompts, use defaults
npx mergen-server@latest setup --yes

# Target a specific IDE
npx mergen-server@latest setup --ide cursor

# Skip optional steps
npx mergen-server@latest setup --skip-github
```

Then start the server:

```bash
mergen-server start
```

In your AI IDE, ask: *"What caused the last incident?"*

---

## Step 3 — Connect one real data source

When you're ready to move from sample incidents to real production data, connect one source. Start with Docker — it requires zero configuration:

```bash
# Docker logs — streams all running containers immediately
curl -X POST http://127.0.0.1:3000/watchers/docker
```

Or connect your alerting layer:

```bash
# PagerDuty
# Service → Integrations → Webhooks → https://your-host:3000/webhooks/pagerduty
export MERGEN_PAGERDUTY_SECRET=...

# OpenTelemetry (any language — one env var change)
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:3000 node app.js

# Datadog (trace fetch + blame attribution)
export DD_API_KEY=... DD_APP_KEY=...
```

**Pilot success:** once Mergen correctly analyzes 1 real incident in your environment, the pilot is done.

---

## Step 4 — Add to your AI IDE (if not done via setup)

```bash
# Claude Code
claude mcp add mergen --transport stdio -- mergen-server start

# Cursor / Windsurf / VS Code
mergen-server setup  # writes the config file automatically
```

Ask:
- *"Triage the latest incident"* — full causal analysis + fix hint
- *"What is the error rate on api-service?"* — live telemetry lookup
- *"What would have happened if autopilot ran last night?"* — shadow report summary

---

## Step 5 — Enable shadow mode (optional, recommended before autopilot)

Run for 30 days before enabling autonomous execution. Mergen analyzes every incident and posts what it *would have done* to your Slack thread — without executing anything:

```bash
MERGEN_SHADOW_MODE=true \
MERGEN_SLACK_BOT_TOKEN=xoxb-... \
MERGEN_SLACK_CHANNEL=#incidents \
mergen-server start
```

After 30 days, pull the impact report:

```bash
# Shareable HTML one-pager — open in browser, save as PDF for your CISO
open http://127.0.0.1:3000/impact-report?format=html
```

---

## Check integration status at any time

```bash
mergen-server doctor
```

Prints a health report of every integration (Slack, PagerDuty, GitHub, Datadog, Linear, Jira) with exact `export` commands for anything missing.

---

## Configure optional integrations

```bash
cp server/.env.example .env
# Edit .env — divided into "MINIMUM" and "FULL INTEGRATIONS" sections
```


---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `mergen-server: command not found` | Use `npx mergen-server` instead |
| Port 3000 in use | Server auto-tries 3000–3010. Kill with: `lsof -ti:3000 \| xargs kill` |
| IDE not showing Mergen tools | Restart IDE after setup; run `mergen-server test` |
| No events after connecting Docker | Check Docker daemon is running; verify with `docker ps` |
| PagerDuty not firing | Confirm webhook URL includes your host, not localhost |

---

## Alternative install methods

```bash
# Docker
docker-compose up

# Homebrew (macOS)
brew tap omertt27/mergen && brew install mergen

# Binary — no Node.js required
# https://github.com/omertt27/Mergen/releases
```

---

## Architecture

```
Your infrastructure
  ├── PagerDuty      → /webhooks/pagerduty
  ├── OpenTelemetry  → :3000/v1/traces (OTLP HTTP)
  ├── Docker         → log streaming
  └── CI/CD          → /ci

              ↓ incident.triggered

  Mergen HTTP server :3000   (ring buffer, 2000 events)
    1. Receives webhook
    2. Fetches Datadog trace context (if configured)
    3. Posts structured alert to Slack thread
    4. Runs causal analysis across all signals
    5. Consults override corpus — has this been overridden before?
    6. If confidence ≥ 85% and MERGEN_AUTOPILOT=true:
         → executes fix → validates → posts RESOLVED to thread

              ↓ MCP stdio transport

  AI IDE (Claude Code / Cursor / Windsurf / VS Code)
```

**All data stays on your infrastructure. No cloud. No copy-paste.**

---

**Questions?** Open an issue · [Full docs →](README.md) · [Enterprise guide →](docs/enterprise.md)

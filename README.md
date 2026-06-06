<div align="center">

# Mergen

### The AI operations layer for backend & infrastructure.

**Triages production incidents autonomously.**  
PagerDuty fires → Mergen diagnoses → executes fix at ≥85% confidence → validates → posts result to Slack thread.

[![npm](https://img.shields.io/npm/v/mergen-server)](https://www.npmjs.com/package/mergen-server)
[![License](https://img.shields.io/badge/license-MIT%20%2B%20Proprietary-blue)](./LICENSE)
[![MCP](https://img.shields.io/badge/Model%20Context%20Protocol-stdio-black)](https://modelcontextprotocol.io)
[![Privacy](https://img.shields.io/badge/data-your%20infra%20only-success)](#security)

[**Quick Start →**](#quick-start) · [**How it works →**](#how-it-works) · [**Integrations →**](#integrations) · [**Pricing →**](#pricing)

</div>

---

## The problem

Your on-call engineer gets paged at 3am. They spend 40 minutes reading logs, forming a hypothesis, applying a fix, waiting to see if it worked. Then they write a postmortem about it.

That 40 minutes is the problem. Every time. For every incident.

Mergen closes the loop: **detect → diagnose → fix → validate**, without waking anyone up.

---

## How it works

```
Your infrastructure
  ├── OpenTelemetry  →  :3000/v1/traces   (any language, zero code changes)
  ├── PagerDuty      →  /webhooks/pagerduty
  ├── Docker         →  log streaming
  └── CI/CD          →  /ci

              ↓ incident.triggered

  Mergen (Express + MCP stdio)
    1. Receives PagerDuty webhook
    2. Fetches trace context from Datadog (if configured)
    3. Posts structured alert to Slack thread (owns the thread)
    4. Runs causal analysis across all telemetry signals
    5. If confidence ≥ 85% AND MERGEN_AUTOPILOT=true:
         → executes the fix command
         → waits 5s → counts errors before/after
         → posts RESOLVED / PARTIAL / REGRESSED to thread
    6. Records resolvedAutonomously + MTTR to incident store

              ↓ your AI IDE (Claude Code / Cursor / Windsurf / VS Code)

  MCP tools available on demand:
    triage_incident   → full autonomous loop
    analyze_runtime   → diagnosis only, no execution
    execute_fix       → run a specific fix (requires confirm: true)
    validate_fix      → compare error counts before/after
```

---

## Quick start

```bash
# Install
npm install -g mergen-server

# Configure (interactive — IDE + integrations)
mergen-server setup

# Start
MERGEN_SLACK_BOT_TOKEN=xoxb-... \
MERGEN_SLACK_CHANNEL=#incidents \
MERGEN_AUTOPILOT=true \
mergen-server start
```

**Then in PagerDuty:** Services → Integrations → Webhooks → `https://your-server:3000/webhooks/pagerduty`

**Then in your AI IDE:** *"Triage the latest incident"* — Mergen calls `triage_incident` automatically.

---

## What an autonomous resolution looks like

```
[03:17] PagerDuty → incident.triggered: "api-service HIGH error rate"

[03:17] Mergen → #incidents:
  🚨 Production Incident — api-service
  Fired just now  |  PagerDuty

  ✅ Causal Attribution — 91% [HIGH]
  Deploy `a3f8c12` • production
  • Deploy 4 minutes before error spike
  • auth/middleware.ts in changed files

  📊 Blast Radius
  12 sessions affected (3 authenticated users)

[03:17] Mergen → #incidents (thread):
  🔍 Root Cause Analysis
  Hypothesis: JWT validation middleware rejecting valid tokens after dependency upgrade
  Confidence: HIGH (91%)
  Fix: npm install jsonwebtoken@9.0.0 && pm2 restart api

[03:17] Mergen → #incidents (thread):
  ⚙️ Autopilot executing fix
  `npm install jsonwebtoken@9.0.0 && pm2 restart api`

[03:22] Mergen → #incidents (thread):
  ✅ RESOLVED — 0 errors after fix (was 14)

[03:22] incident store: resolvedAutonomously=true, MTTR=5m
```

Engineer wakes up to a resolved incident and a Slack thread with the full audit trail.

---

## Integrations

### OpenTelemetry (any language, zero code changes)

```bash
# Python / Django / FastAPI
OTEL_EXPORTER_OTLP_ENDPOINT=http://your-mergen-server:3000 \
OTEL_SERVICE_NAME=api python app.py

# Node.js / Express / NestJS
OTEL_EXPORTER_OTLP_ENDPOINT=http://your-mergen-server:3000 \
OTEL_SERVICE_NAME=api node app.js

# Go / Java / Ruby / .NET — same env var pattern
```

### Node.js (one line, zero deps)

```js
// Top of your entry point — captures uncaught exceptions + process exits
import 'mergen-server/sdk/node.js';
```

### Docker containers

```bash
curl -X POST http://127.0.0.1:3000/watchers/docker
# Streams stdout/stderr from all running containers into Mergen's buffer
```

### CI/CD (GitHub Actions)

```yaml
- name: Notify Mergen
  if: failure()
  run: |
    curl -X POST $MERGEN_URL/ci \
      -H 'Content-Type: application/json' \
      -d '{"status":"failed","branch":"${{ github.ref_name }}","sha":"${{ github.sha }}"}'
```

### Slack (required for autonomous loop)

1. Create a Slack app at [api.slack.com/apps](https://api.slack.com/apps)
2. Add OAuth scope: `chat:write`
3. Install to workspace → copy Bot Token (`xoxb-...`)
4. Set `MERGEN_SLACK_BOT_TOKEN` and `MERGEN_SLACK_CHANNEL`

Mergen uses `chat.postMessage` (not incoming webhooks) so it owns the thread and can post progress replies through the resolution.

### Per-service Slack routing

```bash
curl -X POST http://127.0.0.1:3000/slack/routing \
  -H 'Content-Type: application/json' \
  -d '{
    "service": "payments",
    "channel": "#payments-incidents",
    "minConfidence": 0.8,
    "escalateAt": 0.95,
    "oncallMention": "<!oncall>"
  }'
```

---

## MCP tools (AI IDE integration)

Connect Mergen to your AI IDE and ask it about your incidents directly:

```bash
# Claude Code
claude mcp add mergen --transport stdio -- mergen-server start

# Cursor / Windsurf / VS Code
mergen-server setup  # writes the config file automatically
```

| Tool | What it does |
|------|-------------|
| `triage_incident` | Full autonomous loop — diagnosis + optional fix execution |
| `analyze_runtime` | Root cause analysis, no execution |
| `execute_fix` | Run a hypothesis fix (`confirm: true` required) |
| `validate_fix` | Error count before/after — records verdict to corpus |
| `get_recent_logs` | Console/log events from the buffer |
| `get_network_activity` | HTTP events with status, duration, response body |
| `get_unified_timeline` | Request joined to backend span (exact causal join) |
| `clear_buffer` | Empty the ring buffer |

**Example prompts:**
- *"What caused the last incident?"*
- *"Triage the api-service — auto-execute if confident"*
- *"Why are 401s spiking on /api/auth?"*

---

## Impact metrics

```bash
curl http://127.0.0.1:3000/incidents/impact-report
```

```json
{
  "totalResolved": 24,
  "autonomousResolutions": 11,
  "autonomousRate": 46,
  "mttr": {
    "overallMs": 420000,
    "autonomousMs": 38000,
    "manualMs": 720000
  }
}
```

46% autonomous resolution rate. MTTR of 38 seconds for autonomous resolutions vs. 12 minutes for manual. This is the number your board asks about.

---

## Security

- **Local by default** — ingest binds to `127.0.0.1`. Nothing leaves your infrastructure.
- **Cloud mode** — TLS (`MERGEN_TLS_CERT` / `MERGEN_TLS_KEY`) + SHA-256 hashed API keys + sliding-window rate limiting + per-tenant event isolation.
- **PII shield** — always-on regex patterns: email, phone, AWS access keys, PEM private keys, JWTs, credit card numbers. Configurable via `~/.mergen/pii-config.json`.
- **Execution safety** — 15-pattern blocklist (no `rm -rf`, no `curl | bash`, no `DROP TABLE`, no force push). 60s timeout. Every execution audit-logged.
- **Confidence gate** — autonomous execution only at ≥85% confidence. Configurable per service.

```bash
# Optional shared secret (local mode)
MERGEN_SECRET=mysecret mergen-server start

# Cloud mode (multi-tenant, one instance per tenant)
MERGEN_CLOUD_MODE=true \
MERGEN_TLS_CERT=/path/cert.pem \
MERGEN_TLS_KEY=/path/key.pem \
mergen-server start
```

---

## Pricing

| Plan | Price | What's included |
|------|-------|----------------|
| **Open source** | Free | All sensor + buffer + MCP tools. Self-hosted. |
| **Team** | $49/seat/mo | Corpus calibration, Slack thread ownership, impact report |
| **Enterprise** | Custom | Multi-tenant cloud, SSO, SLA, compliance reports |

The sensor layer (ingest, buffer, all MCP read tools) is MIT-licensed and free forever. The analysis engine (`analyze_runtime`, `triage_incident`, calibration corpus) is proprietary.

---

## Verify your setup

```bash
# Health check
curl -s http://127.0.0.1:3000/health | python3 -m json.tool

# Simulate a backend incident
curl -X POST http://127.0.0.1:3000/ingest \
  -H 'Content-Type: application/json' \
  -d '{
    "type": "console",
    "level": "error",
    "args": ["[api] database connection timeout — pool exhausted after 30s"],
    "url": "http://api:8080/health",
    "timestamp": '$(date +%s000)'
  }'

# Run the demo incident autopilot
mergen-server demo

# Check impact report
curl -s http://127.0.0.1:3000/incidents/impact-report
```

---

## Self-host vs. cloud

Mergen runs entirely on your infrastructure. Your telemetry never leaves. For teams that want hosted Mergen (multi-tenant, managed updates, compliance exports), reach out: **hello@mergen.dev**

---

## Community

- [GitHub Discussions](https://github.com/omertt27/Mergen/discussions) — questions, patterns, false positives
- [Issues](https://github.com/omertt27/Mergen/issues) — bugs and feature requests

---

<div align="center">

**Mergen — triage incidents while you sleep.**

</div>

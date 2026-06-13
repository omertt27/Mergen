# Mergen — System Understanding Infrastructure for High-Change Software Environments

As AI makes writing code cheap, understanding software systems becomes the bottleneck. GitHub stores what changed. Not why the Friday settlement window makes connection pool resizing unsafe. Not which fix your on-call reaches for at 3am. Engineers and AI agents make changes blind to those constraints.

Mergen is the real-time system understanding layer: an MCP server that surfaces hidden constraints, historical decisions, and operational context so engineers and AI agents can make changes safely. It compresses raw production telemetry into structured machine context and encodes your team's override decisions as queryable policy. When a change is about to be made, Mergen answers the question: *is it safe to make this change here, now, given what this system has done before?*

All data stays on your infrastructure. No cloud. No copy-paste.

---

## Why Mergen vs. existing observability tools?

| | Datadog / PagerDuty / Grafana | **Mergen** |
| :--- | :--- | :--- |
| **Action** | Alert → page engineer | ✅ **Alert → diagnose → fix → validate** |
| **AI integration** | Dashboard with AI summaries | ✅ **MCP tools your AI IDE calls directly** |
| **Execution** | Human runs the fix | ✅ **Autonomous execution at ≥85% confidence** |
| **System understanding** | None — stateless alerting | ✅ **Override corpus + calibration corpus — system context and safety accuracy improve with every incident** |
| **Agent safety** | None | ✅ **Agent Blunder Log — every blocked action recorded; corpus-enforced override policy** |
| **Slack** | One-way webhook | ✅ **Owns the thread — posts progress through resolution** |

---

## Defensibility: two primitives that compound with use

### Agent Blunder Log — `GET /agent-blunders`

Every time Mergen's safety layer blocks an autonomous action the event is recorded. `prevented` = total intercepted actions. Types: `allowlist_block` · `injection_attempt` · `rbac_block` · `override_corpus_block` · `pipeline_block` · `planning_gate_block`. Wired automatically — no setup required. This is the board-deck answer to "why would you trust an AI agent with prod?"

### Override Corpus — queryable operational DNA

Every team override is encoded as policy. The corpus is consulted before every autonomous action — Mergen will pause before repeating an action overridden in the same context. `GET /override-corpus` shows what the system has learned. Builds automatically from shadow mode annotations. After six months: your Friday settlement windows, your compliance holds, your on-call's preferred fixes — impossible to replicate from a standing start.

### Organic Habituation — `GET /habituation`

Weekly rate of engineers who received a Mergen PR comment and then submitted a review on that PR. `habituationRate` = engaged / engineers_with_comments. Requires `MERGEN_PR_COMMENTS=true`. Wired automatically when comments are posted and reviews received.

### Context-Assisted MTTR

`GET /trust-score/:pid` auto-marks the incident context as viewed. `GET /impact-report` then shows `avgContextAssistedMttrMs` vs `avgUnassistedMttrMs` — how much faster engineers resolve when they read Mergen's brief first.

---

## How it works

```
Your backend / infrastructure
  ├── OpenTelemetry SDK  →  :4318/v1/traces  (OTLP HTTP)
  ├── PagerDuty webhook  →  /webhooks/pagerduty
  ├── CI/CD pipeline     →  /ci  (GitHub Actions, etc.)
  ├── Docker containers  →  log streaming via Docker SDK
  └── Terminal / process →  process watcher (stdout/stderr)
              │
              ▼
  Express :3000           ← rate-limited, Zod-validated, PII-shielded
       │
       └── in-memory ring buffer (2000 events, O(1) eviction)
                │
                ▼
  MCP Server (stdio)      ← speaks Model Context Protocol
       │
       ├── Claude Code  ──  claude mcp add mergen ...
       ├── Cursor        ──  .cursor/mcp.json
       ├── Windsurf      ──  ~/.codeium/windsurf/mcp_config.json
       └── VS Code       ──  .vscode/mcp.json
                │
                ▼
  Autonomous triage loop (MERGEN_AUTOPILOT=true)
       PagerDuty trigger → causal analysis → execute fix → validate → Slack thread reply
```

One server. Every AI IDE. Full autonomous loop.

---

## ⚡ Quick Install (SRE / Platform Team)

```bash
# 1. Install server
npm install -g mergen-server

# 2. Configure integrations
mergen-server setup
# → connects PagerDuty, Slack, OTLP, and your AI IDE

# 3. Start
mergen-server start
```

### Environment variables

```bash
# Core
MERGEN_AUTOPILOT=true              # enable autonomous fix execution
MERGEN_SLACK_BOT_TOKEN=xoxb-...    # Slack Web API (threads + replies)
MERGEN_SLACK_CHANNEL=#incidents    # default incident channel

# PagerDuty → Mergen webhook
# In PagerDuty: Service → Integrations → Webhooks → https://your-server:3000/webhooks/pagerduty

# OpenTelemetry ingest
# Point your OTLP exporter at http://your-server:3000/v1/traces (HTTP)
# or http://your-server:4317 (gRPC, if enabled)

# Datadog (for blame attribution)
DD_API_KEY=...
DD_APP_KEY=...
DATADOG_SITE=datadoghq.com

# Cloud mode (multi-tenant SaaS deployment)
MERGEN_CLOUD_MODE=true
MERGEN_TLS_CERT=/path/to/cert.pem
MERGEN_TLS_KEY=/path/to/key.pem
```

---

## Autonomous incident flow

When PagerDuty fires `incident.triggered`:

```
1. Mergen receives webhook → records incident open time (MTTR clock starts)
2. Fetches trace from Datadog (if configured)
3. Posts structured incident alert to Slack thread
4. [AUTOPILOT] Waits 5s for telemetry → runs causal analysis
5. [AUTOPILOT] If confidence ≥ 85% → executes fix command
6. [AUTOPILOT] Waits 5s → validates (compares error counts before/after)
7. [AUTOPILOT] Posts RESOLVED / PARTIAL / REGRESSED to Slack thread
8. Records resolvedAutonomously=true → available in /incidents/impact-report
```

**Disable autopilot for diagnosis-only mode:** omit `MERGEN_AUTOPILOT=true`.
The MCP tool `triage_incident` is still available for on-demand analysis.

---

## MCP tools reference (AI IDE)

| Tool | What it does |
|------|-------------|
| `triage_incident` | Full autonomous loop on demand — diagnosis + optional fix |
| `execute_fix` | Execute a specific hypothesis fix (requires `confirm: true`) |
| `analyze_runtime` | Causal analysis — root cause + fix hint, no execution |
| `get_recent_logs` | Console events from the buffer |
| `get_network_activity` | HTTP/fetch events with status, duration, body |
| `get_unified_timeline` | Browser request joined to backend span (exact causal join) |
| `validate_fix` | Compare error counts before/after a fix — records verdict |
| `clear_buffer` | Empties the ring buffer |

---

## Impact metrics

```bash
# Board-deck metric: autonomous resolution rate + MTTR
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

---

## Backend instrumentation

### OpenTelemetry (any language)

Point your OTLP exporter at Mergen:

```bash
# Python
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:3000 python app.py

# Node.js
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:3000 node app.js

# Go / Java / Ruby / .NET — same env var
```

### Node.js SDK (one line)

```js
// At the top of your entry point
import 'mergen-server/sdk/node.js';
// Captures uncaught exceptions, unhandledRejections, and process exits automatically
```

### Docker containers

```bash
# Stream logs from all running containers
curl -X POST http://127.0.0.1:3000/docker/stream
```

### CI/CD pipelines

```bash
# GitHub Actions — post build result to Mergen
curl -X POST http://127.0.0.1:3000/ci \
  -H 'Content-Type: application/json' \
  -d '{"status":"failed","branch":"main","sha":"'$GITHUB_SHA'","runUrl":"'$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID'"}'
```

---

## IDE setup (manual)

### Claude Code

```bash
claude mcp add mergen --transport stdio -- node "$(pwd)/server/dist/index.js"
claude mcp list  # verify
```

Ask: *"What caused the last incident?"*

### Cursor / Windsurf / VS Code

`.cursor/mcp.json` and `.vscode/mcp.json` are already committed.
Open the Mergen repo and the server is available immediately.

For a global install: `mergen-server setup` → choose your IDE.

---

## Slack service routing

Route alerts for different services to different channels:

```bash
# POST /slack/routing
curl -X POST http://127.0.0.1:3000/slack/routing \
  -H 'Content-Type: application/json' \
  -d '{
    "service": "api",
    "webhook": "https://hooks.slack.com/...",
    "channel": "#api-incidents",
    "minConfidence": 0.7,
    "escalateAt": 0.9,
    "oncallMention": "<!oncall>"
  }'
```

---

## Security

- Ingest binds to `127.0.0.1` by default — unreachable externally
- Cloud mode: TLS + SHA-256 hashed API keys + sliding-window rate limiting
- PII shield: always-on regex patterns (email, phone, AWS keys, PEM certs, JWTs, credit cards) + configurable via `~/.mergen/pii-config.json`
- Tenant isolation: events tagged at ingest, filtered on every read

```bash
# Optional shared secret (local mode)
MERGEN_SECRET=mysecret mergen-server start
```

---

## Verify everything works

```bash
# 1. Health check
curl -s http://127.0.0.1:3000/health | python3 -m json.tool

# 2. Simulate a backend error event
curl -s -X POST http://127.0.0.1:3000/ingest \
  -H 'Content-Type: application/json' \
  -d '{"type":"console","level":"error","args":["[api] database connection timeout after 30s"],"url":"http://api:8080","timestamp":'$(date +%s000)'}'

# 3. In your AI IDE: "triage the latest incident"
#    Mergen calls analyze_runtime → returns root cause + fix hint

# 4. Check impact report
curl -s http://127.0.0.1:3000/incidents/impact-report | python3 -m json.tool
```

---

## Rebuild after changes

```bash
cd server && npm run build
```

---

## Browser extension (optional)

The Chrome extension adds browser-side telemetry (console logs, fetch errors,
localStorage) to Mergen's context. Useful for full-stack debugging where you
need to correlate frontend errors with backend spans.

```
chrome://extensions → Developer mode → Load unpacked → extension/ folder
```

This is optional — Mergen's core value is backend/infra triage, not browser debugging.

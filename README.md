<div align="center">

# Mergen

### The autonomous operations agent layer.

Your observability tools tell you what's broken.  
**Mergen decides what to do about it — and does it.**

PagerDuty fires → Mergen diagnoses across all telemetry signals → executes the fix at ≥85% confidence → validates → posts the full audit trail to your Slack thread. Without waking anyone up.

[![npm](https://img.shields.io/npm/v/mergen-server)](https://www.npmjs.com/package/mergen-server)
[![License](https://img.shields.io/badge/license-MIT%20%2B%20Proprietary-blue)](./LICENSE)
[![MCP](https://img.shields.io/badge/Model%20Context%20Protocol-stdio-black)](https://modelcontextprotocol.io)
[![Privacy](https://img.shields.io/badge/data-your%20infra%20only-success)](#security)

[**Quick Start →**](#quick-start) · [**Shadow Mode →**](#before-you-enable-autopilot-shadow-mode) · [**How it works →**](#how-it-works) · [**Integrations →**](#integrations)

</div>

---

## Who is this for

**10–100 person engineering teams** where:
- PagerDuty wakes up a human for every incident
- You don't have a dedicated SRE or internal automation platform
- Your on-call rotation is developers who also write features

If you're at a company with an internal ops automation platform (most FAANG-scale companies), Mergen probably duplicates something you already have. If you're a 20-person startup where the CTO is on the pager, this is for you.

---

## The problem

Your on-call engineer gets paged at 3am. They spend 40 minutes reading logs, forming a hypothesis, applying a fix, waiting to see if it worked. Then they write a postmortem about it.

That 40 minutes is the problem. Every time. For every incident.

Mergen closes the loop: **detect → diagnose → fix → validate**, without waking anyone up.

---

## Why Mergen vs. existing tools?

Datadog, PagerDuty, and Grafana tell you what's broken. They don't act.

| | Datadog / PagerDuty / Grafana | **Mergen** |
| :--- | :--- | :--- |
| **Action** | Alert → page engineer | ✅ **Alert → diagnose → fix → validate** |
| **Execution** | Human runs the fix | ✅ **Autonomous execution at ≥85% confidence** |
| **AI integration** | Dashboard summaries | ✅ **MCP tools your AI IDE calls directly** |
| **Memory** | Forgets every incident | ✅ **Override corpus — learns your team's operational patterns. After 12 months: your Friday settlement windows, your compliance holds, your on-call discretion. Structured knowledge that can't be exported.** |
| **Network effect** | No cross-customer learning | ✅ **Calibration corpus — each opted-in installation contributes anonymous accuracy signals. Every new deployment starts smarter than the last. Accuracy compounds across the network.** |
| **Slack** | One-way webhook | ✅ **Owns the thread — posts progress through resolution** |

Mergen sits above your observability stack. It doesn't replace Datadog — it acts on what Datadog tells it.

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
    5. Consults override corpus — has this action been overridden before?
    6. If confidence ≥ 85% AND MERGEN_AUTOPILOT=true AND corpus permits:
         → executes the fix command
         → waits 5s → counts errors before/after
         → posts RESOLVED / PARTIAL / REGRESSED to thread
    7. Records resolvedAutonomously + MTTR to incident store

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

# Start in shadow mode first (recommended)
MERGEN_SHADOW_MODE=true \
MERGEN_SLACK_BOT_TOKEN=xoxb-... \
MERGEN_SLACK_CHANNEL=#incidents \
mergen-server start
```

**Then in PagerDuty:** Services → Integrations → Webhooks → `https://your-server:3000/webhooks/pagerduty`

**Then in your AI IDE:** *"Triage the latest incident"* — Mergen calls `triage_incident` automatically.

---

## Honest note on confidence numbers

When you first install Mergen, confidence scores like "91%" are **initial engineering estimates** — not measured from your production incidents. They reflect our judgment of how reliable each detector is across common failure modes.

After you record verdicts on your own incidents (via `/feedback` or the shadow mode annotation API), those numbers become **empirically calibrated to your system**. The Slack thread and MCP output always show whether a confidence score is `estimated` or `calibrated — N verdicts`, so you're never guessing which is which.

Detectors that are consistently wrong on your system get demoted or suppressed automatically. Detectors that are consistently right earn trust. The system disciplines itself.

---

## Before you enable autopilot: shadow mode

Most teams don't flip `MERGEN_AUTOPILOT=true` on day one. Shadow mode lets you build the track record first.

```bash
MERGEN_SHADOW_MODE=true \
MERGEN_SLACK_BOT_TOKEN=xoxb-... \
MERGEN_SLACK_CHANNEL=#incidents \
mergen-server start
```

For 30 days, Mergen runs the full diagnosis pipeline on every PagerDuty trigger and posts to your Slack thread what it **would have done** — without executing anything.

```
[03:17] PagerDuty → incident.triggered: "api-service HIGH error rate"

[03:17] Mergen → #incidents (thread):
  👁️ Shadow mode — would execute:
     npm install jsonwebtoken@9.0.0 && pm2 restart api
     Diagnosis: 91% confidence | Remediation: 88% confidence
     Awaiting manual action.
```

After 30 days, pull the impact report:

```bash
# Shareable HTML one-pager — open in browser or save as PDF
curl http://127.0.0.1:3000/impact-report?format=html > report.html

# JSON for your own tooling
curl http://127.0.0.1:3000/impact-report
```

You get: N incidents processed, X% Mergen would have resolved correctly, average autonomous MTTR vs. actual manual MTTR. That's the number your CISO needs before approving autonomous execution.

**Annotate shadow entries** to build the track record faster:

```bash
# After reviewing a shadow recommendation:
curl -X POST http://127.0.0.1:3000/shadow-report/<id>/verdict \
  -H 'Content-Type: application/json' \
  -d '{"verdict": "would-approve"}'

# Or if you would have done something different:
curl -X POST http://127.0.0.1:3000/shadow-report/<id>/verdict \
  -H 'Content-Type: application/json' \
  -d '{
    "verdict": "would-override",
    "overrideReason": "batch-window",
    "note": "Friday 20-24 UTC — settlement run makes pool resize unsafe",
    "manualAction": "kubectl rollout restart deployment/api"
  }'
```

`would-override` annotations automatically build the **override corpus** — Mergen learns your team's operational patterns and will pause before taking that action again in the same context.

---

## Enabling autopilot

Once you've seen 30 days of shadow recommendations and the approval rate is above 80%:

```bash
# Start with the safest tier — service restarts only
MERGEN_AUTOPILOT=true \
MERGEN_AUTOPILOT_LEVEL=restarts \
MERGEN_SLACK_BOT_TOKEN=xoxb-... \
MERGEN_SLACK_CHANNEL=#incidents \
mergen-server start
```

`MERGEN_AUTOPILOT_LEVEL` controls which command risk tier executes autonomously:

| Level | What executes |
|-------|--------------|
| `restarts` | Service restarts and reloads (`pm2 restart`, `kubectl rollout restart`, `systemctl restart`) |
| `deploys` | Restarts + rollbacks, dependency pins, image updates |
| `full` | All commands that pass the safety blocklist (default) |

Start with `restarts`, watch for 2–4 weeks, then promote to `deploys`, then `full`. Commands outside the permitted tier surface in the Slack thread as paused with an explanation.

---

## What an autonomous resolution looks like

```
[03:17] PagerDuty → incident.triggered: "api-service HIGH error rate"

[03:17] Mergen → #incidents:
  🚨 Production Incident — api-service
  Fired just now  |  PagerDuty

  ✅ Causal Attribution — 91% [HIGH]
  Deploy a3f8c12 • production
  • Deploy 4 minutes before error spike
  • auth/middleware.ts in changed files

[03:17] Mergen → #incidents (thread):
  🔍 Root Cause Analysis
  Hypothesis: JWT validation middleware rejecting valid tokens after dependency upgrade
  Confidence: HIGH (91%) | Remediation: 88%
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

## The override corpus

Every time your team decides not to apply Mergen's recommendation, record why:

```bash
curl -X POST http://127.0.0.1:3000/overrides \
  -H 'Content-Type: application/json' \
  -d '{
    "incidentTag": "infra_db_connection_pool",
    "proposedCommand": "kubectl set env deployment/api DB_POOL_MAX=50",
    "overrideReason": "batch-window",
    "note": "Friday 20-24 UTC — settlement run, pool resize unsafe during this window",
    "service": "api",
    "environment": "production",
    "manualAction": "kubectl rollout restart deployment/api"
  }'
```

Valid override reasons: `batch-window` · `cost-constraint` · `on-call-discretion` · `compliance-hold` · `prefer-read-replica` · `maintenance-window` · `wrong-diagnosis` · `wrong-fix` · `other`

After recording enough overrides, Mergen will pause before taking that action again in the same time window — and tell you why in the Slack thread:

```
⚠️ Autopilot paused — this action has been overridden before for `api`
   (reason: batch-window). Awaiting manual confirmation.
```

See what the corpus has learned: `GET /override-corpus`

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
# Full report as shareable HTML — open in browser, save as PDF
open http://127.0.0.1:3000/impact-report?format=html

# JSON (custom window: ?days=7, ?days=90)
curl http://127.0.0.1:3000/impact-report

# Shadow mode track record
curl http://127.0.0.1:3000/shadow-report

# Weekly Slack digest (Slack block format)
curl http://127.0.0.1:3000/shadow-report/slack-digest
```

The impact report shows: incidents processed, autonomous resolution rate, MTTR autonomous vs. manual, per-failure-mode breakdown, and the side-by-side comparison table of what Mergen would have done vs. what your on-call engineer actually did.

---

## Security

**Local by default.** Ingest binds to `127.0.0.1`. Nothing leaves your infrastructure without explicit opt-in.

- **PII shield** — always-on: email, phone, AWS access keys, PEM private keys, JWTs, credit card numbers. Configurable via `~/.mergen/pii-config.json`.
- **Execution safety** — 15-pattern blocklist (no `rm -rf`, no `curl | bash`, no `DROP TABLE`, no force push). 60-second timeout. Every execution audit-logged to `~/.mergen/audit.log`.
- **Confidence gate** — autonomous execution only at ≥85% remediation confidence. Diagnosis and remediation confidence are tracked separately.
- **Override corpus gate** — autopilot consults your team's override history before executing. Recurring overrides are learned automatically.
- **RBAC** — role-based access control for fix execution. Observers can view; only responders can execute.
- **Cloud mode** — TLS + SHA-256 hashed API keys + sliding-window rate limiting + per-tenant event isolation.

**Anonymous calibration (opt-in).** By default, zero data leaves your infrastructure. Set `MERGEN_TELEMETRY=1` to contribute anonymous accuracy signals — detector tag and verdict only, never incident content, service names, commands, or stack traces. You can audit exactly what would be sent: `GET /calibration/export`.

```bash
# Optional shared secret (local mode)
MERGEN_SECRET=mysecret mergen-server start

# Cloud mode (multi-tenant)
MERGEN_CLOUD_MODE=true \
MERGEN_TLS_CERT=/path/cert.pem \
MERGEN_TLS_KEY=/path/key.pem \
mergen-server start
```

---

## Environment variables

```bash
# Core
MERGEN_AUTOPILOT=true              # enable autonomous fix execution
MERGEN_SHADOW_MODE=true            # analyze + report, never execute — can be a permanent mode
MERGEN_AUTOPILOT_LEVEL=restarts    # restarts | deploys | full (default: full)
MERGEN_SLACK_BOT_TOKEN=xoxb-...    # Slack Web API token
MERGEN_SLACK_CHANNEL=#incidents    # default incident channel
MERGEN_SLACK_DIGEST_CHANNEL=#incidents  # weekly shadow digest channel (default: MERGEN_SLACK_CHANNEL)

# Datadog (for trace context + validation)
DD_API_KEY=...
DD_APP_KEY=...
DATADOG_SITE=datadoghq.com

# Anonymous calibration (opt-in)
MERGEN_TELEMETRY=1                 # enable anonymous accuracy signal export (to corpus.mergen.dev)
MERGEN_TELEMETRY_URL=https://...   # override default aggregation server (self-hosted)

# Cloud mode
MERGEN_CLOUD_MODE=true
MERGEN_TLS_CERT=/path/to/cert.pem
MERGEN_TLS_KEY=/path/to/key.pem
```

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

# Run the demo
mergen-server demo

# Pull the impact report
open http://127.0.0.1:3000/impact-report?format=html
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

**Mergen — the ops agent layer that acts while you sleep.**

</div>

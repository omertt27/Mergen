# Mergen

Claude Code doesn't know what happened in production. Mergen does.

It's an MCP server for your AI IDE. Once connected, ask *"what caused the 3am incident"* and get a causal chain from live telemetry — not a log dump, an actual hypothesis with evidence and a fix command. At ≥85% confidence it executes the fix, validates the result, and posts the audit trail to your Slack thread.

```bash
claude mcp add mergen --transport stdio -- mergen-server start
```

Then ask: *"Triage the api-service."*

[![npm](https://img.shields.io/npm/v/mergen-server)](https://www.npmjs.com/package/mergen-server)
[![License](https://img.shields.io/badge/license-MIT%20%2B%20Proprietary-blue)](./LICENSE)
[![MCP](https://img.shields.io/badge/MCP-stdio-black)](https://modelcontextprotocol.io)
[![Privacy](https://img.shields.io/badge/data-your%20infra%20only-success)](#security)

[**Quick Start →**](#quick-start) · [**Shadow Mode →**](#the-safety-layer) · [**How it works →**](#how-it-works) · [**MCP tools →**](#mcp-tools-ai-ide-integration)

---

## Who it's for

Engineering teams where the on-call rotation is developers who also ship features — no dedicated SRE, no internal ops automation platform. If you're a 20-person startup where the CTO is on the pager, this is for you.

Claude Code users specifically: you already have the AI IDE. Mergen is the piece that makes it aware of production. It doesn't compete with Claude Code — it gives Claude Code the tools to act on incidents the same way it acts on code.

---

## The gap it closes

Claude Code is exceptional at writing, reviewing, and shipping code. It has no visibility into what broke in production, what the error rate looked like before and after a deploy, or what the on-call engineer did at 3am last Tuesday.

Mergen connects your AI IDE to that context: PagerDuty alerts, OpenTelemetry traces, Docker logs, Datadog spans. When an incident fires, Claude Code can call `triage_incident` and get a structured causal chain instead of asking you to paste logs into the chat.

---

## How it differs from Datadog / PagerDuty / existing tools

Datadog and PagerDuty tell you what's broken. They page a human. The human fixes it.

Mergen sits above that stack. When PagerDuty fires, Mergen pulls the correlated telemetry, runs causal analysis, and either executes the fix (autopilot mode) or hands Claude Code a structured brief with evidence and a specific command to run. It doesn't replace your observability tools — it acts on what they tell it.

The meaningful difference over time is memory. Every incident Mergen sees is stored as a replayable telemetry snapshot. Your team's override decisions build a corpus of operational context that a generic vendor starting from zero can't replicate. After enough incidents: your Friday settlement windows, your compliance holds, the fixes your on-call always reaches for — structured and queryable, not locked in someone's head or a Notion doc.

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

## The safety layer

No autonomous system earns trust on day one. Mergen is designed so you can verify it before you rely on it — and so every failure mode has a defined, non-destructive outcome.

**Start in shadow mode**

Run shadow mode for 30 days before enabling autopilot. Mergen runs the full diagnosis pipeline on every PagerDuty trigger, posts what it _would have done_ to your Slack thread, and never executes anything. Pull the track record at any time:

```bash
open http://127.0.0.1:3000/impact-report?format=html
```

You get: N incidents analyzed, X% Mergen would have resolved correctly, average proposed MTTR vs. actual, and a side-by-side table of Mergen's recommendation vs. what your engineer did. That is the number your CISO needs before approving autonomous execution.

**Confidence gate — nothing runs below 85%**

When diagnosis or remediation confidence is below the threshold, Mergen posts the root cause analysis and fix hint to Slack, returns the same to your AI IDE, and waits. Your engineer acts on a structured brief instead of a raw alert. The threshold self-calibrates via ROC analysis as your incident history grows.

**Wrong fix — automatic rollback**

If Mergen executes a fix and errors increase, `validate_fix` returns `REGRESSED`. Mergen immediately derives and runs the inverse command (`kubectl rollout undo`, `helm rollback`, package version revert) and posts the result to the thread. If auto-rollback isn't possible, it surfaces the manual revert command and waits.

**Safety blocklist — unconditional**

15 command patterns are blocked regardless of confidence: `rm -rf`, `curl | bash`, `DROP TABLE`, `git push --force`, and others. A blocked command is never run. Mergen posts it to Slack for manual review. All blocked attempts are in `~/.mergen/audit.log`.

**Override corpus — learns your team's constraints**

If your team has previously overridden a fix for this service in this time window, Mergen pauses and posts why. It does not re-run an action that was judged unsafe in the same context. The corpus is explicit — you can inspect it at `GET /override-corpus`.

**Audit trail**

Every action taken or skipped is written to `~/.mergen/audit.log` as JSONL: timestamp, actor, command, verdict, reason.

```bash
cat ~/.mergen/audit.log | python3 -m json.tool
```

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

**Mergen — production memory for Claude Code.**

</div>

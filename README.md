# Mergen

> **AI makes writing code cheap. Understanding what it does in production is still expensive. Mergen closes that gap.**

Code generation is now instantaneous. The bottleneck has shifted: engineering teams no longer struggle to write code — they struggle to understand what AI-generated code does in production before it breaks something. Every sprint that adds velocity on the write side creates compounding uncertainty on the change side.

When an engineer or AI agent wants to modify a system, Mergen surfaces the hidden constraints, historical decisions, and operational context needed to make that change safely.

**Mergen is the real-time system understanding layer for high-change software environments.** It compresses raw production telemetry into a structured causal chain, encodes your team's override decisions as enforceable policy, and gives your AI IDE the operational facts it needs to act safely — without asking you to paste logs into a chat. At ≥85% confidence it executes the fix, validates the result, and posts the audit trail to your Slack thread.

Works with **Claude Code**, **Cursor**, **Windsurf**, and **VS Code** — any IDE that supports MCP.

```bash
# Claude Code
claude mcp add mergen --transport stdio -- mergen-server start

# Cursor / Windsurf / VS Code
mergen-server setup   # writes the config file for your IDE automatically
```

Then ask: *"Triage the api-service."*

[![npm](https://img.shields.io/npm/v/mergen-server)](https://www.npmjs.com/package/mergen-server)
[![License](https://img.shields.io/badge/license-MIT%20%2B%20ELv2-blue)](./LICENSE)
[![MCP](https://img.shields.io/badge/MCP-stdio-black)](https://modelcontextprotocol.io)
[![Privacy](https://img.shields.io/badge/data-your%20infra%20only-success)](#security)

[**Quick Start →**](#quick-start) · [**Shadow Mode →**](#the-safety-layer) · [**How it works →**](#how-it-works) · [**MCP tools →**](#mcp-tools-ai-ide-integration)

---

## Who it's for

**Solo developers and early-stage startups** — No Datadog required. No OTLP setup. Point Mergen at your Docker containers or drop one import into your Node.js entry point, and your AI IDE immediately has live context from your production logs. When Claude Code or Cursor asks "what's broken?", it gets a real answer instead of asking you to paste logs into a chat. The local verdict corpus builds automatically — the longer you run, the more Mergen knows about your specific system.

**The human developer drowning in microservice complexity** — You're not tired of writing code; you're tired of debugging the code AI wrote for you. Mergen is your Automated Triage Engine. When an incident fires at 2am, you don't dig through raw Datadog traces or paste logs into a chat window. Mergen compresses 500KB of telemetry noise into a 1KB runtime fact: the exact service, the exact failure signature, and the exact fix command.

**The VP of Engineering managing autonomous agents** — Your coding agents clear Jira backlogs fast and generate bugs faster. They have no institutional memory. Mergen is the mandatory guardrail: before an agent executes a change, it queries Mergen's Local Verdict Corpus to check previous failure signatures and system invariants. If the agent tries to ship something that mirrors a past production outage, Mergen blocks it. You are buying insurance against the **Agent Outage Tax**.

**Startups without a dedicated SRE** — Your on-call rotation is developers who also ship features. Mergen removes the 3am manual triage entirely.

**Compliance-heavy orgs** — Every autonomous action and every blocked command is written to `~/.mergen/audit.log` as immutable JSONL. The Agent Blunder Log shows every time Mergen blocked itself. Shadow mode gives your CISO a 30-day PDF of exactly what Mergen would have done autonomously — and how often it would have been right — before you flip `MERGEN_AUTOPILOT=true`.

---

## The bottleneck shift

AI IDEs write, review, and ship code well. They have no visibility into what broke in production, what the error rate looked like before and after a deploy, or what the on-call engineer did at 3am last Tuesday.

This is not a logging problem. Datadog has the logs. PagerDuty has the alerts. The gap is *system understanding* — knowing why a system behaves the way it does before you change it. That understanding used to live in engineers' heads. As AI increases the volume and velocity of changes, the cost of not having it becomes critical.

Mergen is the infrastructure that makes that understanding machine-readable. It connects your AI IDE to live telemetry (PagerDuty alerts, OpenTelemetry traces, Docker logs, Datadog spans) and builds a queryable corpus of how your system actually behaves and how your team handles production. When an incident fires, your IDE calls `triage_incident` and gets a structured causal chain, not a log dump.

---

## How it differs from Datadog / PagerDuty / existing tools

Datadog and PagerDuty tell you what's broken. They page a human. The human fixes it.

Mergen acts on what they tell it. When PagerDuty fires, Mergen pulls the correlated telemetry, runs causal analysis, consults your team's override history, and either executes the fix or hands your AI IDE a structured brief with evidence and a specific command. It does not replace your observability tools — it is the execution and memory layer above them.

**The moat is what accumulates.** Every incident Mergen sees is stored as a replayable snapshot. Every override your team records becomes policy — Mergen will pause before repeating that action in the same context. After six months of production: your Friday settlement windows, your compliance holds, the fixes your on-call always reaches for — structured, queryable, and impossible to replicate from a standing start. The diagnosis algorithm is reproducible. The accumulated operational memory of your infrastructure is not.

---

## Why this gets more valuable as AI coding accelerates

Every other startup is building the accelerator pedal — tools to make AI write code faster. Mergen is building the brakes, the steering wheel, and the black-box flight recorder.

The core bet: as code generation becomes nearly free, understanding software systems becomes the bottleneck. Three structural pressures are compounding in parallel:

**Velocity trap — spaghetti automation at scale.** AI agents produce syntactically perfect code that ignores systemic architecture constraints. The result is high-velocity technical debt shipped at machine speed. When code generation is free and instantaneous, understanding what a system actually does in production becomes the scarcest resource in an engineering org. Mergen compresses that uncertainty into structured context before it tanks the infrastructure.

**Loss of system context at the moment of change.** When a human spent three days writing a complex routing loop, the context lived in their head — edge cases, database quirks, the *why* behind the choices. When an AI agent generates the same block in four seconds, nobody knows why it exists. The moment it hits production, it becomes instant, unmaintainable legacy. Mergen recaptures that context: every incident, every override, every causal chain is stored as a replayable snapshot. Future engineers and future agents query Mergen before touching that code — not documentation that was already stale when it was written.

**Exponential surge in distributed incidents.** Autonomous agents shipping code at machine speed introduce distributed systems failures that only manifest under production load — connection pool exhaustion, timeout cascades, silent microservice regressions that escape all static tests. The Agent Blunder Log and override corpus act as the governance checkpoint: when an autonomous coding loop tries to ship something that mirrors a historical outage signature, Mergen detects the pattern drift, halts the execution path, and records why.

The macro thesis: Mergen scales directly in proportion to the change pressure AI puts on software systems. The faster the industry accelerates, the more necessary the system understanding layer becomes.

---

## Why this is defensible: two primitives that compound with use

### The Override Corpus — operational DNA that enforces itself

Every time your team overrides Mergen's recommendation, that decision is encoded as policy. Shadow mode annotations build it automatically:

```bash
# After reviewing a shadow recommendation your team would have handled differently:
curl -X POST http://127.0.0.1:3000/shadow-report/<id>/verdict \
  -H 'Content-Type: application/json' \
  -d '{
    "verdict": "would-override",
    "overrideReason": "batch-window",
    "note": "Friday 20-24 UTC — settlement run makes pool resize unsafe",
    "manualAction": "kubectl rollout restart deployment/api"
  }'
```

Mergen consults the corpus before every autonomous action. After enough production cycles, it knows your Friday settlement windows, your compliance holds, your on-call's preferred fixes — structured, queryable, and impossible to reconstruct from documentation alone. A generic vendor entering this space builds a general model. You build the operational DNA of your specific infrastructure.

### The Agent Blunder Log — proof that autonomous agents need guardrails

Every time Mergen's safety layer blocks an autonomous action, the event is recorded:

```bash
curl http://127.0.0.1:3000/agent-blunders
# {"prevented": 23, "byType": {"allowlist_block": 14, "override_corpus_block": 7, "rbac_block": 2}, "last7Days": 4}
```

`prevented: 23` means your on-call did not handle 23 potentially unsafe autonomous actions. It is also the answer to "why would you trust an AI agent with prod?" — the system blocked itself, logged why, and waited. The Blunder Log compounds the same way the Override Corpus does: the more incidents Mergen sees, the richer the audit trail, and the more precisely the safety layer distinguishes safe from unsafe in your specific environment.

**These two primitives are the long-term moat.** The diagnosis algorithm is reproducible. The accumulated operational memory of your infrastructure is not.

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

→ **[QUICKSTART.md](QUICKSTART.md)** — get running in 2 minutes

```bash
# One command does everything: checks Node, detects IDE, writes MCP config
npx mergen-server@latest setup

# Non-interactive (CI / scripts):
npx mergen-server@latest setup --yes --ide cursor

# Then start:
mergen-server start
```

After setup, check integration status anytime:
```bash
mergen-server doctor
```

**In PagerDuty:** Services → Integrations → Webhooks → `https://your-server:3000/webhooks/pagerduty`

**In your AI IDE:** *"Triage the latest incident"* — Mergen calls `triage_incident` automatically.

---

## Honest note on confidence numbers

When you first install Mergen, confidence scores like "91%" are **initial engineering estimates** — not measured from your production incidents. They reflect our judgment of how reliable each detector is across common failure modes.

**Day 0 state:** Platt scaling (the statistical layer that converts raw scores into calibrated probabilities) is dormant until your local verdict corpus has at least 10 confirmed outcomes for a given detector. Until then, the score shown is the raw prior — honest, but uncalibrated. The Slack thread and MCP output always label this: `estimated — self-calibrates with use` vs `calibrated — N verdicts`, so you always know which you're looking at.

After you record verdicts on your own incidents (via `/feedback` or the shadow mode annotation API), those numbers become **empirically calibrated to your system**. Per-detector calibration activates at 10 verdicts; a global model activates across all detectors once 10 total verdicts exist.

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

**Agent Blunder Log — every interception is recorded**

Every blocked action is appended to the log and queryable at `GET /agent-blunders`. Block types: `allowlist_block` · `rbac_block` · `override_corpus_block` · `injection_attempt` · `planning_gate_block`. See [Why this is defensible](#why-this-is-defensible-two-primitives-that-compound-with-use) for the full breakdown of what this compounds into over time.

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

**Three additional validation metrics for board-deck level evidence:**

**Agent Blunder Log** — safety interceptions by type. The headline number is `prevented`: every time Mergen blocked itself before an unsafe autonomous action. Grows as you run in autopilot mode; zero on day one.
```bash
curl http://127.0.0.1:3000/agent-blunders
```

**Organic Habituation** — weekly rate of engineers who received a Mergen PR comment and subsequently engaged (submitted a review) that week, without being asked. A rising habituationRate means Mergen is becoming part of the review workflow.
```bash
curl http://127.0.0.1:3000/habituation
# {"habituationRate": 0.71, "weekly": [{"week": "2026-W23", "engagementRate": 0.75, ...}]}
```

**Context-Assisted MTTR** — among manually resolved incidents, those where the engineer first read Mergen's diagnosis brief (`GET /trust-score/:pid`) resolved faster than those who did not. This isolates Mergen's value even when autopilot is off. Reported automatically in `GET /impact-report` once enough data exists.

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

## Open-source scope

The causal analysis engine in this repository (the Hypothesis Engine) is a **functional open-source implementation** that detects the most common failure patterns: auth token not persisted, silent slow requests, and empty 200 responses. It is the same engine used by the default tier.

The commercial layer adds a broader detector library, multi-signal correlation across traces + spans + K8s events, and proprietary Platt-scaling models trained on aggregate incident data. These are not in this repository.

Everything else — the MCP server, override corpus, agent blunder log, Slack threading, MTTR tracking, habituation metrics, and the safety execution layer — is fully implemented in this repo with no stubs.

---

## Self-host vs. cloud

Mergen runs entirely on your infrastructure. Your telemetry never leaves. For teams that want hosted Mergen (multi-tenant, managed updates, compliance exports), reach out: **hello@mergen.dev**

---

## Governance

Mergen is **public-source, closed-governance** infrastructure.

The source code is public so that enterprise security teams and CISOs can audit our PII shield, command allowlist, and autonomous execution model before deploying inside their production VPCs. **We do not accept external pull requests.**

This is a deliberate supply-chain security decision: Mergen executes autonomous remediation commands inside your infrastructure. Every line of server code is reviewed and signed by the core team to guarantee the integrity of the confidence calibration and command execution logic.

| Want to... | Do this |
|---|---|
| Report a bug | [Open an Issue](https://github.com/omertt27/Mergen/issues) |
| Suggest a feature | [Start a Discussion](https://github.com/omertt27/Mergen/discussions) |
| Improve the Hypothesis Engine | Rate hypotheses 👍/👎 in the VS Code panel — this directly updates the calibration corpus |
| Enterprise / custom integration | [mergen.dev/pricing](https://mergen.dev/pricing) |

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full governance model.

---


<div align="center">

**Mergen — system understanding infrastructure for high-change software environments.**

</div>

# Mergen

> **AI agents don't know how your systems actually work.**
> **Mergen gives AI agents and engineers the operational context, historical decisions, and infrastructure memory needed to make safer changes. Every incident, override, and postmortem compounds into queryable policy — specific to your systems, impossible to replicate from a standing start.**

---

### See it in 60 seconds 🚀

```bash
npx mergen-server
```

* **✓ Knowledge compounds** with every incident
* **✓ Override corpus**: your infrastructure DNA
* **✓ Pre-commit incident guard**
* **✓ Platt-calibrated** per-environment confidence
* **✓ Agent safety CI gate**
* **✓ All data on your infrastructure**

#### Key Metrics
* 🎯 **94%** Root cause accuracy (33-incident eval corpus)
* 🚀 **31 / 33** Correct classifications (2 known false positives)
* ⏱️ **< 60s** Time to first insight (zero config required)
* 🚦 **≥85%** Calibrated Gate (Platt-scaled safety threshold)

---

### mergen — autonomous incident loop

```text
⏸ Pause  ↺ Restart  1x Speed

[03:17] PagerDuty → incident.triggered: "api-service HIGH error rate"
Fetching trace context...
Running causal analysis across 847 telemetry events...
Consulting override corpus for api-service...
✓ No matching override pattern — proceeding
Root cause: JWT middleware rejecting valid tokens (91% confidence)
Deploy a3f8c12 · auth/middleware.ts in changed files · 4m before spike
Autopilot executing fix (remediation confidence: 88%)
npm install jsonwebtoken@9.0.0 && pm2 restart api
Validating... error count: 14 → 0
✅ RESOLVED — MTTR: 5m 23s · resolvedAutonomously=true
Agent Blunder Log: 0 blocks this incident
Posting audit trail to #incidents thread...
```
*Watch: 60s Quick Start*

---

## 01 // The Difference

### Scenario A — Solo developer, no code reviewer

| Without Mergen | With Mergen |
| :--- | :--- |
| **0m · Write the change**<br>Touch the same file that caused last month's outage. | **0m · Stage the change**<br>`git add auth_middleware.ts` |
| **0m · Run tests**<br>Tests pass. No reviewer. Ship it. | **0s · Guard runs**<br>Cross-references staged files against incident history. |
| **4h · Production alert fires**<br>Same failure mode. No one warned you. | **1s · Warning surfaced**<br>"This file was in Incident #388 — do not increase stack depth > 4." |
| **4h+ · Reconstruct context**<br>Grep logs. Trace the history. Piece it together under pressure. | **2m · Fix before shipping**<br>Adjust the change. The outage never happens. |
| **❌ Result**: The bug ships. | **✅ Result**: The bug never ships. Incident history is your reviewer — working silently at commit time. |

### Scenario B — Team, production incident at 3am

| Without Mergen | With Mergen |
| :--- | :--- |
| **0m · PagerDuty fires**<br>Engineer wakes up. Opens laptop. | **0m · PagerDuty fires**<br>Mergen receives the webhook. |
| **5m · Check logs**<br>Grep through millions of lines across services. | **2s · Analyze telemetry**<br>Correlates logs, traces, and infra signals. |
| **15m · Check dashboards**<br>Correlate metrics across 5 different tabs. | **5s · Check operational memory**<br>Matches against past incidents and human overrides. |
| **30m · Ask Slack**<br>"Who deployed last?" "Is the DB down?" | **10s · Generate validated fix**<br>Produces a remediation plan at ≥85% confidence. |
| **45m · Guess root cause**<br>Apply a fix based on intuition. Hope it works. | **1m · Resolve or recommend**<br>Executes (autopilot) or posts fix for approval. |
| **60m+ · Watch and wait**<br>Monitor dashboards for another 15 min to confirm. | **2m · Audit trail posted**<br>Full root cause + actions logged to Slack. |
| **❌ Result**: 3am fire drill. | **✅ Result**: The engineer wakes up to a resolved incident and a full audit trail — not a 3am fire drill. Every action is logged and reversible. |

### Scenario C — Postmortem that compounds into policy

| Without Mergen | With Mergen |
| :--- | :--- |
| **0m · Incident resolved**<br>Engineer writes a postmortem in Notion. Team reads it once. | **0m · Incident resolved**<br>Mergen records the override: "skip pool resize — Friday batch window." |
| **2wk · Postmortem is stale**<br>Nobody updates it. The constraint lives in one person's head. | **1s · Policy encoded**<br>Override corpus entry created. Applies to all future incidents of this type. |
| **3mo · Engineer leaves**<br>The constraint — "never resize pool on Friday" — is gone. | **3mo · Engineer leaves**<br>The constraint stays — in the corpus, queryable, enforceable. |
| **3mo · Same incident**<br>New on-call rebuilds the understanding from scratch. | **3mo · Similar incident fires**<br>Mergen surfaces: "This pattern was overridden 6× — reason: batch-window." Autopilot pauses. |
| **❌ Result**: Knowledge evaporates. | **✅ Result**: The knowledge compounds. Every incident makes the next one faster to resolve — for any engineer, any agent, forever. |

---

## 03 // How It Works

### Four steps from alert to resolution

* **STEP 1: Connect your production stack**
  Ingest signals from PagerDuty, OpenTelemetry, Docker, Kubernetes, and optionally Datadog. No agent required.
* **STEP 2: Detect and understand incidents**
  When an alert fires, Mergen correlates telemetry across services, identifies the likely root cause, and matches it against past incidents and overrides.
* **STEP 3: Apply operational memory**
  Mergen checks what your team did last time — past fixes, human overrides, known failure patterns — before generating a validated remediation plan.
* **STEP 4: Resolve or recommend**
  Shadow mode: suggestion only. Assisted: recommended fix + approval. Autopilot: safe execution within constraints. Every action is logged and reversible.

```text
PAGERDUTY             OPENTELEMETRY           DOCKER               DATADOG
Incident Alerts       Traces + Metrics        Container Logs       APM Spans
Webhooks              OTLP HTTP               stdout/stderr        Optional
   │                     │                       │                    │
   └─────────────────────┼──────────┬────────────┘                    │
                         ▼          ▼                                 ▼
                    ┌──────────────────────────────────────────────────┐
                    │               MEMORY LAYER                       │
                    │                  Mergen                          │
                    │       Operational Memory Layer                   │
                    │   ──────────────────────────────────             │
                    │   - Incident history                             │
                    │   - Override corpus                              │
                    │   - Root cause engine                            │
                    │   - Agent Blunder Log                            │
                    │   - PII Shield                                   │
                    └───────────────────────┬──────────────────────────┘
                                            │
         ┌──────────────────────────────────┼──────────────────────────┐
         ▼                                  ▼                          ▼
     AI IDEs                              COMMS                   COMPLIANCE
   Claude Code (triage_incident)        Slack                     Audit Log
   Cursor      (analyze_runtime)        (Owns the thread)         (Reversible JSONL)
```

---

## 05 // Evaluation

### Evaluated before you ever use it

We built a regression eval harness before shipping v1. Every PR that touches detection logic must pass this suite — 33 real incident scenarios, 10 infrastructure failure classes. When we say 94% accuracy, that number is reproducible and falsifiable.

* **Overall accuracy**: `94%` (31 of 33 incidents classified correctly)
* **Corpus size**: 33 incidents (31 correct, 2 false positives due to probe/scrape errors)
* **Last eval run**: Jun 16, 2026

| Failure Class | Fixtures | Accuracy |
| :--- | :--- | :--- |
| DB Connection Pool | 5/5 | 100% |
| OOM Kill | 5/5 | 100% |
| Rate Limit Cascade | 3/3 | 100% |
| Certificate Expiry | 3/3 | 100% |
| Disk Pressure | 3/3 | 100% |
| Service Unavailable | 3/3 | 100% |
| Slow Query | 2/2 | 100% |
| Downstream Latency | 3/3 | 100% |
| Queue Backlog | 3/3 | 100% |
| Upstream Error | 1/1 | 100% |
| False positive (probe/scrape errors) | 0/2 | 0% |

> [!NOTE]
> **Why this matters**: Most observability tools are evaluated by the engineers who built them, on the incidents they chose. Mergen ships a public eval harness — the same suite that gates every release. The 2 failures are documented: the detector fires on liveness probe and Prometheus scrape errors when it shouldn't. Fix is in the roadmap; hiding it is not.
>
> [View Full JSON Baseline →](file:///Users/omer/Desktop/Mergen/server/src/__tests__/eval-baseline.json)

---

## 02 // The Problem

### Teams ship code faster. Operational knowledge still evaporates.

Every incident teaches your team something. The diagnosis, the override, the constraint that mattered — evaporates into heads, stale runbooks, Slack threads nobody reads under pressure. AI agents make this worse: they generate changes with no institutional memory at all.

1. **Knowledge evaporates after every incident**
   *Wikis rot. Slack threads become noise. People leave.*
   When the incident is over, the hard-won understanding — why it happened, what constraint matters, what not to do next time — evaporates into heads, stale runbooks, and Slack threads nobody reads under pressure. Every repeat incident is a failure of memory, not engineering.

2. **AI velocity without memory is sabotage**
   *Agents generate code. They have no institutional knowledge.*
   AI coding agents clear backlogs fast and introduce production failures faster. They have no context about your Friday settlement window, your compliance hold, or the connection pool that exhausted twice last quarter. Without an operational memory layer, every agent change is a blind change.

3. **Observability tells you what broke — not what to do**
   *Datadog has the logs. The understanding still lives in one engineer.*
   PagerDuty pages a human. Datadog shows the trace. The human reconstructs the context — from memory, from a Slack thread, from the last person who touched that service. When they leave, the knowledge leaves. Mergen is the layer that keeps it.

4. **Solo devs have no reviewer**
   *Nothing between "I wrote this" and "it's in production"*
   A team has code review as a safety net — someone else reads the change before it merges. A solo dev has nothing. Mergen's guard cross-references every commit against your incident history, asking the question your missing teammate would: *"didn't this file cause the outage last month?"* Not a lint check. Encoded institutional memory at commit time.

> [!TIP]
> **The missing layer is not more observability.** It is operational intelligence — converting every incident, override, and postmortem into compounding machine-readable policy that engineers and AI agents can query before they act.

---

## 04 // Core Systems

### Knowledge that compounds. Safety that enforces it.

* **🧬 01 · Override Corpus — Infrastructure DNA**
  Every human override becomes machine-readable policy. After six months: your Friday settlement windows, compliance holds, and on-call preferences form your specific operational DNA — enforcing invariants before any autonomous action triggers. The algorithm is reproducible. This corpus is not.

* **⚙️ 02 · Per-Environment Calibration**
  Mergen uses Platt scaling calibrated to your specific infrastructure — not a global benchmark. As your team tags diagnoses (correct / partial / wrong), the confidence model updates. After 20–50 incidents, accuracy numbers reflect your systems, not ours.
  
  ```text
  MRG Mergen APP 3:17 PM
  ✅ Incident #402 resolved autonomously
  Audit Trail Summary
  • Root Cause: DB Connection Pool exhaustion (api-service)
  • Confidence: 91% (matches pattern: stuck_idle_connections)
  • Action: Flushed idle pools & increased capacity (max_idle: 5 → 20)
  • Validation: Error rate 14% → 0.02% (confirmed 3:18 PM)
  ```

* **🛡️ 03 · Agent Blunder Log — CISO Insurance**
  Every blocked autonomous action is recorded: allowlist blocks, corpus halts, planning gates, semantic blocks. The total prevented count is the board-deck answer to "why would you trust an AI agent with production?" Wired automatically — no setup required.

* **🚦 04 · Semantic Safety Gates**
  Before any autonomous execution, Mergen red-teams the proposed command using a local semantic safety engine: action risk, blast radius, and corpus-policy check — not regex allowlists.
  
  ```typescript
  // auth_middleware.ts — Mergen Context / mcp.json
  // Mergen: Historical Context found ⚠️
  // This file was modified in Incident #388 (OOM Kill).
  // Reason: Recursive token validation on nested JWTs.
  // Constraint: Do not increase stack depth > 4.
  export const validateToken = (token: string) => {
    // checking depth...
  ```

* **📊 05 · Measurable MTTR — Board-Ready ROI**
  The impact report isolates Mergen's context-assisted value: autonomous vs. manual MTTR, resolution rate, and time saved. "We saved 47 engineer-hours last month" is a sentence. The report generates it automatically.

* **👤 06 · Shadow Mode — 30-Day Trust Track Record**
  Before autonomous execution, Mergen runs in shadow mode: diagnoses every incident, records what it would have done, and lets your team annotate verdicts. The shadow report is your CISO's 30-day evidence package before you flip the autopilot switch.

* **🚨 07 · Pre-commit Incident Guard**
  Before you ship, Mergen cross-references every staged file against your incident history. *"This file was in 3 incidents last month"* — the question a code reviewer would ask, encoded as a git hook. The corpus working before the incident happens.

* **👁️ 08 · Passive Status Surface**
  Mergen tracks what happened while you weren't looking. Next time you check: *"this started failing 6 hours ago."* Not a push notification — context waiting when you return. The on-call teammate who works in silence.

---

## 04 // Interactive Sandbox

### Test the detector logic

* **Select Scenario:**
  * DB Connection Leak
  * OOM Kill
  * Rate Limit Cascade
* **Adjust Telemetry Inputs:**
  * Idle Connections: `85%` (Critical)
  * Error Rate Spike: `14.2%` (High)
* **Run Detector →**
  * Telemetry context pack: `pg_stat_activity count=85/100, wait_event=ClientRead`
  * Causal Rule Match: `✓ MATCHED (Armed)`

*Adjust parameters on the left, then click "Run Detector" to see Mergen's diagnostic check in action.*

---

## 04 // Integrations

### Every source is a lesson. Mergen keeps the receipt.

```text
  Data Sources                                           Knowledge Corpus                   AI IDEs
┌──────────────┐                                        ┌────────────────┐                 ┌─────────────┐
│ PagerDuty    │──(Incident trigger)───────────┐        │                │                 │ Claude Code │
├──────────────┤                               │        │                │                 └──────┬──────┘
│ Datadog      │──(Traces + Logs)──────────────┼───────▶│                │──────(Context)─────────┘
├──────────────┤                               │        │                │
│ Slack        │──(Postmortem → corpus)────────┼───────▶│   Operational  │                 ┌─────────────┐
├──────────────┤                               │        │     Memory     │──────(Context)──│ Cursor      │
│ Git          │──(ADR → policy)───────────────┼───────▶│     Layer      │                 └──────┬──────┘
├──────────────┤                               │        │                │──────(Context)─────────┘
│ Kubernetes   │──(Events + Manifests)─────────┤        │                │
├──────────────┤                               │        │                │                 ┌─────────────┐
│ Prometheus   │──(Metrics)────────────────────┘        │                │                 │ Windsurf    │
├──────────────┤                                        └────────────────┘                 └──────┬──────┘
│ OpenTelemetry│──(OTLP HTTP)                                   ▲                                 │
├──────────────┤                                                │                                 ▼
│ GitHub       │──(PR safety gate)                              └─────────────(mcp.json)───── VS Code
├──────────────┤
│ AWS/GCP      │──(Config + Topology)
└──────────────┘
```

---

## 06 // Getting Started

### First insight in 60 seconds. Pilot success: 1 real incident analyzed.

#### 1. Zero Config (See it in 60 seconds)
Run one command. Mergen starts a local server, loads 50 sample incidents from public postmortems, and immediately shows you a root cause analysis. No PagerDuty, no OTLP, no IDE setup required.
```bash
npx mergen-server
```
*Opens `http://localhost:3000/demo` — click "Trigger P1 Incident" or ask a question in the chat tab.*

#### 2. Connect Your Stack (Optional)
When you're ready to switch from sample incidents to real production data, connect one source. Start with Docker logs — it requires zero configuration and works immediately.
```bash
# Docker logs (easiest — works immediately)
curl -X POST http://127.0.0.1:3000/watchers/docker

# PagerDuty → Service → Webhooks → https://your-host:3000/webhooks/pagerduty

# OTLP (any language — one env var)
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:3000 node app.js
```
*Pilot success condition: Mergen correctly analyzes 1 real incident in your environment.*

#### 3. Add to Your AI IDE
Register Mergen as an MCP server. The tools — `triage_incident`, `analyze_runtime`, `validate_fix` — appear automatically in your IDE.
```bash
# Guided setup (detects your IDE automatically)
mergen-server setup

# Or manually — Claude Code
claude mcp add mergen --transport stdio -- node "$(pwd)/server/dist/index.js"
```
*Ask: "What caused the last incident?" — Mergen answers with root cause + fix hint.*

#### 4. Build the Override Corpus
Run in shadow mode to start building your team's Override Corpus — the record of every override, constraint, and postmortem that makes Mergen specific to your infrastructure. Enable autopilot only after the corpus has established a track record.
```bash
# Start with shadow mode (builds corpus, no execution)
MERGEN_SHADOW_MODE=true mergen-server start

# Enable auto-learning from Slack postmortems
MERGEN_SLACK_OVERRIDE_LOOP=true mergen-server start
```
*Every blocked action is recorded in the Agent Blunder Log at `GET /agent-blunders`. Hard Safety Policies at `~/.mergen/safety-policy.json` always apply first.*

---

## 07 // Pricing

### Start free. The corpus pays for itself.

| Solo / Open Source | Growth | Enterprise |
| :--- | :--- | :--- |
| **$0/forever** | **$299/mo** | **Custom** |
| Full operational intelligence loop on a single machine. Override corpus, calibration, pre-commit guard. No cloud, no card. | Shared operational memory across your engineering team. Incident replay, Slack-to-corpus learning loop, ROI dashboard. Up to 10 services. | Policy-enforced autonomous remediation, CI/CD agent safety gate, compliance controls, VPC deployment — with a 30-day shadow pilot before any commitment. |
| [Get Started](https://mergen.dev/pricing) | [Start Growth Pilot](https://mergen.dev/pricing#growth) | [Schedule Pilot Call](https://mergen.dev/pricing#enterprise) |

### Feature Comparison

| Feature | Solo | Growth | Enterprise |
| :--- | :--- | :--- | :--- |
| Incident triage + causal analysis | ✓ | ✓ | ✓ |
| Override corpus (local operational DNA) | Local | Shared | Shared |
| Per-environment Platt calibration | ✓ | ✓ | ✓ |
| Pre-commit incident guard (git hook) | ✓ | ✓ | ✓ |
| Agent Blunder Log + audit trail | ✓ | ✓ | ✓ |
| Shadow mode (30-day trust track record) | ✓ | ✓ | ✓ |
| Incident replay + MTTR analytics | — | ✓ | ✓ |
| Slack-to-corpus learning loop | — | ✓ | ✓ |
| ROI dashboard (time saved) | — | ✓ | ✓ |
| Slack ownership routing (10 services) | — | ✓ | ✓ |
| CI/CD agent safety gate (GitHub Action) | — | — | ✓ |
| Policy-enforced autonomous remediation | — | — | ✓ |
| VPC deployment + TLS | — | — | ✓ |
| SSO + RBAC + compliance controls | — | — | ✓ |
| Audit exports (SOC 2 ready) | — | — | ✓ |
| Dedicated onboarding + SLA | — | — | ✓ |

# Mergen — The Execution and Security Gateway for AI Agents

### Secure Every AI Agent Action Before It Executes

Mergen sits inline between AI agents and your systems, blocking unsafe actions, enforcing approval workflows, and creating auditable execution trails across development and production environments.

[Join Design Partner Program](https://mergen.dev/partner) | [Request Early Access](https://mergen.dev/access)

---

### See it in 60 seconds 🚀

```bash
npx mergen-server setup
```

* **✓ Local Execution Gateway** — Intercepts CLI/MCP tool calls, blocks destructive commands, and returns a guided alternative so agents reformulate instead of stopping dead
* **✓ Team Governance Gateway** — CI/CD controls, GitHub PR checks, Slack approvals, and structured audit logs
* **✓ Agent IAM** — Least privilege execution sandboxes and Ephemeral Credentials (coming soon)
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
| **15m · Check dashboards**<br>Correlate metrics across 5 different tabs. | **5s · Check policy &amp; overrides**<br>Matches against past incidents and human overrides. |
| **30m · Ask Slack**<br>"Who deployed last?" "Is the DB down?" | **10s · Generate validated fix**<br>Produces a remediation plan at ≥85% confidence. |
| **45m · Guess root cause**<br>Apply a fix based on intuition. Hope it works. | **1m · Resolve or recommend**<br>Executes (autopilot) or posts fix for approval. |
| **60m+ · Watch and wait**<br>Monitor dashboards for another 15 min to confirm. | **2m · Audit trail posted**<br>Full root cause + actions logged to Slack. |
| **❌ Result**: 3am fire drill. | **✅ Result**: The engineer wakes up to a resolved incident and a full audit trail — not a 3am fire drill. Every action is logged and reversible. |

### Scenario C — Postmortem that forms execution policy

| Without Mergen | With Mergen |
| :--- | :--- |
| **0m · Incident resolved**<br>Engineer writes a postmortem in Notion. Team reads it once. | **0m · Incident resolved**<br>Mergen records the override: "skip pool resize — Friday batch window." |
| **2wk · Postmortem is stale**<br>Nobody updates it. The constraint lives in one person's head. | **1s · Policy encoded**<br>Override corpus entry created. Applies to all future incidents of this type. |
| **3mo · Engineer leaves**<br>The constraint — "never resize pool on Friday" — is gone. | **3mo · Engineer leaves**<br>The constraint stays — in the corpus, queryable, enforceable. |
| **3mo · Same incident**<br>New on-call rebuilds the understanding from scratch. | **3mo · Similar incident fires**<br>Mergen surfaces: "This pattern was overridden 6× — reason: batch-window." Autopilot pauses. |
| **❌ Result**: Knowledge evaporates. | **✅ Result**: Every incident encodes a policy that binds future agent execution. |

---

## 03 // How It Works

### Four steps from agent tool call to secure execution

* **STEP 1: Intercept agent tool access**
  Intercept tool calls and shell command requests from Cursor, Claude Code, or local developer scripts.
* **STEP 2: Evaluate inline policy gates**
  Evaluate rules in under 1ms (unconditional destructive command blocks, time windows, and developer-type conditions).
* **STEP 3: Check execution context**
  Assess changed files against past failures, human overrides, and environment calibration before approval.
* **STEP 4: Gate verdict — PASS / BLOCK / HOLD**
  - **PASS**: handler runs immediately.
  - **BLOCK**: structured error returned with a guided alternative (`Why` + `What to do instead`). The agent reformulates and retries within policy. Blunder logged and hash-chained.
  - **HOLD**: Promise suspended, HITL webhook fires to Slack. One click resumes execution.

```text
PAGERDUTY             OPENTELEMETRY           DOCKER               DATADOG
Incident Alerts       Traces + Metrics        Container Logs       APM Spans
Webhooks              OTLP HTTP               stdout/stderr        Optional
   │                     │                       │                    │
   └─────────────────────┼──────────┬────────────┘                    │
                         ▼          ▼                                 ▼
                    ┌──────────────────────────────────────────────────┐
                    │           EXECUTION GATEWAY                      │
                    │                  Mergen                          │
                    │      Deterministic Policy Engine                 │
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
> **Why this matters**: Most post-incident monitoring tools are evaluated by the engineers who built them, on the incidents they chose. Mergen ships a public eval harness — the same suite that gates every release. The 2 failures are documented: the detector fires on liveness probe and Prometheus scrape errors when it shouldn't. Fix is in the roadmap; hiding it is not.
>
> [View Full JSON Baseline →](file:///Users/omer/Desktop/Mergen/server/src/__tests__/eval-baseline.json)

---

## 02 // The Problem

### AI agents inherit full tool access. Nothing enforces what they're allowed to do.

Your agents can call any MCP tool, execute any shell command, and mutate any system state with zero authorization checks. System prompts saying "please don't drop tables" are probabilistic suggestions — LLMs ignore them under pressure, adversarial injection, or unexpected context shifts.

1. **Agents run with unrestricted tool access**
   *MCP tool calls are not gated. The handler runs the moment the agent calls it.*
   When you register an MCP server, every tool becomes available to every agent with no scope, no role check, and no approval flow. An agent asked to "clean up old records" can call the same `execute_fix` tool that runs `DROP TABLE`. Nothing in the protocol prevents it.

2. **Prompts are advisory, not enforcement**
   *"Don't do X" in a system prompt is a suggestion. Mergen is the stop sign.*
   AI agents trained to be helpful will comply with a prompt instruction under normal conditions. Under adversarial prompt injection, jailbreak, or simply an unusual context shift, they will not. The only reliable enforcement is a deterministic layer outside the LLM's reasoning path.

3. **Monitoring is reactive — the damage is already done**
   *Datadog fires after the agent destroyed the environment. Mergen fires before the handler runs.*
   PagerDuty pages a human. Datadog shows what the agent did. By then the schema is migrated, the infrastructure is torn down, or the credentials are in the logs. Mergen is the inline gate that intercepts the action before any of that happens.

4. **CI pipelines have no agent governance layer**
   *AI-generated PRs and deployments bypass human review at scale.*
   As agents generate pull requests and trigger deployments autonomously, your CI pipeline becomes a production mutation surface with no mandatory human checkpoint. Mergen's CI gate enforces blast-radius analysis and HITL approval before any autonomous change merges.

> [!TIP]
> **The missing layer is not more monitoring.** It is a deterministic execution gate — one that physically intercepts agent tool calls before they reach your OS, terminal, or cloud provider, and enforces the policies your team has defined.

---

## 04 // Core Systems

### Enforcement that runs before the handler. Policy that compounds with every incident.

* **🧬 01 · Override Corpus — Enforcement Policy**
  Every human override becomes binding enforcement policy. After six months: your Friday settlement windows, compliance holds, and hard stop patterns form your specific governance corpus — enforced before any autonomous action triggers. The algorithm is reproducible. This corpus is not.

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
  Mergen tracks what happened while you weren't looking. Next time you check: *"this started failing 6 hours ago."* Not a push notification — a structured context brief waiting when you return.

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
  Data Sources                                           Policy Engine                      AI IDEs
┌──────────────┐                                        ┌────────────────┐                 ┌─────────────┐
│ PagerDuty    │──(Incident trigger)───────────┐        │                │                 │ Claude Code │
├──────────────┤                               │        │                │                 └──────┬──────┘
│ Datadog      │──(Traces + Logs)──────────────┼───────▶│                │──────(Context)─────────┘
├──────────────┤                               │        │                │
│ Slack        │──(Postmortem → corpus)────────┼───────▶│    Execution   │                 ┌─────────────┐
├──────────────┤                               │        │                │──────(Context)──│ Cursor      │
│ Git          │──(ADR → policy)───────────────┼───────▶│    Gateway     │                 └──────┬──────┘
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

### Infrastructure-aligned pricing. Secure your agent execution at any scale.

| Starter (PLG / OSS) | Team (Core Revenue) | Platform (Scale Tier) | Enterprise |
| :--- | :--- | :--- | :--- |
| **$499 / month** | **$2,500 / month** | **$10,000 / month** | **Custom ($100K–$500K / yr)** |
| Basic execution gateway on a single machine. Includes basic override corpus, 1–2 services, Slack + GitHub integration, 10,000 event buffer. | Shared execution gateway across engineering teams. Full operational context graph, Slack + Git + CI ingestion, Cursor/Claude Code Context Packs, 50,000 event buffer. | CI/CD governance layer, agent safety gate, audit logs, 200,000 event buffer. | VPC deployment, strict policy engine (Layer 3 safety), SOC2 alignment, custom override policies. |
| [Get Started](https://mergen.dev/pricing) | [Start Team Pilot](https://mergen.dev/pricing#team) | [Start Platform Pilot](https://mergen.dev/pricing#platform) | [Schedule Pilot Call](https://mergen.dev/pricing#enterprise) |

### Feature Comparison

| Feature | Starter | Team | Platform | Enterprise |
| :--- | :--- | :--- | :--- | :--- |
| Incident triage + causal analysis | ✓ | ✓ | ✓ | ✓ |
| Local Execution Gateway (destructive command blocks) | ✓ | ✓ | ✓ | ✓ |
| Pre-commit incident guard (git hook) | ✓ | ✓ | ✓ | ✓ |
| Agent Blunder Log + local audit trail | ✓ | ✓ | ✓ | ✓ |
| Shared Override Corpus | Local | Shared | Shared | VPC Isolated |
| Slack + Git + CI Webhook Ingestion | — | ✓ | ✓ | ✓ |
| Cursor & Claude Code Context Packs | — | ✓ | ✓ | ✓ |
| CI/CD Agent Safety Gate (GitHub Action / script) | — | — | ✓ | ✓ |
| Epic/Multi-repo Audit Logs | — | — | ✓ | ✓ |
| Ephemeral credentials & identity federation | — | — | — | ✓ |
| Strict Policy Engine (Layer 3 Safety) | — | — | — | ✓ |
| Dedicated Onboarding + SLA | — | — | — | ✓ |

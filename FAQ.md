# Mergen FAQ

---

## What is Mergen?

AI coding tools made writing code fast. They did not make debugging production failures fast.

Mergen is the **operational memory layer for AI-assisted engineering.** It connects your AI IDE (Claude Code, Cursor, Windsurf, VS Code) to live production telemetry — PagerDuty alerts, OpenTelemetry traces, Docker logs, Datadog spans — and compresses that signal into a structured causal chain your IDE can act on.

When an incident fires at 3am, your IDE calls `triage_incident`. Mergen identifies the root cause with evidence, and at ≥85% confidence executes the fix, validates the result, and posts the full audit trail to your Slack thread. No log pasting. No dashboard-hopping. No waking up the team.

Two audiences get distinct value:

- **On-call engineers** — stop reconstructing context from scratch under pressure. Get a root cause, a fix command, and a confidence score backed by your system's own incident history.
- **VPs of Engineering and CISOs** — autonomous AI agents ship code with no institutional memory. Mergen's Override Corpus and Agent Blunder Log are the mandatory guardrails: before an agent executes a change, Mergen checks it against your team's failure history. If it mirrors a past outage, it's blocked and logged.

---

## Is it free?

Mergen uses an open-core model:

| Tier | Price | What's included |
|---|---|---|
| **Solo / Open Source** | $0/forever | Full operational intelligence loop on a single machine. Override corpus, calibration, pre-commit guard. |
| **Growth** | $299/mo | Shared operational memory across your engineering team. Incident replay, Slack-to-corpus learning loop, ROI dashboard. Up to 10 services. |
| **Enterprise** | Custom | Policy-enforced autonomous remediation, CI/CD agent safety gate, compliance controls, VPC deployment — with a 30-day shadow pilot. |

The core server, SDKs, and IDE integrations are MIT-licensed and free. The Hypothesis Engine (causal chain reconstruction, Platt-scaled confidence calibration, autonomous remediation) is licensed under the Elastic License 2.0 — free for internal use, not for resale as a managed service.

See [mergen.dev/pricing](https://mergen.dev/pricing) for full tier details.

---

## Does my data leave my infrastructure?

No. All telemetry stays on your machine (or your VPC in enterprise mode).

- The server binds to `127.0.0.1` by default — unreachable externally without explicit opt-in.
- All event data is stored in SQLite on the host filesystem. No external database. No cloud sync.
- Sensitive fields (Authorization headers, JWTs, API keys, credit card numbers, PEM keys) are redacted **on write** — before the event is stored. Redacted data never appears in any log or AI response.
- Anonymous accuracy signals are **opt-in only**: `MERGEN_TELEMETRY=1` sends detector tag + verdict only. Never incident content, service names, commands, or stack traces.

---

## Which AI IDEs are supported?

- Claude Code
- Cursor
- Windsurf
- VS Code (with GitHub Copilot in agent mode)
- Any IDE that supports the Model Context Protocol (MCP)

---

## Which integrations are supported?

| Category | Supported |
|---|---|
| **Alerting** | PagerDuty (v3 webhooks) |
| **Traces** | OpenTelemetry (any language, OTLP HTTP) |
| **APM** | Datadog (trace fetch + blame attribution) |
| **Containers** | Docker (log streaming, all containers) |
| **Orchestration** | Kubernetes (events poller) |
| **CI/CD** | GitHub Actions, GitLab CI, Azure DevOps, Jenkins, CircleCI |
| **Comms** | Slack (owns the incident thread) |
| **Ticketing** | Jira, Linear |
| **Error tracking** | Sentry (inbound webhook) |
| **Notifications** | ntfy.sh, Discord |

---

## How do I get started?

```bash
npx mergen-server
```

That's it. Mergen starts a local server, loads 50 real incident scenarios from public postmortems, and opens `http://localhost:3000/demo`. Click "Trigger P1 Incident" to see causal analysis immediately — no PagerDuty, no OTLP, no IDE setup required.

When you're ready to connect real production data:

```bash
mergen-server setup
# Detects your IDE, writes MCP config, guides through optional integrations
```

Full guide: [QUICKSTART.md](QUICKSTART.md)

---

## What does the autonomous incident loop look like?

When PagerDuty fires:

1. Mergen receives the webhook
2. Fetches trace context from Datadog (if configured)
3. Posts a structured alert to your Slack thread
4. Runs causal analysis across telemetry, logs, and your override history
5. If confidence ≥ 85% and `MERGEN_AUTOPILOT=true`: executes the fix, waits 5s, validates error counts
6. Posts `RESOLVED / PARTIAL / REGRESSED` to the Slack thread with full audit trail

The engineer wakes up to a resolved incident and a complete audit trail — not a 3am fire drill.

---

## What is shadow mode?

Shadow mode lets you build a 30-day track record before enabling autonomous execution.

```bash
MERGEN_SHADOW_MODE=true mergen-server start
```

Mergen runs the full diagnosis pipeline on every incident and posts what it *would have done* to your Slack thread — without executing anything. After 30 days, pull the impact report:

```bash
open http://127.0.0.1:3000/impact-report?format=html
```

This gives you: N incidents analyzed, X% Mergen would have resolved correctly, average proposed MTTR vs. actual. That is the number your CISO needs before approving autonomous execution.

---

## What is the Override Corpus?

Every time your team decides not to apply Mergen's recommendation, you record why:

```bash
curl -X POST http://127.0.0.1:3000/overrides \
  -H 'Content-Type: application/json' \
  -d '{
    "incidentTag": "infra_db_connection_pool",
    "proposedCommand": "kubectl set env deployment/api DB_POOL_MAX=50",
    "overrideReason": "batch-window",
    "note": "Friday 20-24 UTC — settlement window, pool resize unsafe during this period"
  }'
```

After enough overrides, Mergen will pause before taking that action in the same context again — and explain why in the Slack thread. After six months of production: your Friday settlement windows, your compliance holds, your on-call's preferred fixes — structured, queryable, and impossible to replicate from documentation.

---

## What is the Agent Blunder Log?

Every time Mergen's safety layer blocks an autonomous action, it's recorded:

```bash
curl http://127.0.0.1:3000/agent-blunders
# {"prevented": 23, "byType": {"allowlist_block": 14, "override_corpus_block": 7, "rbac_block": 2}}
```

`prevented: 23` means your on-call did not handle 23 potentially unsafe autonomous actions. It's also the answer to "why would you trust an AI agent with prod?" — the system blocked itself, logged why, and waited.

---

## What does the 94% accuracy claim mean?

Mergen ships a public regression eval harness: 33 real incident scenarios across 10 infrastructure failure classes. Every PR that touches detection logic must pass this suite. 31 of 33 correct. The 2 failures are documented: the detector fires on liveness probe and Prometheus scrape errors when it shouldn't.

We publish the full JSON baseline. The 94% is reproducible and falsifiable.

---

## Can I use Mergen with my CI/CD pipeline?

Yes. Mergen has native integrations for GitHub Actions, GitLab CI, Azure DevOps, Jenkins, and any system that can make an HTTP POST:

```bash
# GitHub Actions
curl -X POST $MERGEN_URL/ci \
  -H "x-mergen-secret: $MERGEN_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{"sha":"${{ github.sha }}","branch":"${{ github.ref_name }}","status":"failed"}'
```

CI events are joined to error logs and backend spans via commit SHA — so when an error fires in production, Mergen shows which CI run built the code and whether it had failing tests.

---

## Can I use Mergen in a corporate environment?

Yes. Mergen is designed for enterprise VPC deployment. The server binds to `127.0.0.1` by default — no external connections. Team mode (`MERGEN_BIND=0.0.0.0`) requires explicit opt-in and a shared secret. Cloud mode adds TLS, SHA-256 hashed API keys, and per-tenant event isolation.

Works in air-gapped networks and behind corporate firewalls. All data stays on your infrastructure.

---

## What is the performance impact?

- Server: <5ms per event ingestion
- Ring buffer: 2000 events, O(1) eviction
- Memory: ~50–80MB for the server process
- No network calls during normal operation (all local)
- CI: `NODE_OPTIONS="--max-old-space-size=8192" npm run build` required for the full build (tools.ts is 2200+ lines of Zod schemas)

---

## How does autopilot stay safe?

Five layers, in order:

1. **Shadow mode first** — default for new installs. Never executes. Builds the track record.
2. **Confidence gate** — autonomous execution only at ≥85% remediation confidence (Platt-scaled, not raw heuristic).
3. **Override corpus gate** — checks your team's override history before every action. Will pause if the action has been overridden in this context before.
4. **Safety blocklist** — 15 unconditional blocks: `rm -rf`, `curl | bash`, `DROP TABLE`, `git push --force`, and others. These never execute regardless of confidence.
5. **Validation + rollback** — after execution, error counts are compared before/after. If errors increase, the inverse command runs automatically (`kubectl rollout undo`, package version revert).

Every action — taken or blocked — is written to `~/.mergen/audit.log` as JSONL.

---

## How is Mergen different from Datadog, PagerDuty, or Sentry?

Datadog, PagerDuty, and Sentry tell you **what's broken**. They page a human. The human digs through dashboards and fixes it.

Mergen acts on what they tell it. When PagerDuty fires, Mergen pulls the correlated telemetry, runs causal analysis, consults your team's override history, and either executes the fix or hands your AI IDE a structured brief with evidence and a specific command. It does not replace your observability tools — it is the execution and memory layer above them.

---

## Is there an enterprise trial?

Yes. Enterprise evaluation starts with a 30-day shadow mode pilot: Mergen analyzes your real incidents and posts what it would have done to your Slack thread, without executing anything. At the end of 30 days, the impact report shows exactly how many incidents Mergen would have resolved, at what MTTR, and what it got wrong — with the full comparison table for your CISO.

Contact [hello@mergen.dev](mailto:hello@mergen.dev) to start a pilot. We'll define success criteria together before you run a line of code.

---

## More resources

- [README.md](README.md) — full product overview
- [QUICKSTART.md](QUICKSTART.md) — 2-minute setup
- [INSTALL.md](INSTALL.md) — all install methods
- [docs/enterprise.md](docs/enterprise.md) — enterprise deployment guide
- [GitHub Issues](https://github.com/omertt27/Mergen/issues) — bug reports
- [GitHub Discussions](https://github.com/omertt27/Mergen/discussions) — feature requests

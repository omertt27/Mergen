# Mergen MCP Tools Reference

Complete reference for all Model Context Protocol (MCP) tools provided by Mergen.
Tools are available in any AI IDE that supports MCP (Claude Code, Cursor, Windsurf, VS Code).

**Free tools** — available on all plans, no credit cost.
**Pro tools** — require a paid Mergen plan. Free-plan callers receive an upgrade prompt.

---

## Quick Reference

| Tool | Tier | Category | What it does |
|------|------|----------|--------------|
| `reconstruct_context` | free | Analysis | Causal analysis — root cause + fix hint from buffered telemetry |
| `analyze_runtime` | free | Analysis | Runtime causal analysis (alias / closed-source variant) |
| `quick_check` | free | Analysis | Fast sanity check — errors, network failures, recent changes |
| `explain_warning` | free | Analysis | Explain a specific warning or error message |
| `session_summary` | free | Analysis | Summary of the current debug session |
| `explain_why` | free | Analysis | Explain why an error occurred from first principles |
| `get_causal_graph` | free | Analysis | Directed causal graph of error propagation |
| `get_error_frequency` | free | Analysis | Error frequency and rate over time windows |
| `get_anomaly_baseline` | free | Analysis | Baseline anomaly detection vs historical rate |
| `get_regression_start` | free | Analysis | Bisect when a regression first appeared |
| `get_repro_steps` | free | Analysis | Generate reproduction steps for a bug |
| `get_change_timeline` | free | Analysis | Timeline of code + config changes correlated to errors |
| `get_recent_logs` | free | Buffer | Console logs from the ring buffer |
| `get_network_activity` | free | Buffer | HTTP/fetch events with status, duration, body |
| `get_dom_context` | free | Buffer | DOM snapshot — active element, localStorage, viewport |
| `get_diagnostics` | free | Buffer | Aggregated diagnostics report |
| `get_test_results` | free | Buffer | Test runner output captured in buffer |
| `get_snapshots` | free | Buffer | Named buffer snapshots |
| `get_service_topology` | free | Buffer | Service dependency graph from observed traffic |
| `get_component_tree` | pro | Buffer | React/Vue component tree with props and state |
| `get_websocket_activity` | pro | Buffer | WebSocket frames with payload inspection |
| `get_sse_activity` | pro | Buffer | Server-Sent Events stream with message log |
| `get_process_logs` | free | Backend | Stdout/stderr from watched processes |
| `get_ci_results` | free | Backend | Latest CI build results posted to Mergen |
| `get_deployments` | free | Backend | Recent deployment events |
| `get_unified_timeline` | pro | Backend | Browser request joined to backend span — exact causal join |
| `get_backend_logs` | pro | Backend | Structured backend logs from SDK or Docker streams |
| `get_backend_spans` | pro | Backend | OpenTelemetry spans from the OTLP ingest endpoint |
| `get_correlated_trace` | pro | Backend | Correlate a frontend error to its backend trace |
| `get_code_owners` | pro | Backend | CODEOWNERS lookup for a file path |
| `get_blast_radius` | pro | Blast radius | User impact: sessions affected, browser/OS segments, causal deploy |
| `get_attribution_accuracy` | pro | Blast radius | Historical accuracy of causal blame attribution by confidence band |
| `triage_incident` | free | Incidents | Full autonomous loop: diagnose + optional fix + validate |
| `execute_fix` | pro | Incidents | Execute a specific fix command (requires `confirm: true`) |
| `validate_fix` | free | Incidents | Compare error counts before/after a fix — records verdict |
| `watch_for_fix` | free | Incidents | Watch a file or process for change as fix confirmation |
| `stop_file_watch` | free | Incidents | Stop a running file watcher |
| `get_incident_history` | free | Incidents | Past incidents from the memory store |
| `list_open_incidents` | free | Incidents | Currently open PagerDuty incidents |
| `get_incident_context` | free | Datadog | Fetch + compact the active Datadog incident (500KB → 1KB) |
| `get_datadog_trace` | pro | Datadog | Fetch and compact a specific trace by ID |
| `get_datadog_logs` | pro | Datadog | Fetch logs from Datadog with service/time filters |
| `start_debug_session` | free | Debug sessions | Fingerprint baseline errors; track resolution across fix attempts |
| `checkpoint_debug_session` | free | Debug sessions | Diff current state vs baseline — resolved / persisted / regressions |
| `end_debug_session` | free | Debug sessions | Close session with final diff summary |
| `inject_logpoint` | pro | Debug sessions | Inject a temporary log statement at a selector without redeploying |
| `remove_logpoint` | pro | Debug sessions | Remove a previously injected logpoint |
| `check_fix_history` | free | Runbook | Check whether a fix command has been tried before and what happened |
| `explain_service` | free | Runbook | Explain a service from its observed traffic and incident history |
| `generate_runbook` | pro | Runbook | Synthesize a runbook for a failure mode from the postmortem corpus |
| `search_postmortems` | pro | Runbook | Semantic search over the postmortem corpus (BM25 + TF-IDF + RRF) |
| `draft_postmortem` | pro | Runbook | Draft a blameless postmortem from live telemetry + corpus context |
| `create_postmortem` | pro | Runbook | Create and store a postmortem |
| `list_postmortems` | pro | Runbook | List stored postmortems |
| `get_session_replay` | free | Sessions | Retrieve events from past archived debug sessions |
| `get_audit_log` | pro | Sessions | Enterprise audit log — all API calls with actor, method, status |
| `store_agent_memory` | free | Memory | Store a key-value pair in the agent's persistent memory |
| `recall_agent_memory` | free | Memory | Recall a previously stored memory by key |
| `create_ticket` | pro | Intent | Create a ticket in Linear, GitHub Issues, or Jira |
| `clear_buffer` | free | Utility | Empty the ring buffer |
| `get_status` | free | Utility | Server health, active plan, buffer stats, credit usage |
| `mark_capture_start` | free | Utility | Mark the start of a capture window for later export |
| `export_session` | free | Utility | Export the current buffer as JSONL |
| `suggest_logging_locations` | free | Utility | Suggest where to add logging to improve observability |

---

## Categories

### Analysis

`reconstruct_context` · `analyze_runtime` · `quick_check` · `explain_warning` · `session_summary` · `explain_why` · `get_causal_graph` · `get_error_frequency` · `get_anomaly_baseline` · `get_regression_start` · `get_repro_steps` · `get_change_timeline`

Root-cause and context tools. Start here during any incident.

- **`reconstruct_context`** — Primary on-call tool. Runs causal analysis on buffered telemetry and returns root cause + a fix hint. Call this first.
- **`quick_check`** — Three-line summary: error count, top error, last network failure. Use for a fast pulse check.
- **`get_causal_graph`** — Directed graph of which event caused which. Useful when multiple errors are firing and you need to find the origin.
- **`get_change_timeline`** — Correlates git commits, deploys, and config changes to the error spike. Shows what changed when the errors started.

---

### Buffer reads

`get_recent_logs` · `get_network_activity` · `get_dom_context` · `get_diagnostics` · `get_test_results` · `get_snapshots` · `get_service_topology` · `get_component_tree`★ · `get_websocket_activity`★ · `get_sse_activity`★

Direct reads from the 2000-event ring buffer. Available without Datadog from day one.

- **`get_recent_logs`** — Console events (log/warn/error) with level filter and time window.
- **`get_network_activity`** — Fetch and XHR events with status, duration, and truncated body.
- **`get_dom_context`** — Current page state: active element, scroll position, localStorage keys.
- **`get_websocket_activity`**★ — WebSocket frames with direction and payload (requires `websocketInspection` feature flag).
- **`get_sse_activity`**★ — Server-Sent Events messages with timestamps.

---

### Backend / infra

`get_process_logs` · `get_ci_results` · `get_deployments` · `get_backend_logs`★ · `get_backend_spans`★ · `get_correlated_trace`★ · `get_unified_timeline`★ · `get_code_owners`★

Backend telemetry from OpenTelemetry, Docker, CI, and process watchers.

- **`get_unified_timeline`**★ — Joins a browser request to its backend span. The fastest path to full-stack causality.
- **`get_backend_spans`**★ — OpenTelemetry spans received at `:4318/v1/traces`. Filtered by service and time.
- **`get_correlated_trace`**★ — Given a frontend error, finds the matching backend trace ID.
- **`get_code_owners`**★ — Returns the team responsible for a file path, from CODEOWNERS or Datadog.

---

### Blast radius

`get_blast_radius`★ · `get_attribution_accuracy`★

Impact quantification — the board-deck answer to "how many users are broken?"

- **`get_blast_radius`**★ — Unique sessions affected, user count, browser/OS breakdown, first-seen time, and the likely causal deploy. Confidence note included when session IDs are absent.
- **`get_attribution_accuracy`**★ — Historical accuracy of causal blame attribution by confidence band. Use to validate whether attribution scores are trustworthy enough for autonomous action.

---

### Incidents

`triage_incident` · `execute_fix`★ · `validate_fix` · `watch_for_fix` · `stop_file_watch` · `get_incident_history` · `list_open_incidents`

The autonomous incident loop.

- **`triage_incident`** — Entry point. Diagnose + optional fix + validate in one call. Set `MERGEN_AUTOPILOT=true` to enable autonomous execution at ≥85% confidence.
- **`execute_fix`**★ — Execute a specific fix command. **Requires `confirm: true`** — always show the user what will run before calling. Returns stdout, exit code, and a RESOLVED/PARTIAL/REGRESSED verdict.
- **`validate_fix`** — Compare error counts before/after. Records verdict to the override corpus.

---

### Datadog

`get_incident_context` · `get_datadog_trace`★ · `get_datadog_logs`★

Requires `DD_API_KEY` + `DD_APP_KEY`.

- **`get_incident_context`** — Fetches and compacts the active Datadog incident (500KB trace → 1KB Runtime Fact). Pre-fetched when a PagerDuty webhook fires — returns instantly. **Call this first during a P1.**
- **`get_datadog_trace`**★ — Fetch and compact a specific trace by ID. Useful when you have a trace ID from a Sentry event or log line.

---

### Debug sessions

`start_debug_session` · `checkpoint_debug_session` · `end_debug_session` · `inject_logpoint`★ · `remove_logpoint`★

Iterative fix-and-verify loop without manual error diffing.

**Workflow:**
1. `start_debug_session(hypothesis: "...")` — fingerprints all current errors as baseline
2. Apply your fix and reproduce the scenario
3. `checkpoint_debug_session(session_id, note: "added null check")` — get exact diff: ✅ resolved · ❌ persisted · ⚠️ new regressions
4. Repeat until clean, then `end_debug_session`

- **`inject_logpoint`**★ — Inject a temporary `console.log` at a DOM selector without redeploying. Captured by the ring buffer immediately.
- **`remove_logpoint`**★ — Remove by logpoint ID.

---

### Runbook / postmortem

`check_fix_history` · `explain_service` · `generate_runbook`★ · `search_postmortems`★ · `draft_postmortem`★ · `create_postmortem`★ · `list_postmortems`★

Corpus-powered institutional memory.

- **`check_fix_history`** — Before running a fix, check whether it's been tried before and what happened. Prevents repeating fixes that caused regressions.
- **`generate_runbook`**★ — Synthesizes a self-updating runbook from past incidents using hybrid retrieval (FTS5 BM25 + TF-IDF cosine similarity, fused via Reciprocal Rank Fusion). Pass a failure tag or free-text description.
- **`search_postmortems`**★ — Semantic search over the postmortem corpus. Use before triaging to find the 3–5 most relevant past incidents.
- **`draft_postmortem`**★ — From "incident closed" to a blameless Markdown draft in seconds. Auto-links to similar corpus incidents.

---

### Sessions / audit

`get_session_replay` · `get_audit_log`★

Historical and compliance access.

- **`get_session_replay`** — Load events from auto-saved past sessions. Call with `list_only: true` first to see what's available.
- **`get_audit_log`**★ — Immutable record of all API calls: timestamp, actor, method, path, status, duration. Required for SOC 2 / compliance reviews.

---

### Agent memory

`store_agent_memory` · `recall_agent_memory`

Persistent key-value storage scoped to the agent across sessions.

---

### Intent / tickets

`create_ticket`★

Create a ticket from an incident analysis without leaving the AI IDE. Providers: **Linear**, **GitHub Issues**, **Jira**. Requires provider API token.

---

### Utility

`clear_buffer` · `get_status` · `mark_capture_start` · `export_session` · `suggest_logging_locations`

- **`get_status`** — First call to make after connecting. Shows active plan, buffer fill rate, credit balance, and tool call counts.
- **`clear_buffer`** — Empties the ring buffer and auto-saves the current session to disk.
- **`export_session`** — Export buffer as JSONL for offline analysis or audit.
- **`suggest_logging_locations`** — Given a file path, suggests where to add `console.log` / OpenTelemetry spans to improve future observability.

---

## Pro plan upgrade

Pro tools return a structured upgrade prompt when called on a free plan:

```
## Tool unavailable on Free plan

This tool requires a paid Mergen plan.

Upgrade at: https://mergen.dev/pricing

To check your current plan: call `get_status`.
To activate a license key: POST /license { "key": "..." }
```

The AI surfaces this directly — no silent failures, no crashes.

---

## See also

- [INSTALL.md](INSTALL.md) — setup and IDE configuration
- [API.md](API.md) — REST API reference (ingest, webhooks, incidents)
- [ARCHITECTURE.md](ARCHITECTURE.md) — how the ring buffer and MCP server work
- `GET /status` — live server status including per-tool call counts

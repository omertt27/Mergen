# mergen-server

Claude Code doesn't know what happened in production. Mergen does.

MCP server for your AI IDE. Once connected, ask *"what caused the 3am incident"* and get a causal chain from live telemetry — not a log dump, a structured hypothesis with evidence and a fix command. At ≥85% confidence it executes the fix, validates the result, and posts the audit trail to your Slack thread.

[![npm](https://img.shields.io/npm/v/mergen-server)](https://www.npmjs.com/package/mergen-server)
[![License](https://img.shields.io/badge/license-MIT%20%2B%20Proprietary-blue)](https://github.com/omertt27/Mergen/blob/main/LICENSE)
[![MCP](https://img.shields.io/badge/MCP-stdio-black)](https://modelcontextprotocol.io)

---

## Quick start

```bash
npm install -g mergen-server
mergen-server setup
```

Then add to Claude Code:

```bash
claude mcp add mergen --transport stdio -- mergen-server start
```

Ask: *"Triage the api-service."*

---

## What it does

```
PagerDuty fires
  → Mergen pulls correlated telemetry
  → Causal analysis (root cause + evidence)
  → If confidence ≥ 85% → executes fix
  → Validates result
  → Posts audit trail to Slack thread
```

All data stays on your infrastructure. No cloud. No copy-paste.

---

## MCP tools

| Tool | What it does |
|------|-------------|
| `triage_incident` | Full autonomous loop — diagnosis + optional fix |
| `execute_fix` | Execute a specific fix (requires `confirm: true`) |
| `analyze_runtime` | Causal analysis — root cause + fix hint, no execution |
| `get_recent_logs` | Console events from the ring buffer |
| `get_network_activity` | HTTP/fetch events with status, duration, body |
| `validate_fix` | Compare error counts before/after a fix |
| `generate_runbook` | Self-updating runbook from your incident corpus |
| `search_postmortems` | Semantic search over past incidents |
| `draft_postmortem` | Blameless post-mortem draft in seconds |

---

## Environment variables

```bash
MERGEN_AUTOPILOT=true              # enable autonomous fix execution
MERGEN_SLACK_BOT_TOKEN=xoxb-...    # Slack Web API (threads + replies)
MERGEN_SLACK_CHANNEL=#incidents    # default incident channel
```

Point your OTLP exporter at `http://127.0.0.1:3000` and PagerDuty webhooks at `/webhooks/pagerduty`.

---

## Node.js SDK (one line)

```js
import 'mergen-server/sdk/node.js';
// Captures uncaught exceptions, unhandledRejections, and process exits automatically
```

---

## Post-mortem from Slack thread

```bash
curl -X POST http://127.0.0.1:3000/postmortem/from-slack \
  -H 'Content-Type: application/json' \
  -d '{"thread_url":"https://yourworkspace.slack.com/archives/C1234567/p1700000000000000","service":"api"}'
```

Fetches the thread via `conversations.replies`, correlates with telemetry, and returns a blameless post-mortem draft in seconds.

---

## Full documentation

[github.com/omertt27/Mergen](https://github.com/omertt27/Mergen)

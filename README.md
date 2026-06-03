<div align="center">

# Mergen

### Agent-native telemetry for the machine-readable stack.

**Stream browser, backend, and microservice signals into Cursor, Claude Code, Copilot, or Windsurf via MCP.**

[![Tests](https://img.shields.io/badge/tests-142%20passing-brightgreen)](./server)
[![License](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![MCP](https://img.shields.io/badge/Model%20Context%20Protocol-stdio-black)](https://modelcontextprotocol.io)
[![Local-only](https://img.shields.io/badge/data-127.0.0.1%20only-success)](#privacy)
[![Agent-Native](https://img.shields.io/badge/telemetry-agent--native-black)](./docs/HONESTY.md)

[**Quick Start →**](./QUICKSTART.md) · [**Install Guide →**](./INSTALL.md) · [**Architecture →**](./ARCHITECTURE.md) · [**Pricing →**](#pricing) · [**Enterprise Security →**](./docs/ENTERPRISE_SECURITY.md)

</div>

---

## What it is

Mergen is the **machine-readable observability stack** for AI coding agents. 

AI agents can read code, but they are "blind to runtime." Mergen gives them the live runtime context and verified causal links they need to autonomously resolve system failures. 

Unlike legacy observability built for human dashboards, Mergen streams **agent-native telemetry** — deterministic causal joins linking browser errors to specific microservice failures — directly into AI-native editors via the Model Context Protocol (MCP).

### Why agent-native telemetry matters

Most AI tools provide raw log dumps. Mergen provides a **Machine-Readable Causal Graph**:

| Evidence Tier | Reliability | Agent Action |
| :--- | :--- | :--- |
| **EXACT_JOIN** | 100% | Direct link: Browser ↔ Microservice traceId. Confirmed truth. |
| **STRUCTURAL** | High | Structural connection (e.g., component-state-event link). |
| **HYPOTHESIS** | Medium | Statistical correlation. Requires agent validation. |
| **OBSERVATION** | Baseline | Raw runtime signal with no confirmed parent yet. |

---

## Why it exists

> **Observability for machine consumption, not human dashboarding.**

Sentry built dashboards for humans. Mergen built the machine-readable context layer for your AI.

Every other "browser MCP" is a thin pipe for *agents driving a browser*. Mergen is the first stack designed for the *AI agent observing a live system*.

Mergen tracks agent actions across complex enterprise microservices using a **zero-config backend proxy** (`node --require`), proving trace correlation across headless architectures.

|                          | Legacy Observability     | Headless Browser MCPs | **Mergen**                      |
| ------------------------ | ------------------------ | ------------------- | ------------------------------- |
| **Target Audience**      | Humans (Dashboards)      | Headless Scripts    | **AI Agents (Machine-Readable)** |
| **Microservice Depth**   | Manual Instrumentation   | None (Frontend Only)| ✅ **Zero-Config Runtime Proxy** |
| **Causal Graph**         | ❌                       | ❌                  | ✅ **EXACT** joins across services |
| **Authentication**       | Production cookies       | Clean/Headless      | ✅ **Existing REAL cookies & auth** |
| **Privacy**              | Vendor cloud             | Vendor cloud / OSS  | **127.0.0.1 — never leaves**    |

---

## What's in the box

- **Agent-Native Extension** (Chrome / Edge MV3) — streams session-state, auth, and HMR signals.
- **Zero-Config Backend Proxy** (Node / Python / Go) — attaches trace IDs across microservice boundaries.
- **Machine-Readable Server** (Node 18+) — the "Causal Engine" that joins signals into a Context Pack.
- **MCP tools** for machine-to-machine communication:
  - `analyze_runtime` — **The Core:** Emits a causal graph with EXACT/STRUCTURAL evidence.
  - `get_recent_logs`, `get_network_activity`, `get_dom_context` (Free).
- **CLI** — `mergen status`, `mergen doctor`, `mergen setup`.
- **Checkpoint-on-Save** — turn every save into a debugging timeline marker your AI can diff against.

---

## Privacy

**Local-first machine observability.** Nothing about your code, logs, or agent actions leaves the machine.

| What                          | Where                                    |
| ----------------------------- | ---------------------------------------- |
| Agent → machine               | `127.0.0.1`, never the internet          |
| Ring Buffer                   | In-memory only, capped, cleared on quit  |
| PII (JWTs, emails, tokens)    | Redacted at ingest by `redact.ts` *before* storage |
| Network bodies                | Clamped to 8 KB for context efficiency   |

The server binds to `127.0.0.1` — not `0.0.0.0`. Your AI host talks MCP over **stdio**, which is a pipe, not a socket. This is the only stack you can deploy inside an air-gapped network without a security review.

---

## Pricing

**Machine Reasoning Credits.** You pay only when the engine reasons for your AI.

| Plan          | Price        | Reasoning calls per month | Buffer | Microservice Tracing |
| ------------- | ------------ | --------------------------- | ------ | --------- |
| **Developer** | $0           | **500 / month**             | 2,000  | ✅         |
| Solo Pro      | $29 / mo     | 2,000 (then $0.02 each)     | 2,000  | ✅         |
| Team          | $39 / seat   | 3,000/seat pooled           | 2,000  | ✅         |
| Pay-as-you-go | $0.05 / call | Metered, no subscription    | 2,000  | ✅         |

---

## ⚡ Microservice Setup — pick your path

**Start the machine-readable server first:**
```bash
npx mergen-server@latest setup
```

---

### Headless / Backend / Microservices *(Zero-Config Proxy)*

```bash
# Proves trace correlation across service boundaries without code changes:
node --require mergen-server/sdk/node app.js

# Docker / Kubernetes — point at the loopback:
MERGEN_HOST=host.docker.internal \
  node --require mergen-server/sdk/node app.js
```

Captures: `console.*`, outbound HTTP/HTTPS with automatic traceId injection,
uncaught exceptions. **No browser extension required.**

---

### Browser / Frontend *(Agent-Native Extension)*

```bash
# Load the extension:
# chrome://extensions → Enable Developer mode → Load unpacked → select extension/
```

Captures: console, fetch/XHR, WebSocket, DOM snapshots, React/Vue hierarchies.
Works alongside the Node Proxy for full-stack causal joins.

---

## Power Workflows

### Checkpoint on Save (Automatic Debugging Timeline)

Every time you save a file, Mergen can automatically create a debugging checkpoint — a marker in the causal timeline your AI can reference.

```bash
# Install the git pre-commit hook (surfaces signals before every commit):
node scripts/setup.mjs   # choose option 6

# Or trigger manually:
curl -X POST http://127.0.0.1:3000/checkpoint \
  -H 'Content-Type: application/json' \
  -d '{"label": "before login refactor"}'
```

Then ask your AI: *"What changed between the last checkpoint and this error?"*

The VS Code task `.vscode/tasks.json` already includes a `mergen: checkpoint on save` task — enable it once and every Ctrl+S becomes a timeline marker.

### Capture + Reproduce Bug

1. Click the ▶ **"Start Capture"** button in the Mergen sidebar (or run `mark_capture_start`)
2. Reproduce the bug
3. Ask your AI: *"What happened since capture?"*

Your AI sees only the events from the reproduction window — no noise from earlier in the session.

---

## Community

- **GitHub Discussions** — [Ask questions, share patterns, report false positives →](https://github.com/omertt27/Mergen/discussions)
- **Issues** — [Bug reports and feature requests →](https://github.com/omertt27/Mergen/issues)
- **Feedback** — In the VS Code panel: every hypothesis has a 👍/👎 button that teaches Mergen which detectors are trustworthy.

---

<div align="center">

**Mergen — the machine-readable observability stack for AI agents.**
Agent-Native. Machine-Consumable. Verified Causality.

</div>

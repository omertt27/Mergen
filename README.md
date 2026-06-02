<div align="center">

# Mergen

### Local-first runtime debugging for AI assistants.

**The 30 seconds between a bug appearing in your browser and the fix landing in your editor — and nothing in between leaves your laptop.**

[![Tests](https://img.shields.io/badge/tests-142%20passing-brightgreen)](./server)
[![License](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![MCP](https://img.shields.io/badge/Model%20Context%20Protocol-stdio-black)](https://modelcontextprotocol.io)
[![Local-only](https://img.shields.io/badge/data-127.0.0.1%20only-success)](#privacy)
[![Calibrated](https://img.shields.io/badge/hypotheses-calibrated-7c3aed)](./docs/HONESTY.md)

[**Quick Start →**](./QUICKSTART.md) · [**Install Guide →**](./INSTALL.md) · [**Architecture →**](./ARCHITECTURE.md) · [**Pricing →**](#pricing)

</div>

---

## What it is

Mergen is the runtime-observability layer your AI assistant has been missing.

A browser extension streams `console.*`, `fetch`/`xhr`, and DOM state to a local Node server on `127.0.0.1`. The server correlates them into a **causal chain**, ranks **hypotheses by their actual track record** — not just model confidence — and exposes the result as **MCP tools** that Copilot Chat, Cursor, Claude Code, Windsurf, and ChatGPT Desktop can call directly.

Mergen is **continuous**, not crash-triggered. Every page refresh, hot-reload, network burst, and idle background tick produces a fresh diagnosis — so when your code finally throws, your AI already has the stack trace, the failing request, the response body, the DOM snapshot, **and a baseline of what the page looked like 30 seconds ago when it was still fine**.

Mergen is also **calibrated**. Every hypothesis we surface carries a stable id; one click in the panel ("✓ Yes / ◐ Sort of / ✕ No") teaches the engine which detectors are worth trusting. Detectors below 50% empirical accuracy are demoted; below 20% they're suppressed entirely. The status bar only interrupts you when the firing detector has earned the right (≥60% accuracy, ≥5 verdicts). You don't get "we generate hypotheses" — you get **"we track which hypotheses are actually correct."** See [`docs/HONESTY.md`](./docs/HONESTY.md).

```mermaid
flowchart LR
  B[Browser tab] -- console + fetch + DOM --> X[Mergen extension]
  X -- HTTP 127.0.0.1 --> S[Mergen server]
  S -- MCP stdio --> A[Copilot / Cursor / Claude]
  A -- analyze_runtime() --> S
  S -- Context Pack --> A
```

---

## Why it exists

> **Sentry built dashboards for humans. Mergen built tools for your AI.**

Every other observability product is *during* or *after* deploy: Sentry, LogRocket, Datadog RUM, Highlight. They ship beautiful dashboards to your engineering manager. None of them speak to your AI assistant in its native language.

Every other "browser MCP" is a thin pipe — `getConsoleLogs()`, `clickElement()`. Useful for *agents driving a browser*, useless for the *human debugging their own dev session*.

Mergen sits in the gap nobody else does:

|                          | Production observability | Browser MCPs        | **Mergen**                      |
| ------------------------ | ------------------------ | ------------------- | ------------------------------- |
| When it's used           | After deploy             | Agent automation    | **The dev inner loop**          |
| Audience                 | On-call eng              | Headless agents     | **You, mid-typo**               |
| Surface for AI           | Bolted-on chat panel     | Raw log dump        | **Ranked Context Pack via MCP** |
| Causal chain             | ❌                       | ❌                  | ✅ error ↔ network ↔ DOM in 30s window |
| Hypothesis ranking       | ❌                       | ❌                  | ✅ HIGH/MEDIUM/LOW + fix hint   |
| Source-mapping           | partial                  | ❌                  | ✅                              |
| Where data lives         | Vendor cloud             | Vendor cloud / OSS  | **127.0.0.1 — never leaves**    |
| PII redaction            | configurable, server-side| ❌                  | ✅ at the edge, before storage  |

---

## What's in the box

- **Browser extension** (Chrome / Edge MV3) — streams console, network, DOM
- **Local server** (Node 18+) — ring buffer, causal correlation, MCP host
- **VS Code extension** — sidebar with Context Pack card, hypothesis history, status bar
- **MCP tools** for any host that speaks MCP:
  - `get_status` · `get_recent_logs` · `get_network_activity` · `get_dom_context` · `clear_buffer` *(free)*
  - `analyze_runtime` — the magic: full causal chain, source-mapped, with ranked hypotheses *(paid)*
- **CLI** — `mergen status`, `mergen doctor`, `mergen guard` *(pre-commit)*, `mergen start/stop/clear`
- **HTTP API** — `/diagnose`, `/last-pack`, `/history`, `/timeline` *(text-based session replay)*, `/checkpoint`, `/feedback` + `/calibration` + `/calibration/export` *(audit-friendly CSV)* for non-MCP integrations
- **Continuous-watch loop** — background watcher rebuilds the Context Pack on every pageload, HMR, network burst, and 15 s idle tick. North-Star metric: *analyses per developer per day*, exposed on `/usage`.

---

## Privacy

**Local-first runtime debugging.** This is not a marketing phrase, it's the architecture.

| What                          | Where                                    |
| ----------------------------- | ---------------------------------------- |
| Browser → server              | `127.0.0.1`, never the internet          |
| Buffer                        | In-memory only, capped, cleared on quit  |
| License key                   | `~/.mergen/license.json`, validated lazily |
| PII (JWTs, emails, tokens)    | Redacted at ingest by `redact.ts` *before* storage |
| Network bodies                | Clamped to 8 KB at the edge              |
| Telemetry                     | **Off by default**, opt-in, URL-gated, throttled to 1×/24h, anonymous installId only |

The server binds to `127.0.0.1` — not `0.0.0.0`. Other devices on your Wi-Fi can't reach it. Your AI host talks MCP over **stdio**, which is a pipe, not a socket. Nothing about your code, logs, or browsing leaves the machine unless you explicitly POST to `/telemetry { enabled: true }` *and* set `MERGEN_TELEMETRY_URL` *and* the 24-hour throttle window has elapsed.

For enterprises: this is the only runtime-debug tool you can run inside an air-gapped network without filing a security review.

---

## Pricing

**Open core.** The client tooling is MIT and free forever. You pay only when the Hypothesis Engine does the reasoning for you.

| Plan          | Price        | `analyze_runtime` per month | Buffer | Team sync |
| ------------- | ------------ | --------------------------- | ------ | --------- |
| **Free**      | $0           | **25 / month**              | 200 events | — |
| Solo Standard | $19 / mo     | 500 (then $0.05 each)       | 200    | — |
| Solo Pro      | $39 / mo     | **Unlimited**               | 200    | — |
| Team          | $49 / seat   | Unlimited                   | 200    | ✅        |
| Pay-as-you-go | $0.05 / call | Metered, no subscription    | 200    | — |

**What's always free:**
- The full 200-event ring buffer
- All local MCP tools (`get_status`, `get_recent_logs`, `get_network_activity`, `get_dom_context`, `get_dom_context`, `clear_buffer`)
- The VS Code panel, status bar, and calibration dashboard
- The browser extension and all capture
- The CLI (`mergen status`, `mergen doctor`, `mergen guard`)
- Self-hosting — run everything yourself, forever, no key required

**What's paid:** `analyze_runtime` — the call that turns raw telemetry into a ranked, source-mapped causal chain with fix hints. That's the only thing that costs us money (LLM inference), and it's the only thing we charge for.

---

## What we deliberately *don't* do

Restraint is a feature.

- ❌ **No tab automation / `clickElement`.** That's Playwright + Browser MCP territory; OSS will always undercut paid here.
- ❌ **No video session replay.** LogRocket owns that ground; we do scrubbable *text* timelines instead.
- ❌ **No production SDK.** Sentry et al. are great at prod. We are great at the inner loop. Different problems.
- ❌ **No mandatory cloud account.** You can use 100% of the free tier without an email address.
- ❌ **No telemetry-by-default.** It is structurally impossible for us to look at your code.

---

## ⚡ Install (2 minutes)

**New simplified installation:**

```bash
# 1. Install and configure server (auto-detects your IDE)
npx mergen-server@latest setup

# 2. Install browser extension
# Chrome Web Store (when published) or load unpacked from extension/

# 3. Ask your AI: "Get recent logs"
```

✅ **Done!** See [QUICKSTART.md](QUICKSTART.md) for walkthrough.

**Other methods:** [Docker](INSTALL.md#docker) · [Homebrew](INSTALL.md#homebrew) · [Binaries](INSTALL.md#binaries) · [From Source](INSTALL.md#from-source)

---

## No Chrome extension? No problem.

Mergen works without the browser extension in two ways:

### Option A — Node.js SDK (backend / SSR / React Native)

```bash
# Zero code change — wrap any process:
node --require mergen-server/sdk/node your-app.js

# Or add one line to your entry point:
require('mergen-server/sdk/node');  // CJS
import 'mergen-server/sdk/node';    // ESM

# Docker / container — point at the host machine:
MERGEN_HOST=host.docker.internal node --require mergen-server/sdk/node app.js
```

Captures: `console.log/warn/error`, outbound HTTP/HTTPS with traceparent injection, uncaught exceptions, unhandled rejections.

### Option B — DevTools snippet (any page, no install)

Paste this once into your browser DevTools console:

```javascript
fetch('http://127.0.0.1:3000/sdk/inject').then(r=>r.text()).then(eval)
```

Or load `sdk/devtools-snippet.js` directly. Instruments the current page immediately — no extension, no install, no restart.

### Check everything is wired up

```bash
mergen-server status   # instant health snapshot
mergen-server doctor   # full diagnostic walkthrough
```

---

## Alternative: Install from Source

For development:

```bash
git clone https://github.com/omertt27/Mergen.git
cd Mergen/server
npm install && npm run build
npm start
```

Configure IDE:

```bash
# Auto-configure
node scripts/setup.mjs

# Or manually add to .vscode/mcp.json:
{
  "servers": {
    "mergen": {
      "type": "stdio",
      "command": "node",
      "args": ["${workspaceFolder}/server/dist/index.js"]
    }
  }
}
```

Load `mergen/extension` as an unpacked Chrome extension. Done — your AI assistant now sees what your browser sees.

Full instructions: [SETUP.md](./SETUP.md).

---

## Distribution

Mergen lives where your AI assistant lives:

- 🟢 **VS Code Marketplace** — `mergen.mergen` *(stock VS Code, Insiders, Codespaces)*
- 🟢 **Open VSX** — `mergen.mergen` *(Cursor, Windsurf, VSCodium, Gitpod, code-server)*
- 🟢 **Cursor MCP Directory**
- 🟢 **Anthropic MCP Catalog**
- 🟢 **`awesome-mcp-servers`** *(category: debugging)*
- 🟢 **Chrome Web Store** *(coming)*
- 🟡 **JetBrains Marketplace** *(v1.1 — power users can wire stdio-MCP today)*

If your editor speaks MCP, Mergen already speaks to it. We treat Cursor / Copilot / Claude as **distribution channels, not competitors** — and we publish to **both** registries so neither MS nor non-MS users are second-class.

See [`docs/PUBLISHING.md`](./docs/PUBLISHING.md) for the editor-to-registry map and one-command publish flow.

---

## License

**Client tooling (browser extension, VS Code extension, CLI) — MIT. Free forever.**

The server's Hypothesis Engine and Team Sync are closed-source and fund ongoing development. You can self-host the full stack from this repo; the paid surface is `analyze_runtime` — the one call that touches an LLM.

---

<div align="center">

**Mergen — the only runtime observability tool built for AI assistants.**
Local-first. Causally correlated. 30 seconds from bug to fix.

</div>

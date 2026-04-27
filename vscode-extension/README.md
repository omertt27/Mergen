# Mergen — Local-First Runtime Debugging for AI

> **The 30 seconds between a bug appearing in your browser and the fix landing in your editor — and nothing in between leaves your laptop.**

Mergen is the runtime-observability layer your AI assistant has been missing.

A browser extension streams `console.*`, `fetch` / `xhr`, and DOM state to a local Node server on `127.0.0.1`. The server correlates them into a **causal chain**, ranks **hypotheses** by confidence, and exposes the result as **MCP tools** that Copilot Chat, Cursor, Claude Code, Windsurf, and ChatGPT Desktop can call directly.

Mergen is **continuous**, not crash-triggered. Every page refresh, hot-reload, network burst, and idle background tick produces a fresh diagnosis — so when your code finally throws, your AI already has the stack trace, the failing request, the response body, the DOM snapshot, **and a baseline of what the page looked like 30 seconds ago when it was still fine**.

---

## What this extension gives you

- **Sidebar panel** — live Context Pack with HIGH/MEDIUM/LOW hypothesis ranking, fix hints, and history of recent diagnoses
- **Status bar** — always-on indicator: errors, warnings, network failures, current top signal
- **One-click Send to Chat** — pipe the current Context Pack straight into Copilot / Cursor chat
- **`mergen.guard` pre-commit hook** — block commits when an unresolved HIGH-confidence runtime anomaly is in the buffer
- **Walkthrough** — three concrete steps from install to first diagnosis

This extension is the **VS Code surface** for the open-source [Mergen](https://github.com/omertt27/Mergen) project. It needs:

1. The local **Mergen server** (`server/dist/index.js`). The extension's *Start Local Server* command will find it in your workspace, in `~/.mergen`, or wherever you point `mergen.serverPath`.
2. The **Mergen browser extension** (Chrome / Edge MV3, loaded unpacked from `extension/`).

Both ship in the [Mergen repo](https://github.com/omertt27/Mergen). Run `git clone` once, then everything else is one click.

---

## Privacy

| What                       | Where                                            |
| -------------------------- | ------------------------------------------------ |
| Browser → server           | `127.0.0.1`, never the internet                  |
| Buffer                     | In-memory only, capped, cleared on quit          |
| PII (JWTs, emails, tokens) | Redacted at ingest, *before* storage             |
| Telemetry                  | **Off by default**, opt-in, anonymous installId only |

The server binds to `127.0.0.1` — not `0.0.0.0`. Other devices on your Wi-Fi can't reach it. MCP travels over **stdio**, which is a pipe, not a socket.

---

## Settings

| Setting                  | Default   | Purpose                                                           |
| ------------------------ | --------- | ----------------------------------------------------------------- |
| `mergen.serverPort`      | `3000`    | Port the local server listens on (auto-discovers `3001–3010`).    |
| `mergen.pollIntervalMs`  | `2000`    | How often the sidebar polls the server.                           |
| `mergen.serverPath`      | `""`      | Absolute path to `server/dist/index.js`. Blank = autodetect.      |
| `mergen.autoStartServer` | `true`    | Spawn the server on activation if it isn't already running.       |

---

## Commands

- **Mergen: Open Panel** — focus the sidebar
- **Mergen: Start Local Server** — boot `server/dist/index.js`
- **Mergen: Refresh** / **Mergen: Clear Buffer**
- **Mergen: Open Browser-Extension Install Guide**
- **Mergen: Send Feedback** — opens GitHub Discussions

---

## Feedback wanted

This extension is brand new. If you install it and something is unclear,
please run **Mergen: Send Feedback** — every report from the first 50
installs goes straight into onboarding fixes.

[Source · Issues · Discussions](https://github.com/omertt27/Mergen)

MIT licensed. The bridge is free forever.

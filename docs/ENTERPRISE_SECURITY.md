# Mergen — Enterprise Security Brief

**For:** Security engineers, InfoSec reviewers, compliance teams  
**Purpose:** Answers the standard questions before approving Mergen for internal use  
**Version:** 1.4.x · Last updated: 2026-06

---

## One-paragraph summary

Mergen is a local development tool that captures browser console logs, network
requests, and backend process output on `127.0.0.1` and exposes them to your AI
IDE via a stdio pipe. It binds only to the loopback interface. It makes no
outbound network connections during normal development use. Your code, logs, and
debugging data never leave your machine. The only exceptions are license
validation (paid plans, on-demand) and optional telemetry (off by default,
requires explicit opt-in). The full sensor layer — everything that touches your
data — is MIT open-source and can be audited at
https://github.com/omertt27/Mergen.

---

## What leaves the machine

| Event | Destination | When | Can be disabled |
|---|---|---|---|
| License key validation | `api.lemonsqueezy.com` | On activation + weekly background re-check | Don't activate a paid license |
| LemonSqueezy billing webhook | Inbound only | When you purchase | N/A |
| `analyze_runtime` Context Pack | LLM API (OpenAI / Anthropic) | Only when you explicitly call `analyze_runtime` | Use only free tools |
| Usage telemetry (anonymous installId, tool call counts) | `MERGEN_TELEMETRY_URL` | Off by default. Requires `POST /telemetry { enabled: true }` AND `MERGEN_TELEMETRY_URL` env var AND 24h throttle has elapsed | Never set `MERGEN_TELEMETRY_URL` |
| npm version check | `registry.npmjs.org` | Once per 24h, version number only | `MERGEN_NO_UPDATE_CHECK=true` |

**Everything else — console logs, network events, stack traces, DOM state, localStorage, backend stdout — stays on `127.0.0.1`. It is architecturally impossible for it to leave without modifying the source code.**

---

## Network architecture

```
Chrome extension
  content.js      POST http://127.0.0.1:3000/ingest
  background.js   GET  http://127.0.0.1:3000/health  (badge polling, 10s interval)

Mergen server
  HTTP listener   127.0.0.1:3000–3010  (loopback only, not 0.0.0.0)
  MCP transport   stdio pipe to IDE process  (no socket, no network)

IDE / AI agent
  reads MCP tools via the stdio pipe
  never connects to Mergen's HTTP server directly
```

The server cannot be reached from another machine on the local network. `MERGEN_BIND=0.0.0.0` is the team-mode override — off by default, requires deliberate configuration.

---

## Chrome extension permissions

| Permission | Why it's needed | What it accesses |
|---|---|---|
| `storage` | Persist port config and per-tab mute state | `chrome.storage.local` — no page content |
| `tabs` | Send mute-toggle and port-change messages to content script | Tab ID only, not content |
| `alarms` | Schedule 10s health-poll interval | No data access |
| `host_permissions`: `http://127.0.0.1:3000–3010/*` | POST captured events to local server | Only the loopback — no external URLs |

The extension has **no permissions to access external websites**, read cookies from other origins, or make requests to anything outside `127.0.0.1`. The manifest can be reviewed at `extension/manifest.json`.

The content script (`extension/src/content.js`) runs at `document_start` in every tab. It:
- Wraps `console.log/warn/error` to forward args to the local server
- Wraps `fetch` and `XMLHttpRequest` to capture request/response metadata
- Captures `localStorage`/`sessionStorage` on `console.error` events only
- **Never modifies page behavior** — all patches call the original function first
- **Fails silently** — every code path is wrapped in `try/catch`; an error in the extension cannot affect the page

---

## Data captured and stored

| Data type | What is captured | Where it's stored | Retention |
|---|---|---|---|
| Console events | `level`, `args[]`, `stack`, `url`, `timestamp` | In-memory ring buffer (2,000 events) | Cleared on server restart or `clear_buffer` |
| Network events | `method`, `url`, `status`, `duration`, request/response body (≤8KB) | Same ring buffer | Same |
| DOM context | `url`, `title`, `activeElement`, component name, `localStorage` keys/values | Same ring buffer | Same |
| Backend stdout | Process name, line text, `timestamp` | Same ring buffer | Same |
| SQLite history | Console errors only, for anomaly baseline | `~/.mergen/history.db` (WASM SQLite, in-process) | Configurable via `MERGEN_RETENTION_HOURS` |
| License state | Key hash, plan, customer email | `~/.mergen/license.json` | Persists until manually deleted |
| Local secret | A random UUID | `~/.mergen/secret` (mode `0600`) | Persists; used to authenticate local requests |

No data is written to any path outside `~/.mergen/` and the in-process SQLite store.

---

## PII redaction

Automatic, always-on, runs before any data enters the ring buffer:

| Pattern | Action |
|---|---|
| `Authorization: Bearer ...` header | Value replaced with `[REDACTED]` |
| `Cookie:` header | Value replaced with `[REDACTED]` |
| `password`, `secret`, `token`, `api_key` object keys | Value replaced with `[REDACTED]` |
| JWTs (`eyJ...` base64 patterns) | Replaced with `[REDACTED:jwt]` |
| Email addresses | Replaced with `[REDACTED:email]` |
| Credit card numbers (Luhn-valid 13–19 digit sequences) | Replaced with `[REDACTED:card]` |
| Network request/response bodies | Hard-capped at 8KB; remainder discarded with `[…truncated by mergen]` marker |

Redaction source: `server/src/sensor/redact.ts` — open source, auditable.

---

## Authentication

**Local shared secret** — a random UUID written to `~/.mergen/secret` on first
start (file permissions `0600`). All state-changing HTTP requests (clear, license
activation, telemetry toggle) require the `x-mergen-secret` header to match.

This prevents a malicious web page from calling `POST /clear` via a cross-origin
request — the browser will send the request, but the server rejects it without
the secret. The extension reads the secret from the file and includes it on every
eligible request.

An optional additional secret can be set via `MERGEN_SECRET` env var, which is
then required on the `/ingest` endpoint as well.

---

## Air-gap and offline use

All functionality except license validation and `analyze_runtime` works with no
internet connection. Specifically:

- All free MCP tools (`get_recent_logs`, `get_network_activity`, `get_unified_timeline`, etc.)
- All local buffer and capture functionality
- The VS Code panel, signals, hypothesis detection
- The CLI (`mergen-server status`, `doctor`, `guard`, `watch`)

To run fully air-gapped (no outbound connections at all):

```bash
MERGEN_NO_UPDATE_CHECK=true mergen-server start
# Do not activate a paid license key
# Do not enable telemetry
```

---

## Deployment options for enterprise

| Mode | Network exposure | Use case |
|---|---|---|
| Default (loopback) | `127.0.0.1` only | Individual developer workstation |
| Team mode (`MERGEN_BIND=0.0.0.0`) | LAN — protect with firewall | Shared dev server, pair-programming |
| Docker / container | `MERGEN_HOST=host.docker.internal` in the container | Containerised backend services |
| Air-gapped | No outbound — see above | Secure development environments |

---

## Open source auditability

| Component | License | Source |
|---|---|---|
| Browser extension | MIT | `extension/` |
| Firefox extension | MIT | `extension-firefox/` |
| Node.js SDK | MIT | `sdk/node.js` |
| React Native SDK | MIT | `sdk/mergen-inject.js` |
| HTTP ingest server | MIT | `server/src/sensor/` |
| PII redaction | MIT | `server/src/sensor/redact.ts` |
| Ring buffer | MIT | `server/src/sensor/buffer.ts` |
| MCP tool definitions | MIT | `server/src/intelligence/tools.ts` |
| Hypothesis Engine (`analyze_runtime`) | Closed source | Not distributed |

Everything that touches your data — capture, redaction, storage, transport — is
open source and in this repository.

---

## Common security team questions

**Q: Can Mergen exfiltrate source code?**  
A: No. The extension captures console output (what developers explicitly `console.log`) and network metadata. It does not read source files, access the filesystem, or capture keystrokes. The server never accesses source files except to read `.map` files for stack trace de-minification — it does not transmit them.

**Q: Can a compromised Mergen server read data from other tabs?**  
A: The server can only receive what the extension sends. The extension is scoped to `127.0.0.1` for outbound requests. The server has no browser API access.

**Q: Does the AI (Cursor, Claude, Copilot) see my raw logs?**  
A: Yes — that is the purpose. The AI sees the same console logs and network events that would be visible in Chrome DevTools. It sees what you show it, not more. PII redaction runs before the AI can access any data.

**Q: What happens to data when the developer closes their laptop?**  
A: The ring buffer is in-memory. Server shutdown clears it. No data survives a restart unless the SQLite history store is enabled (off for most events, on for console errors only).

**Q: Can other developers on the same Wi-Fi reach the server?**  
A: No. The server binds to `127.0.0.1` by default. Other machines cannot reach `127.0.0.1` on your machine.

**Q: Can a malicious website make requests to the Mergen server?**  
A: A website can attempt to POST to `127.0.0.1:3000`, and the browser will send the request (CORS doesn't block sends). The server requires the local shared secret on all state-changing endpoints, which the malicious website does not have. The `/ingest` endpoint accepts events without the secret by default — a malicious page could inject fake events, but this would only add noise to the developer's debug session, not exfiltrate data.

**Q: Is there a way to use Mergen without the Chrome extension?**  
A: Yes. The Node.js SDK (`sdk/node.js`) instruments backend services without any browser extension. For frontend, the DevTools snippet (`sdk/devtools-snippet.js`) instruments the current page via manual injection, with no extension installation required.

---

## Contact

Security vulnerabilities: **omertt27@gmail.com**  
GitHub Security Advisories: https://github.com/omertt27/Mergen/security/advisories  
Response SLA: 48 hours for critical issues

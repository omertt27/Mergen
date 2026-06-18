# Mergen Quick Start

> AI coding agents made writing code free. Mergen makes debugging it automatic.

Connect your AI IDE to live production telemetry in under 2 minutes.
Once connected, ask *"Triage the api-service"* and get a causal chain with a fix command — not a log dump.

---

## Step 1 — Install & configure (30 seconds)

```bash
npx mergen-server@latest setup
```

This detects your IDE (Claude Code, Cursor, VS Code, Windsurf), writes the MCP config, and guides you through optional integrations.

**Non-interactive / CI mode:**

```bash
# Skip all prompts, use defaults
npx mergen-server@latest setup --yes

# Target a specific IDE
npx mergen-server@latest setup --ide cursor

# Skip optional steps
npx mergen-server@latest setup --skip-github --skip-extension
```

---

## Step 2 — Start the server (10 seconds)

```bash
mergen-server start
# or in background:
mergen-server start &
```

You should see:
```
{"msg":"HTTP ingest listening on http://127.0.0.1:3000"}
{"msg":"MCP server ready (stdio transport)"}
```

---

## Step 3 — Test it

**In your AI IDE**, ask:
```
Get recent logs
```

You should see events from your running services. 🎉

---

## Optional: browser extension

For frontend + full-stack debugging, install the browser extension:

**Chrome Web Store (recommended):**
Visit: [chrome.google.com/webstore/detail/mergen/xxx](https://chrome.google.com/webstore/detail/mergen/xxx) → "Add to Chrome"

**Manual install:**
1. Open `chrome://extensions`
2. Enable Developer mode
3. Click "Load unpacked" → select the `extension/` folder

---

## What you can ask your AI

```
"Get recent logs"                  → See console output
"Show network activity"            → View HTTP requests
"Why did that request fail?"       → Debug API errors
"Triage the api-service"           → Causal analysis + fix command
"Show me all 401 errors"           → Find auth issues
```

---

## Check integration status at any time

```bash
mergen-server doctor
```

Prints a health report of every integration (Slack, PagerDuty, GitHub, Datadog, Linear, Jira, etc.) with exact `export` commands for anything missing.

---

## Configure optional integrations

```bash
cp server/.env.example .env
# Edit .env — the file is divided into "MINIMUM" and "FULL INTEGRATIONS" sections
```

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `mergen-server: command not found` | Use `npx mergen-server` instead |
| Port 3000 in use | Server auto-tries 3000–3010. Kill with: `lsof -ti:3000 \| xargs kill` |
| Extension not capturing events | Restart browser; check `chrome://extensions` |
| IDE not showing Mergen tools | Restart IDE after setup; run `mergen-server test` |

---

## Alternative install methods

```bash
# Docker
docker-compose up

# Homebrew (macOS)
brew tap omertt27/mergen && brew install mergen

# Binary — no Node.js required
# https://github.com/omertt27/Mergen/releases
```

---

## Architecture

```
Your backend / infra
  └── OTLP / Docker / PagerDuty / GitHub
              ↓
  Mergen HTTP server :3000   (ring buffer, 2000 events)
              ↓
  MCP stdio transport
              ↓
  AI IDE (Claude Code / Cursor / Windsurf / VS Code)
```

**All data stays on your infrastructure. No cloud. No copy-paste.**

---

**Questions?** Open an issue · [Full docs →](README.md) · [Install methods →](INSTALL.md)


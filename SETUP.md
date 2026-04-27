# Mergen — Setup Guide

> **Local-first runtime debugging for AI assistants.** Mergen captures `console.*`, network, and DOM state from your browser on `127.0.0.1`, redacts PII at the edge, and exposes them as MCP tools — so the 30 seconds between a bug appearing in your browser and the fix landing in your editor stay inside your laptop.

---

## Table of Contents

1. [Requirements](#requirements)
2. [Install the server](#install-the-server)
3. [Install the browser extension](#install-the-browser-extension)
4. [Connect your AI host](#connect-your-ai-host)
   - [VS Code (Copilot / Cursor / Windsurf)](#vs-code)
   - [VS Code Sidebar UI (Mergen extension)](#vs-code-sidebar-ui)
   - [Claude Desktop](#claude-desktop)
   - [ChatGPT Desktop](#chatgpt-desktop)
   - [JetBrains IDEs](#jetbrains-ides)
5. [CLI usage](#cli-usage)
6. [License activation](#license-activation)
7. [Environment variables](#environment-variables)
8. [Troubleshooting](#troubleshooting)

---

## Requirements

| Dependency | Version |
|-----------|---------|
| Node.js   | 18 +    |
| npm       | 9 +     |
| Chrome / Edge | any modern version |

---

## Install the server

```bash
# Clone the repo
git clone https://github.com/your-org/mergen.git
cd mergen/server

# Install dependencies and build
npm install
npm run build

# Start the server (stays in the foreground)
npm start

# — or — start it in the background via the CLI
node ../scripts/mergen.mjs start
```

The server starts two listeners:

| Listener | Address | Purpose |
|----------|---------|---------|
| HTTP ingest | `http://127.0.0.1:3000` | Receives events from the browser extension |
| MCP (stdio) | stdin/stdout | Serves tools to your AI host |

If port 3000 is busy the server automatically tries 3001–3010.

---

## Install the browser extension

1. Open **Chrome** or **Edge** and navigate to `chrome://extensions`
2. Enable **Developer mode** (toggle in the top-right corner)
3. Click **Load unpacked**
4. Select the `mergen/extension` folder

The Mergen icon will appear in your toolbar. Click it to verify the connection status — it should show **Connected** with the current port.

> **Tip:** The extension auto-discovers the port (3000–3010), so you don't need to reconfigure it if the port changes.

---

## Connect your AI host

### VS Code

Add Mergen to your workspace MCP configuration:

```jsonc
// .vscode/mcp.json
{
  "servers": {
    "mergen": {
      "type": "stdio",
      "command": "node",
      "args": ["${workspaceFolder}/../server/dist/index.js"]
    }
  }
}
```

Or if the server is installed globally / via the CLI:

```jsonc
{
  "servers": {
    "mergen": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/mergen/server/dist/index.js"]
    }
  }
}
```

Restart VS Code. GitHub Copilot, Cursor, and Windsurf will automatically discover the new tools (`get_recent_logs`, `analyze_runtime`, `get_status`, etc.).

---

### VS Code Sidebar UI

Install the Mergen VS Code extension to get a live sidebar panel showing buffer stats, credit usage, and server health.

**Load it unpacked (development):**

```bash
cd mergen/vscode-extension
npm install
npx tsc
# In VS Code: Ctrl+Shift+P → "Developer: Install Extension from Location"
# Select the vscode-extension/ folder
```

**Settings** (`.vscode/settings.json` or user settings):

```jsonc
{
  "mergen.serverPort": 3000,      // port the server is running on
  "mergen.pollIntervalMs": 2000   // how often the sidebar refreshes (ms)
}
```

The sidebar shows:
- 🟢 / 🔴 connection status
- Buffer error / warning / network-error counts with a **Clear** button
- Credit bar with remaining credits and low-credit warning
- Overage estimate and billing status
- Next reset date

---

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mergen": {
      "command": "node",
      "args": ["/absolute/path/to/mergen/server/dist/index.js"],
      "env": {
        "LS_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

Restart Claude Desktop. You will see Mergen tools in the tool list (🔧 icon).

---

### ChatGPT Desktop

Open **Settings → Extensions → Add MCP server** and fill in:

| Field | Value |
|-------|-------|
| Name | Mergen |
| Command | `node` |
| Arguments | `/absolute/path/to/mergen/server/dist/index.js` |

---

### JetBrains IDEs

In **Settings → Tools → AI Assistant → MCP Servers**, click **+** and add:

| Field | Value |
|-------|-------|
| Name | mergen |
| Transport | stdio |
| Command | `node /absolute/path/to/mergen/server/dist/index.js` |

---

## CLI usage

The `mergen` CLI is a thin wrapper in `scripts/mergen.mjs`.

```bash
# Check server status, credits, and buffer stats
node scripts/mergen.mjs status

# Start server in the background (writes PID to ~/.mergen/server.pid)
node scripts/mergen.mjs start

# Stop the background server
node scripts/mergen.mjs stop

# Clear the event buffer
node scripts/mergen.mjs clear

# End-to-end install health check (server, extension, MCP registration)
node scripts/mergen.mjs doctor
```

**Tip:** Add an alias to your shell profile:

```bash
# ~/.zshrc or ~/.bashrc
alias mergen="node /absolute/path/to/mergen/scripts/mergen.mjs"
```

Then simply run `mergen status`.

**Example output:**

```
● Mergen server is running

  Plan:     Solo Standard  v1.0.0
  Period:   2026-04  →  resets Fri May 01 2026

  Credits:  [████████░░] 82%  41 / 50
             ⚠ Only 9 credits left this month

  Buffer:   3 events  (1 errors, 2 warnings, 0 net errors)
  Port:     3000
```

---

## License activation

1. Purchase a plan at [mergen.dev/pricing](https://mergen.dev/pricing)
2. You will receive a license key by email
3. Activate it via the browser extension popup → **Activate License**
   — or —
   ```bash
   curl -X POST http://127.0.0.1:3000/license \
     -H "Content-Type: application/json" \
     -d '{"key": "YOUR-LICENSE-KEY"}'
   ```

The server will validate the key with LemonSqueezy and persist the plan locally at `~/.mergen/license.json`. No internet connection is required on subsequent startups — validation runs in the background.

---

## Environment variables

Create a `.env` file in `mergen/server/` (never commit it):

```dotenv
# Required for license activation and overage billing
LS_API_KEY=your_lemonsqueezy_api_key

# Required for webhook signature verification (set before going to production)
LS_WEBHOOK_SECRET=your_webhook_secret

# LemonSqueezy variant IDs (set these after creating your products)
LS_VARIANT_SOLO_STANDARD=123456
LS_VARIANT_SOLO_PRO=123457
LS_VARIANT_TEAM=123458
LS_VARIANT_PAYG=123459
```

Start the server with the env file:

```bash
node -r dotenv/config dist/index.js
# or
dotenv -- node dist/index.js
```

---

## Troubleshooting

### Extension shows "Disconnected"
- Make sure the server is running: `mergen status`
- Check that port 3000 (or 3001–3010) is not blocked by a firewall
- Click **Retry** in the extension popup

### MCP tools not appearing in VS Code
- Confirm `.vscode/mcp.json` exists and the path to `dist/index.js` is correct
- Run `npm run build` in the `server/` folder
- Reload VS Code window: `Ctrl+Shift+P → Developer: Reload Window`

### "LS_API_KEY not set" warning on startup
- This is expected in local development without a paid plan
- Set `LS_API_KEY` in your environment to enable license features

### Server crashes on startup
- Check Node.js version: `node --version` (must be 18+)
- Run `npm run build` to ensure the `dist/` folder exists
- Check logs: the server writes structured JSON logs to stdout

### Credits not resetting
- Credits reset on the **1st of the month at 00:00 UTC**
- Run `mergen status` to see the exact reset timestamp
- If the month rolled over but credits weren't reset, restart the server — the reset happens on first use after midnight UTC

---

## MCP tools reference

| Tool | Plan | Description |
|------|------|-------------|
| `get_status` | Free | Plan, credits, billing status, reset date |
| `get_recent_logs` | Free | Last N browser console events |
| `get_network_activity` | Free | Last N fetch/XHR calls |
| `get_dom_context` | Free | DOM + storage snapshots at error time |
| `clear_buffer` | Free | Clear the in-memory event buffer |
| `analyze_runtime` | **Paid** | Full causal chain + source-mapped Context Pack |

---

## HTTP API (advanced / non-MCP integrations)

The server also exposes a small HTTP API on the same port for tools that
don't speak MCP (CI bots, shell scripts, custom dashboards).

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/health` | GET | Liveness + buffer counters + live signals (used by VS Code panel) |
| `/usage`  | GET | Credit usage snapshot |
| `/license`| GET / POST / DELETE | View / activate / deactivate license key |
| `/clear`  | POST | Empty the ring buffer |
| `/checkpoint` | POST | Inject a named milestone into the timeline (`{ "label": "after login impl" }`) |
| `/diagnose` | GET | Returns the current Context Pack + a ready-to-fire OpenAI chat-completion request body. Pipe straight into `scripts/diagnose.mjs` to get a one-shot diagnosis without any IDE. |
| `/last-pack` | GET | Most recent auto-built Context Pack (free; powers the VS Code panel's Context Pack card). |
| `/history` | GET | Last N hypothesis runs (newest first) — `?limit=10` by default. |
| `/telemetry` | GET / POST | View or set opt-in anonymous telemetry. **Disabled by default.** POST `{ "enabled": true }` to opt in. See "Telemetry" below. |

Quick demo of `/diagnose`:

```bash
OPENAI_API_KEY=sk-... \
  curl -s http://127.0.0.1:3000/diagnose | node scripts/diagnose.mjs
```

---

## Telemetry (opt-in, anonymous)

Mergen ships with telemetry **disabled by default**. When enabled it sends
at most one event per 24h containing only:

- An anonymous `installId` (random UUID generated locally on first run)
- The active plan id (`free` / `solo_standard` / …)
- Counts of which MCP tools were invoked
- Server version and Node major version
- Number of buffered events (count, not contents)

It **never** sends source code, log lines, network bodies, Context Packs,
license keys, emails, file paths, or repo names.

Enable from the shell:

```bash
# Persistent (writes ~/.mergen/telemetry.json):
curl -s -X POST http://127.0.0.1:3000/telemetry \
  -H 'Content-Type: application/json' -d '{"enabled":true}'

# One-shot (env var, no disk write):
MERGEN_TELEMETRY=1 npm --prefix server start
```

Even when opted in, nothing leaves the machine unless `MERGEN_TELEMETRY_URL`
is configured. To opt out at any time:

```bash
curl -s -X POST http://127.0.0.1:3000/telemetry \
  -H 'Content-Type: application/json' -d '{"enabled":false}'
```

---

*For bugs or feature requests, open an issue on GitHub.*

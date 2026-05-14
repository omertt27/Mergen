# Mergen — Developer Observability Bridge

Stream live browser telemetry (console logs, network errors, de-minified
stack traces) into any AI IDE — without copy-pasting. All data stays on
localhost.

---

## How it works

```
Chrome tab (any page you develop on)
  └─ extension/src/content.js
       overrides console.log/warn/error
       patches fetch + XMLHttpRequest
       POSTs events to localhost
             │
             ▼
  Express :3000/ingest          ← rate-limited, Zod-validated
       │
       └── in-memory ring buffer (200 events, O(1) eviction)
                │
                ▼
  MCP Server (stdio)            ← speaks Model Context Protocol
       │
       ├── Claude Code  ──  claude mcp add mergen ...
       ├── Cursor        ──  .cursor/mcp.json
       ├── Windsurf      ──  ~/.codeium/windsurf/mcp_config.json
       └── VS Code       ──  .vscode/mcp.json
```

One server. Every AI IDE. Zero cloud.

---

## ⚡ Quick Install (2 minutes)

**New simplified installation:**

```bash
# 1. Install and configure server (auto-detects your IDE)
npx mergen-server@latest setup

# 2. Install browser extension
# Chrome Web Store: https://chrome.google.com/webstore (when published)
# Or manual: Load unpacked from extension/ folder
```

✅ **Done!** Ask your AI: *"Get recent logs"*

See [QUICKSTART.md](QUICKSTART.md) for detailed walkthrough or [INSTALL.md](INSTALL.md) for alternative methods (Docker, Homebrew, binaries).

---

## Alternative: Install from Source

For development or if you prefer building from source:

### Step 1 — Build and run the server

```bash
git clone https://github.com/omertt27/Mergen.git
cd Mergen/server
npm install
npm run build
npm start
```

Expected output:
```
{"msg":"HTTP ingest listening on http://127.0.0.1:3000"}
{"msg":"MCP server ready (stdio transport)"}
```

### Step 2 — Register with your IDE

Run the interactive setup script:

```bash
node scripts/setup.mjs
```

Or use the CLI if you installed via npm:

```bash
npx mergen-server setup
```

### Step 3 — Load the Chrome extension

1. Open `chrome://extensions`
2. Enable **Developer mode** (toggle, top-right corner)
3. Click **Load unpacked** → select the `extension/` folder
4. The Mergen icon appears in your toolbar

---

## Manual IDE setup

### Claude Code

```bash
# From the repo root:
claude mcp add mergen --transport stdio -- node "$(pwd)/server/dist/index.js"

# Verify:
claude mcp list
```

Ask Claude Code: *"Get recent logs"* — it will call `get_recent_logs` automatically.

---

### Cursor

Cursor reads `.cursor/mcp.json` from the project root automatically. This
file is already committed. Open the Mergen repo in Cursor and the server
is available immediately after building.

For a global install (available in every project):

```bash
# writes to ~/.cursor/mcp.json
node scripts/setup.mjs   # choose option 2
```

Then in Cursor: **Settings → Tools → MCP** — confirm "mergen" is listed.

Ask the Agent: *"Why did that last request fail?"*

---

### Windsurf

```bash
node scripts/setup.mjs   # choose option 3
# writes to ~/.codeium/windsurf/mcp_config.json
```

Or manually edit `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "mergen": {
      "command": "node",
      "args": ["/absolute/path/to/Mergen/server/dist/index.js"]
    }
  }
}
```

Restart Windsurf, then open **Cascade → MCP Servers** to confirm.

---

### VS Code (GitHub Copilot Chat)

`.vscode/mcp.json` is already committed and uses `${workspaceFolder}` so
it works without any path editing.

Requirements: VS Code 1.99+, GitHub Copilot extension, Agent mode enabled.

1. Open GitHub Copilot Chat (`Ctrl/Cmd+Alt+I`)
2. Switch to **Agent mode** (robot icon)
3. Click the **tools** button — Mergen tools appear in the list

For a global install (user-level settings):

```bash
node scripts/setup.mjs   # choose option 4
```

---

## MCP tools reference

| Tool | Parameters | What it returns |
|------|------------|----------------|
| `get_recent_logs` | `limit?` (1–200), `level?` (`error`\|`warn`\|`log`), `since?` (unix ms) | Console events, sorted oldest→newest |
| `get_network_activity` | `limit?` (1–200), `status_filter?` (e.g. `404`), `since?` (unix ms) | fetch/XHR events with status, duration, response body |
| `clear_buffer` | — | Empties the ring buffer |

**The `since` parameter** is especially useful: ask the AI to capture a
timestamp before reproducing a bug, then filter to only the events that
happened during the reproduction.

---

## Live workflow example

```
You (in any AI IDE):
  "I just clicked Login and got an error. What happened?"

AI calls: get_recent_logs(level: "error", since: <timestamp>)
AI calls: get_network_activity(status_filter: 401, since: <timestamp>)

AI responds:
  "1 error, 0 warnings. Critical issue:
   POST /api/auth → 401 Unauthorized (342ms)
   console.error: 'Token expired'
   Your JWT refresh logic in auth.ts is not firing before the request.
   I'll fix it now."
```

---

## Source map de-minification (automatic)

Run the Mergen server from your frontend project root so it can find `.map`
files:

```bash
cd /path/to/your/frontend
node /path/to/Mergen/server/dist/index.js
```

Stack traces like `at app.bundle.js:1:48291` become:
```
at handleLogin (src/pages/Login.tsx:42:8)
```

If no `.map` file is found, the raw frame is stored with `[no sourcemap found]`.

---

## Security

- Ingest endpoint binds to `127.0.0.1` only — unreachable from outside
- No data is sent to any cloud service
- Optional shared-secret auth:

```bash
MERGEN_SECRET=mysecret node server/dist/index.js
```

Add the header in `extension/src/content.js` if you use this:
```js
headers: { 'Content-Type': 'application/json', 'x-mergen-secret': 'mysecret' }
```

---

## Verify everything works

```bash
# 1. Server running? Check health:
curl -s http://127.0.0.1:3000/health | python3 -m json.tool

# 2. Ingest a test event:
curl -s -X POST http://127.0.0.1:3000/ingest \
  -H 'Content-Type: application/json' \
  -d '{"type":"console","level":"error","args":["Mergen test"],"url":"http://test","timestamp":0}'

# 3. In your AI IDE, ask: "Get recent logs"
#    You should see the test error above.
```

---

## Rebuild after changes

```bash
# Server (TypeScript source)
cd server && npm run build

# Extension (plain JS, no build step)
# Edit extension/src/content.js, then in chrome://extensions → reload
```

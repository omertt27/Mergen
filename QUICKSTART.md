# Mergen Quick Start

> AI coding agents made writing code free. Mergen makes debugging it automatic.

Connect your AI IDE to live production telemetry in under 2 minutes. Once connected, ask *"Triage the api-service"* and get a causal chain with a fix command — not a log dump.

---

## Step 1: Install Server (30 seconds)

```bash
npx mergen-server@latest setup
```

This will:
- ✓ Check prerequisites (Node.js 18+)
- ✓ Detect your IDE (Claude Code, Cursor, VS Code, Windsurf)
- ✓ Configure MCP integration
- ✓ Validate installation

---

## Step 2: Install Extension (30 seconds)

### Option A: Chrome Web Store (Recommended)
Visit: [chrome.google.com/webstore/detail/mergen/xxx](https://chrome.google.com/webstore/detail/mergen/xxx)

Click "Add to Chrome" → Done!

### Option B: Manual Install
1. Open `chrome://extensions`
2. Enable "Developer mode" (top right toggle)
3. Click "Load unpacked"
4. Select the `extension/` folder

---

## Step 3: Start Server (10 seconds)

```bash
mergen-server start
```

You should see:
```
{"msg":"HTTP ingest listening on http://127.0.0.1:3000"}
{"msg":"MCP server ready (stdio transport)"}
```

---

## Step 4: Test It (30 seconds)

**In your browser:**
1. Open your dev app (e.g., localhost:5173)
2. Open DevTools → Console
3. Type: `console.error("Test error")`

**In your AI IDE:**
Ask your assistant:
```
Get recent logs
```

You should see your test error! 🎉

---

## What You Can Ask Your AI

```
"Get recent logs"                  → See console output
"Show network activity"            → View HTTP requests
"Why did that request fail?"       → Debug API errors
"What's in localStorage?"          → Check page state
"Show me all 401 errors"           → Find auth issues
"Explain this error"               → Get AI analysis
```

---

## Troubleshooting

### "mergen-server: command not found"
Use `npx mergen-server` instead of just `mergen-server`

### "Port 3000 already in use"
The server will try 3000-3010 automatically. Check what's running:
```bash
lsof -ti:3000 | xargs kill -9
```

### "Extension not capturing events"
1. Check extension is enabled in chrome://extensions
2. Restart browser after installing
3. Check server is running: `curl http://127.0.0.1:3000/health`

### "IDE not showing Mergen tools"
1. Restart your IDE after setup
2. Run: `mergen-server test`
3. Check IDE MCP settings (varies by IDE)

---

## Advanced Usage

### Visual Setup Wizard
Open in browser: `http://127.0.0.1:3000/setup`

### Run Tests
```bash
mergen-server test
```

### Run in Background
```bash
mergen-server start &
```

### Check for Updates
```bash
npx mergen-server@latest --version
```

---

## Alternative Install Methods

**Docker:**
```bash
docker-compose up
```

**Homebrew (macOS):**
```bash
brew tap omertt27/mergen
brew install mergen
```

**Binary (no Node.js):**
Download from: https://github.com/omertt27/Mergen/releases

---

## What's Happening?

```
Browser Tab
    ↓ (extension captures console, network, DOM)
Localhost Server (127.0.0.1:3000)
    ↓ (stores in ring buffer, 200 events)
MCP Tools (stdio)
    ↓ (Model Context Protocol)
AI IDE (Cursor/Claude/Copilot/etc)
```

**All data stays on your machine. Zero cloud.**

---

## Next Steps

- 📖 Read the full [documentation](README.md)
- 🔧 Check [INSTALL.md](INSTALL.md) for more install methods
- 🐛 Report issues: https://github.com/omertt27/Mergen/issues
- ⭐ Star the repo if you find it useful!

---

**Time to first working query: ~2 minutes**

**Questions?** Open an issue or check the [FAQ](README.md#faq)

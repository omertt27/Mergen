---
name: mergen-setup
description: Automated Mergen setup from scratch
---

# Mergen Setup Skill

Automated setup for Mergen installation. Use this when helping users install Mergen for the first time.

## Setup Flow

### 1. Detect IDE

Check which IDE the user has:

```bash
# Claude Code
which claude

# Cursor
ls ~/.cursor/

# VS Code
which code

# Windsurf
ls ~/.codeium/windsurf/
```

### 2. Choose Install Method

Recommend based on environment:

**Has Node.js 18+:**
```bash
npx mergen-server@latest setup
```
This is the easiest and most automated method.

**Has Docker:**
```bash
docker-compose up
```
Good for users who don't want to install Node.js.

**Mac users:**
```bash
brew tap omertt27/mergen
brew install mergen
```
(If Homebrew tap is published)

**No Node.js or Docker:**
Download pre-built binary from releases:
https://github.com/omertt27/Mergen/releases

### 3. Install Server

For NPM method:
```bash
npx mergen-server@latest setup
```

This will:
- ✓ Check prerequisites (Node.js 18+)
- ✓ Detect IDE automatically
- ✓ Configure MCP integration
- ✓ Validate installation

For manual setup:
```bash
git clone https://github.com/omertt27/Mergen.git
cd Mergen/server
npm install
npm run build
```

### 4. Configure IDE

The `setup` command handles this automatically, but manual steps:

**Claude Code:**
```bash
claude mcp add mergen --transport stdio -- node /absolute/path/to/Mergen/server/dist/index.js
claude mcp list  # verify
```

**Cursor:**
Create or edit `~/.cursor/mcp.json`:
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

**VS Code:**
Create or edit `.vscode/mcp.json` in project root:
```json
{
  "mcpServers": {
    "mergen": {
      "command": "node",
      "args": ["${workspaceFolder}/server/dist/index.js"]
    }
  }
}
```

**Windsurf:**
Create or edit `~/.codeium/windsurf/mcp_config.json`:
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

### 5. Install Browser Extension

**Option A: Chrome Web Store (when published)**
Visit Chrome Web Store and click "Add to Chrome"

**Option B: Manual install**
1. Open `chrome://extensions`
2. Enable "Developer mode" (toggle, top right)
3. Click "Load unpacked"
4. Select the `extension/` folder from repo

Extension should appear in toolbar with Mergen icon.

### 6. Start Server

```bash
# If installed via npm:
mergen-server start

# Or with npx:
npx mergen-server start

# Or from source:
cd server
npm start
```

Expected output:
```
{"msg":"HTTP ingest listening on http://127.0.0.1:3000"}
{"msg":"MCP server ready (stdio transport)"}
```

### 7. Validate Setup

**Test 1: Health check**
```bash
curl http://127.0.0.1:3000/health
```
Should return JSON with `status: "ok"`

**Test 2: Send test event**
```bash
curl -X POST http://127.0.0.1:3000/ingest \
  -H 'Content-Type: application/json' \
  -d '{
    "type": "console",
    "level": "error",
    "args": ["Setup test"],
    "url": "http://test",
    "timestamp": '$(date +%s000)'
  }'
```

**Test 3: Query from IDE**
In your AI IDE, ask: "Get recent logs"

Should see the "Setup test" error from step 2.

**Test 4: Live browser test**
1. Open any dev app in browser
2. Open DevTools → Console
3. Type: `console.error("Live test")`
4. In IDE, ask: "Get recent logs"
5. Should see "Live test" error

## Troubleshooting During Setup

### Node.js version too old

```bash
node --version
# If < 18.17, update from nodejs.org
```

### Port 3000 in use

Server tries ports 3000-3010 automatically. If needed:
```bash
lsof -ti:3000 | xargs kill -9
```

### npm permissions error

Don't use sudo! Instead:
```bash
mkdir ~/.npm-global
npm config set prefix '~/.npm-global'
echo 'export PATH=~/.npm-global/bin:$PATH' >> ~/.bashrc
source ~/.bashrc
```

### IDE not detecting Mergen

1. **Restart IDE** after config changes
2. Verify config file exists at correct path
3. Check paths are absolute (not relative)
4. For Claude Code: run `claude mcp list` to verify

### Extension not loading

1. Check Developer mode is ON in chrome://extensions
2. Check for errors in extension card
3. Reload extension (circular arrow icon)
4. Restart browser

## Post-Setup Tips

Once setup is working, show users:

1. **Common queries:**
   - "Get recent logs"
   - "Show network activity"
   - "Why did that request fail?"
   - "What's in localStorage?"

2. **Visual setup:**
   Open `http://127.0.0.1:3000/setup` in browser for web-based wizard

3. **Update checking:**
   Server automatically checks for updates once per day

4. **Documentation:**
   - Quick start: QUICKSTART.md
   - Full docs: README.md
   - Troubleshooting: TROUBLESHOOTING.md
   - FAQ: FAQ.md

## Success Criteria

Setup is complete when:
- ✅ Server starts without errors
- ✅ Health endpoint responds
- ✅ Browser extension is enabled
- ✅ IDE shows Mergen in MCP tools list
- ✅ AI can retrieve test events via "Get recent logs"
- ✅ Live browser events are captured and retrieved

Total time: ~2 minutes for automated install, ~5 minutes for manual.

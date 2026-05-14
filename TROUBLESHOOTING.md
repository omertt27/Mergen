# Troubleshooting Mergen

Common issues and solutions for Mergen installation and operation.

---

## 🚨 Quick Fixes

### Most Common Issues

| Problem | Quick Fix |
|---------|-----------|
| **"Command not found: mergen-server"** | Use `npx mergen-server` |
| **Port 3000 in use** | Server tries 3000-3010 automatically |
| **Extension not working** | Restart browser after installing |
| **IDE not showing tools** | Restart IDE after setup |
| **Server won't start** | Run `cd server && npm install && npm run build` |

---

## 📦 Installation Issues

### "Command not found: mergen-server"

**Cause:** Package not installed globally or npx not working.

**Solutions:**

1. **Use npx (recommended):**
   ```bash
   npx mergen-server@latest setup
   ```

2. **Or install globally:**
   ```bash
   npm install -g mergen-server
   mergen-server setup
   ```

3. **If npx fails:**
   ```bash
   # Check npm installation
   npm --version
   
   # Update npm
   npm install -g npm@latest
   ```

---

### "Port 3000 already in use"

**Cause:** Another service is using port 3000.

**Solutions:**

1. **Let Mergen use another port** (automatic):
   - Mergen tries ports 3000-3010
   - Check server output for actual port used

2. **Kill process on port 3000:**
   ```bash
   # macOS/Linux
   lsof -ti:3000 | xargs kill -9
   
   # Windows
   netstat -ano | findstr :3000
   taskkill /PID <PID> /F
   ```

3. **Find what's using it:**
   ```bash
   # macOS/Linux
   lsof -i:3000
   
   # Windows
   netstat -ano | findstr :3000
   ```

---

### "npm ERR! EACCES: permission denied"

**Cause:** npm trying to install globally without permissions.

**Solution (don't use sudo):**

```bash
# Create npm global directory
mkdir ~/.npm-global

# Configure npm to use it
npm config set prefix '~/.npm-global'

# Add to PATH
echo 'export PATH=~/.npm-global/bin:$PATH' >> ~/.bashrc
source ~/.bashrc

# Now install
npm install -g mergen-server
```

---

### "Node.js version too old"

**Cause:** Mergen requires Node.js 18.17+

**Solution:**

```bash
# Check current version
node --version

# If < 18.17, update from:
# https://nodejs.org/

# Or use nvm:
nvm install 20
nvm use 20
```

---

## 🖥️ Server Issues

### Server won't start

**Diagnostic steps:**

1. **Check Node.js version:**
   ```bash
   node --version
   # Must be >= 18.17
   ```

2. **Check if built:**
   ```bash
   ls server/dist/index.js
   # Should exist
   ```

3. **Check port availability:**
   ```bash
   lsof -i:3000
   # Should be empty or show mergen
   ```

**Solution:**

```bash
# Full rebuild
cd server
npm install
npm run build
npm start
```

---

### "Health check failed"

**Diagnostic:**

```bash
# Test health endpoint
curl http://127.0.0.1:3000/health

# Expected response:
# {"status":"ok","version":"1.0.0",...}
```

**If it fails:**

1. **Check server is running:**
   ```bash
   ps aux | grep mergen
   ```

2. **Check logs:**
   ```bash
   mergen-server start
   # Look for errors in output
   ```

3. **Try different port:**
   ```bash
   # Server tries 3000-3010 automatically
   curl http://127.0.0.1:3001/health
   curl http://127.0.0.1:3002/health
   ```

---

### Server crashes immediately

**Check logs for errors:**

```bash
mergen-server start 2>&1 | tee error.log
```

**Common causes:**

1. **Missing dependencies:**
   ```bash
   cd server && npm install
   ```

2. **TypeScript not compiled:**
   ```bash
   cd server && npm run build
   ```

3. **Permission issues:**
   ```bash
   # Check ~/.mergen/ permissions
   ls -la ~/.mergen/
   chmod 755 ~/.mergen/
   ```

---

## 🔌 Extension Issues

### Extension not capturing events

**Diagnostic steps:**

1. **Check extension is enabled:**
   - Open `chrome://extensions`
   - Find "Mergen"
   - Toggle should be **ON** (blue)
   - Developer mode should be **ON**

2. **Check server is running:**
   ```bash
   curl http://127.0.0.1:3000/health
   ```

3. **Check extension popup:**
   - Click Mergen icon in toolbar
   - Should show "Connected" (green)
   - Check port number matches server

4. **Test with manual event:**
   ```javascript
   // In browser DevTools console:
   console.error("Test error from Mergen")
   ```

**Solutions:**

1. **Restart browser:**
   - Close ALL browser windows
   - Reopen
   - Check extension again

2. **Reload extension:**
   - Go to `chrome://extensions`
   - Find Mergen
   - Click reload icon (circular arrow)

3. **Reinstall extension:**
   - Remove extension
   - Restart browser
   - Load unpacked again

---

### Extension icon is gray (disconnected)

**Cause:** Extension can't reach server.

**Solutions:**

1. **Start server:**
   ```bash
   mergen-server start
   ```

2. **Check port in extension:**
   - Click gray icon
   - Check port number
   - Change if needed (3000-3010)

3. **Check browser console:**
   - Right-click extension icon
   - Inspect popup
   - Look for errors in console

---

### Extension popup says "Wrong port"

**Solution:**

1. **Click the port dropdown**
2. **Try each port 3000-3010**
3. **Or check server output:**
   ```bash
   mergen-server start
   # Look for: "HTTP ingest listening on http://127.0.0.1:XXXX"
   ```

---

## 🤖 IDE Integration Issues

### IDE doesn't show Mergen tools

**General steps:**

1. **Restart IDE** (most common fix)
2. **Run validation:**
   ```bash
   mergen-server test
   ```
3. **Check IDE-specific config below**

---

### Cursor Issues

**Check configuration:**

```bash
# View config
cat ~/.cursor/mcp.json

# Should contain:
{
  "mcpServers": {
    "mergen": {
      "command": "node",
      "args": ["/absolute/path/to/Mergen/server/dist/index.js"]
    }
  }
}
```

**If missing, add manually:**

```bash
# Run setup
mergen-server setup
# Choose "Cursor" when prompted

# Or edit manually
nano ~/.cursor/mcp.json
```

**Restart Cursor after changes!**

**Verify:**
- Open Cursor
- Settings → Tools → MCP
- "mergen" should be listed

---

### Claude Code Issues

**Check configuration:**

```bash
# List servers
claude mcp list

# Should show "mergen"
```

**If missing:**

```bash
# Add manually
claude mcp add mergen --transport stdio -- node /path/to/Mergen/server/dist/index.js

# Verify
claude mcp list
```

**Test:**

Ask Claude: *"Get recent logs"*

---

### VS Code (Copilot) Issues

**Requirements:**
- VS Code 1.99+
- GitHub Copilot extension installed
- Agent mode enabled

**Check configuration:**

```bash
# Global config
cat ~/.vscode/mcp.json

# Project config (if using)
cat .vscode/mcp.json
```

**Enable Agent mode:**

1. Open Copilot Chat (`Ctrl/Cmd+Alt+I`)
2. Click robot icon (top right) → Enable Agent mode
3. Click tools button → Mergen tools should appear

**If not working:**

```bash
# Reinstall Copilot extension
code --uninstall-extension GitHub.copilot
code --install-extension GitHub.copilot

# Restart VS Code
```

---

### Windsurf Issues

**Check configuration:**

```bash
cat ~/.codeium/windsurf/mcp_config.json
```

**If missing:**

```bash
mergen-server setup
# Choose "Windsurf"
```

**Verify in Windsurf:**
- Open Cascade
- Click MCP Servers
- "mergen" should be listed

---

### MCP tools return empty results

**Causes:**
- Server just started (no events captured yet)
- Extension not sending events
- Buffer was cleared

**Solution:**

1. **Generate test events:**
   ```bash
   # Send test event
   curl -X POST http://127.0.0.1:3000/ingest \
     -H 'Content-Type: application/json' \
     -d '{
       "type": "console",
       "level": "error",
       "args": ["Test error"],
       "url": "http://test",
       "timestamp": '$(date +%s000)'
     }'
   ```

2. **Check browser is sending:**
   - Open browser dev app
   - Open DevTools → Network tab
   - Filter: `127.0.0.1`
   - Should see POSTs to `/ingest`

3. **Ask AI again:**
   ```
   "Get recent logs"
   ```

---

## ⚙️ Common Error Messages

### "TypeError: fetch is not defined"

**Cause:** Using Node.js < 18.0 (fetch not available)

**Solution:**

```bash
# Check version
node --version

# Update to Node 18.17+
# Download from: https://nodejs.org/

# Or use nvm
nvm install 20
nvm use 20
```

---

### "Cannot find module '@modelcontextprotocol/sdk'"

**Cause:** Dependencies not installed

**Solution:**

```bash
cd server
rm -rf node_modules package-lock.json
npm install
npm run build
```

---

### "ECONNREFUSED 127.0.0.1:3000"

**Cause:** Server not running

**Solution:**

```bash
# Start server
mergen-server start

# Or check if running
ps aux | grep mergen
curl http://127.0.0.1:3000/health
```

---

### "EADDRINUSE: address already in use"

**Cause:** Port already taken

**Solution:**

Server should automatically try next port. If not:

```bash
# Kill existing process
lsof -ti:3000 | xargs kill -9

# Restart server
mergen-server start
```

---

## 🐛 Performance Issues

### High CPU usage

**Diagnostic:**

```bash
# Check CPU usage
top -pid $(pgrep -f mergen)
```

**Causes:**
- Too many events per second (>1000/sec)
- Large request/response bodies
- Circular references in objects

**Solutions:**

1. **Check event rate:**
   ```bash
   # In browser console:
   console.count("test")
   # If counting very fast (>100/sec), that's the issue
   ```

2. **Clear buffer:**
   ```bash
   curl -X DELETE http://127.0.0.1:3000/clear
   ```

3. **Restart server:**
   ```bash
   mergen-server restart
   ```

---

### High memory usage

**Cause:** Buffer full of large events

**Check:**

```bash
# Monitor memory
top -pid $(pgrep -f mergen)
```

**Normal:**
- ~50-100 MB with empty buffer
- ~100-200 MB with full buffer (200 events)

**If > 500 MB:**

1. **Clear buffer:**
   ```bash
   curl -X DELETE http://127.0.0.1:3000/clear
   ```

2. **Restart server:**
   ```bash
   mergen-server restart
   ```

---

## 🧪 Testing & Validation

### Run full diagnostics

```bash
mergen-server test
```

**This checks:**
- ✓ Server binary exists
- ✓ Server starts successfully
- ✓ Health endpoint responds  
- ✓ Event ingestion works
- ✓ IDE configuration correct

**If any check fails, see specific section above.**

---

### Manual pipeline test

**Complete end-to-end test:**

```bash
# 1. Start server
mergen-server start &
SERVER_PID=$!

# 2. Wait for startup
sleep 2

# 3. Send test event
curl -X POST http://127.0.0.1:3000/ingest \
  -H 'Content-Type: application/json' \
  -d '{
    "type": "console",
    "level": "error",
    "args": ["Pipeline test"],
    "url": "http://test",
    "timestamp": '$(date +%s000)'
  }'

# 4. Verify event stored
curl -s http://127.0.0.1:3000/health | grep -q "Pipeline test" && echo "✓ Working" || echo "✗ Failed"

# 5. Clean up
kill $SERVER_PID
```

**In your AI IDE, ask:**
```
"Get recent logs"
```

**Should see:** "Pipeline test" error

---

## 🔍 Advanced Debugging

### Enable debug logging

```bash
# Set debug env var
DEBUG=mergen:* mergen-server start

# Or for verbose output
NODE_ENV=development mergen-server start
```

---

### Check server logs

```bash
# Real-time logs
mergen-server start | tee mergen.log

# View logs
tail -f mergen.log

# Search for errors
grep -i error mergen.log
```

---

### Inspect buffer state

```bash
# Get status
curl http://127.0.0.1:3000/health | jq

# Check buffer size
curl http://127.0.0.1:3000/health | jq '.bufferedEvents'

# Get recent events
curl http://127.0.0.1:3000/logs?limit=10 | jq
```

---

### Browser DevTools inspection

**Check extension is working:**

1. **Open DevTools** (F12)
2. **Go to Network tab**
3. **Filter:** `localhost` or `127.0.0.1`
4. **Trigger console.log:**
   ```javascript
   console.log("Test")
   ```
5. **Should see:** POST to `http://127.0.0.1:3000/ingest`

**Check request:**
- Status should be 200
- Request payload should contain your log

---

## 🆘 Still Stuck?

### Before asking for help:

1. **Run diagnostics:**
   ```bash
   mergen-server test
   ```

2. **Collect information:**
   ```bash
   # System info
   echo "OS: $(uname -s)"
   echo "Node: $(node --version)"
   echo "npm: $(npm --version)"
   
   # Check server
   curl http://127.0.0.1:3000/health
   
   # Check extension
   # Open chrome://extensions, screenshot Mergen card
   ```

3. **Check existing issues:**
   https://github.com/omertt27/Mergen/issues

---

### Get help:

**For bugs:**
Open an issue: https://github.com/omertt27/Mergen/issues/new

Include:
- OS and version
- Node.js version
- Mergen version
- IDE and version
- Browser and version
- Steps to reproduce
- Error messages
- Output of `mergen-server test`
- Screenshots if applicable

**For questions:**
Open a discussion: https://github.com/omertt27/Mergen/discussions

**Quick questions:**
Check [FAQ.md](FAQ.md) first!

---

## 📚 Related Docs

- [Installation Guide](INSTALL.md)
- [Quick Start](QUICKSTART.md)
- [FAQ](FAQ.md)
- [Contributing](CONTRIBUTING.md)

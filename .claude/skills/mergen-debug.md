---
name: mergen-debug
description: Debug Mergen server issues and validate setup
---

# Mergen Debug Skill

Use this skill when users report issues with Mergen installation or operation.

## Diagnostic Steps

Run these checks in order:

1. **Check Node version:**
   ```bash
   node --version
   ```
   Must be >=18.17

2. **Check server build:**
   ```bash
   ls server/dist/index.js
   ```
   If missing, needs build.

3. **Test health endpoint:**
   ```bash
   curl http://127.0.0.1:3000/health
   ```
   Should return JSON with status: "ok"

4. **Run validation:**
   ```bash
   cd server && npm test -- integration.test.ts
   ```

5. **Check IDE config:**
   - Cursor: `cat ~/.cursor/mcp.json`
   - VS Code: `cat ~/.vscode/mcp.json`
   - Windsurf: `cat ~/.codeium/windsurf/mcp_config.json`
   - Claude Code: `claude mcp list | grep mergen`

## Common Fixes

### Server won't start

```bash
cd server
npm install
npm run build
npm start
```

Check for errors in output. Common issues:
- Node version too old
- Port 3000-3010 all in use
- Missing dependencies

### Extension not working

1. Check chrome://extensions
2. Verify "Mergen" is enabled (blue toggle)
3. Reload extension (circular arrow icon)
4. Restart browser (close ALL windows)

Test capture:
```javascript
// In browser console:
console.error("Test error from Mergen")
```

Then in IDE: "Get recent logs" — should see the test error.

### MCP tools not appearing

1. **Restart IDE** (most common fix)
2. Verify config file exists and has correct path
3. Check server is running: `curl http://127.0.0.1:3000/health`
4. For Claude Code: `claude mcp list` should show "mergen"

### Extension icon is gray (disconnected)

1. Start server: `mergen-server start` or `npx mergen-server start`
2. Check port number in extension popup matches server output
3. Click extension icon → try ports 3000-3010 in dropdown

### Empty results from MCP tools

Server just started or buffer was cleared. Generate events:
```bash
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

Then ask: "Get recent logs"

## Advanced Debugging

### Enable debug logging

```bash
DEBUG=mergen:* mergen-server start
```

### Check buffer state

```bash
curl http://127.0.0.1:3000/health | jq
```

Look for:
- `bufferedEvents`: number of events in buffer
- `lastEventTimestamp`: when last event was received

### Inspect network traffic

In browser DevTools:
1. Open Network tab
2. Filter: `127.0.0.1` or `localhost`
3. Trigger console.log
4. Should see POST to `/ingest` with status 200

If POST fails:
- Check server is running
- Check port number matches
- Check for CORS errors (shouldn't happen on localhost)

## When to escalate

If these don't resolve the issue, gather this info and create a GitHub issue:
- OS and version
- Node.js version: `node --version`
- Mergen version: `npx mergen-server --version`
- IDE and version
- Browser and version
- Steps to reproduce
- Error messages
- Output of `mergen-server test` (if command exists)
- Screenshots if UI-related

GitHub Issues: https://github.com/omertt27/Mergen/issues

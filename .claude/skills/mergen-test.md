---
name: mergen-test
description: Test the complete Mergen pipeline end-to-end
---

# Mergen Test Skill

Test the entire Mergen pipeline from browser to AI IDE. Use this to validate the system is working correctly.

## Complete Pipeline Test

This tests: Browser → Extension → HTTP Ingest → Buffer → MCP Tools → AI

### 1. Prerequisites Check

```bash
# Check Node.js
node --version
# Must be >= 18.17

# Check server is built
ls server/dist/index.js
# Should exist

# Check extension is installed
# Open chrome://extensions
# Verify "Mergen" is enabled
```

### 2. Start Server

```bash
# From repo root:
cd server
npm start
```

Or if installed globally:
```bash
mergen-server start
```

Expected output:
```
{"msg":"HTTP ingest listening on http://127.0.0.1:3000"}
{"msg":"MCP server ready (stdio transport)"}
```

Note the port number (usually 3000, but may be 3001-3010).

### 3. Test HTTP Ingest

```bash
curl -s http://127.0.0.1:3000/health
```

Expected: JSON with `"status":"ok"`

### 4. Test Event Ingestion

```bash
curl -s -X POST http://127.0.0.1:3000/ingest \
  -H 'Content-Type: application/json' \
  -d '{
    "type": "console",
    "level": "error",
    "args": ["Pipeline test error"],
    "url": "http://test-page",
    "timestamp": '$(date +%s000)'
  }'
```

Expected: 200 OK response

### 5. Test Buffer Storage

Query buffer to verify event was stored:

```bash
curl -s http://127.0.0.1:3000/logs | grep "Pipeline test error"
```

Expected: Should find the test event

### 6. Test MCP Tools

In your AI IDE, ask:
```
Get recent logs
```

Expected: Should see "Pipeline test error" in the response

### 7. Test Live Browser Capture

1. Open any web page in browser
2. Open DevTools (F12)
3. Go to Console tab
4. Type: `console.error("Live browser test")`
5. In AI IDE, ask: "Get recent logs"

Expected: Should see "Live browser test" error

### 8. Test Network Capture

1. In browser console:
   ```javascript
   fetch('https://api.github.com/users/github')
     .then(r => r.json())
     .then(d => console.log('Fetched:', d.login))
   ```

2. In AI IDE, ask: "Show network activity"

Expected: Should see the GitHub API request with 200 status

### 9. Test Error Filtering

1. In browser console:
   ```javascript
   console.log("Info message");
   console.warn("Warning message");
   console.error("Error message");
   ```

2. In AI IDE, ask: "Get recent logs with level error"

Expected: Should see only "Error message", not info or warning

### 10. Test Time Filtering

1. Note current timestamp: `date +%s000`
2. In browser: `console.error("After timestamp test")`
3. In AI IDE: "Get logs since [timestamp]"

Expected: Should see only events after the timestamp

## Automated Test Suite

Run the complete test suite:

```bash
cd server
npm test
```

This runs:
- Unit tests (~70 tests)
- Integration tests (~30 tests)
- E2E system tests (~25 tests)
- Load/stress tests (~15 tests)

Expected: All tests pass (190+ tests)

### Run Specific Test Suites

```bash
# MCP tools only
npm test mcp-tools.test.ts

# Integration only
npm test integration.test.ts

# E2E only
npm test e2e-system.test.ts

# Load tests only
npm test load-stress.test.ts
```

## Performance Benchmarks

### Latency Test

```bash
# Send 100 events, measure avg response time
for i in {1..100}; do
  curl -w "%{time_total}\n" -o /dev/null -s \
    -X POST http://127.0.0.1:3000/ingest \
    -H 'Content-Type: application/json' \
    -d '{
      "type": "console",
      "level": "log",
      "args": ["Test '$i'"],
      "url": "http://test",
      "timestamp": '$(date +%s000)'
    }'
done
```

Expected: <10ms average latency

### Throughput Test

```bash
# 1000 concurrent requests
npm test -- load-stress.test.ts --grep "should handle 1000 concurrent requests"
```

Expected: 200-500 events/sec throughput, all succeed

### Memory Test

```bash
# Check memory before
ps aux | grep node | grep mergen

# Send 200 events (fill buffer)
for i in {1..200}; do
  curl -s -X POST http://127.0.0.1:3000/ingest \
    -H 'Content-Type: application/json' \
    -d '{"type":"console","level":"log","args":["Test"],"url":"http://test","timestamp":'$(date +%s000)'}'
done

# Check memory after
ps aux | grep node | grep mergen
```

Expected: Memory increase ~50-100MB for full buffer

## Extension-Specific Tests

### Test Console Capture

In browser DevTools console:
```javascript
console.log("Log test");
console.warn("Warn test");
console.error("Error test");
console.info("Info test");
```

In IDE: "Get recent logs"

Expected: All 4 messages captured with correct levels

### Test Network Capture

In browser console:
```javascript
// Test fetch
fetch('https://httpbin.org/status/200');
fetch('https://httpbin.org/status/404');
fetch('https://httpbin.org/status/500');
```

In IDE: "Show network activity"

Expected: All 3 requests captured with correct status codes

### Test Circular Reference Handling

In browser console:
```javascript
const obj = {};
obj.self = obj;
console.log("Circular:", obj);
```

In IDE: "Get recent logs"

Expected: Should see log without "[Circular]" error, data sanitized

### Test Large Payload Truncation

In browser console:
```javascript
const large = 'x'.repeat(10000);
console.log("Large payload:", large);
```

In IDE: "Get recent logs"

Expected: Payload truncated to reasonable size (8KB body max)

## IDE-Specific Validation

### Claude Code

```bash
# List tools
claude mcp list

# Should show "mergen"
```

Test: Ask Claude Code "Get recent logs"

### Cursor

Check config:
```bash
cat ~/.cursor/mcp.json | jq '.mcpServers.mergen'
```

Test: In Cursor Agent, ask "Show network activity"

### VS Code

1. Open Copilot Chat
2. Enable Agent mode (robot icon)
3. Click tools button
4. Verify "mergen" tools listed

Test: Ask Copilot "Get recent logs"

### Windsurf

Check config:
```bash
cat ~/.codeium/windsurf/mcp_config.json | jq '.mcpServers.mergen'
```

Test: In Cascade, ask "Show network activity"

## Failure Scenarios

Test error handling:

### Test Invalid JSON

```bash
curl -X POST http://127.0.0.1:3000/ingest \
  -H 'Content-Type: application/json' \
  -d 'invalid json'
```

Expected: 400 Bad Request

### Test Missing Required Fields

```bash
curl -X POST http://127.0.0.1:3000/ingest \
  -H 'Content-Type: application/json' \
  -d '{"type":"console"}'
```

Expected: 400 Bad Request (missing level, args, url, timestamp)

### Test Rate Limiting

```bash
# Send 1000 events rapidly
for i in {1..1000}; do
  curl -X POST http://127.0.0.1:3000/ingest \
    -H 'Content-Type: application/json' \
    -d '{"type":"console","level":"log","args":["Test"],"url":"http://test","timestamp":'$(date +%s000)'}' &
done
wait
```

Expected: All succeed (rate limiter allows bursts)

## Success Criteria

All tests pass when:
- ✅ Server starts and responds to health checks
- ✅ HTTP ingest accepts valid events
- ✅ Events are stored in buffer
- ✅ MCP tools return buffered events
- ✅ Browser console logs are captured
- ✅ Network requests are captured
- ✅ Circular references don't crash extension
- ✅ Large payloads are truncated
- ✅ Filters work (level, since)
- ✅ Performance meets benchmarks (<10ms latency, 200+ events/sec)
- ✅ All automated tests pass (190+ tests)

## Common Test Failures

### "Connection refused"
Server not running or wrong port. Start server first.

### "Empty results"
Buffer is empty. Generate events first or check extension is working.

### "Extension not capturing"
Extension not loaded or disabled. Check chrome://extensions.

### "MCP tools not found"
IDE config missing or incorrect. Verify config file and restart IDE.

### Test suite hangs
HTTP tests conflict with parallel execution. Run with `--no-threads`:
```bash
npm test -- --no-threads
```

## Reporting Test Results

When reporting issues, include:
- Output of health check: `curl http://127.0.0.1:3000/health`
- Test results: `npm test` output
- Browser console errors
- Server logs
- Extension status (chrome://extensions)
- IDE MCP config location and contents

# Mergen MCP Tools Reference

Complete reference for the Model Context Protocol (MCP) tools provided by Mergen.

---

## Overview

Mergen exposes 4 MCP tools that AI assistants can call to retrieve browser telemetry:

| Tool | Purpose |
|------|---------|
| `get_recent_logs` | Retrieve console logs (console.log, .warn, .error) |
| `get_network_activity` | Retrieve network requests (fetch, XMLHttpRequest) |
| `get_context` | Get current page state (localStorage, activeElement, etc) |
| `clear_buffer` | Clear all buffered events |

---

## Tool: `get_recent_logs`

Retrieve console logs from the browser.

### Parameters

All parameters are optional:

```typescript
{
  limit?: number,      // Max events to return (1-200, default: 50)
  level?: string,      // Filter by level: "log" | "info" | "warn" | "error"
  since?: number       // Unix timestamp (ms), events after this time
}
```

### Return Value

```typescript
{
  events: Array<{
    type: "console",
    level: "log" | "info" | "warn" | "error",
    args: Array<any>,           // The logged values
    url: string,                // Page URL
    timestamp: number           // Unix ms
  }>,
  count: number,                // Events returned
  total: number                 // Total matching events in buffer
}
```

### Examples

**Get all recent logs:**
```typescript
// AI calls:
get_recent_logs({})

// Returns:
{
  events: [
    { type: "console", level: "log", args: ["User logged in"], url: "...", timestamp: 1715702400000 },
    { type: "console", level: "error", args: ["API error", {code: 500}], url: "...", timestamp: 1715702401000 }
  ],
  count: 2,
  total: 42
}
```

**Get only errors:**
```typescript
get_recent_logs({ level: "error" })
```

**Get last 10 logs:**
```typescript
get_recent_logs({ limit: 10 })
```

**Get logs since timestamp:**
```typescript
// User: "I just clicked Login, what happened?"
// AI saves timestamp, then asks:
get_recent_logs({ since: 1715702400000 })
```

### Use Cases

- **Debug errors:** "Why did my app crash?"
- **Trace flow:** "What happened when I clicked Submit?"
- **Find warnings:** "Are there any React warnings?"
- **Timeline analysis:** "What logged between 2pm and 3pm?"

---

## Tool: `get_network_activity`

Retrieve network requests made by the browser.

### Parameters

All parameters are optional:

```typescript
{
  limit?: number,        // Max events to return (1-200, default: 50)
  status_filter?: number,// Filter by HTTP status (e.g., 404, 500)
  since?: number         // Unix timestamp (ms), events after this time
}
```

### Return Value

```typescript
{
  events: Array<{
    type: "network",
    method: string,              // GET, POST, etc
    url: string,                 // Request URL
    status: number,              // HTTP status code
    duration: number,            // Request duration (ms)
    requestHeaders?: object,     // Request headers
    responseHeaders?: object,    // Response headers
    requestBody?: string,        // Request body (max 8KB)
    responseBody?: string,       // Response body (max 8KB)
    timestamp: number            // Unix ms
  }>,
  count: number,
  total: number
}
```

### Examples

**Get all network activity:**
```typescript
get_network_activity({})
```

**Get failed requests:**
```typescript
get_network_activity({ status_filter: 500 })
```

**Get 404 errors:**
```typescript
get_network_activity({ status_filter: 404 })
```

**Get recent API calls:**
```typescript
get_network_activity({ limit: 20, since: 1715702400000 })
```

### Use Cases

- **Debug API errors:** "Why did that request fail?"
- **Find 401s:** "Show me all unauthorized requests"
- **Performance:** "Which API call is slowest?"
- **Trace requests:** "What APIs were called when I clicked X?"

---

## Tool: `get_context`

Get current page state snapshot.

### Parameters

None.

### Return Value

```typescript
{
  type: "context",
  url: string,                           // Current page URL
  title?: string,                        // Page title
  activeElement?: string,                // Focused element tag name
  localStorage?: Record<string, string>, // localStorage contents
  sessionStorage?: Record<string, string>,// sessionStorage contents
  timestamp: number                      // Unix ms
}
```

Returns `null` if no context snapshot has been captured yet.

### Examples

**Get current page state:**
```typescript
// AI calls:
get_context()

// Returns:
{
  type: "context",
  url: "https://example.com/dashboard",
  title: "Dashboard - Example App",
  activeElement: "INPUT",
  localStorage: {
    theme: "dark",
    userId: "123"
  },
  sessionStorage: {
    sessionId: "abc-def-ghi"
  },
  timestamp: 1715702400000
}
```

### Use Cases

- **Check state:** "What's in localStorage?"
- **Debug focus:** "What element has focus?"
- **Session info:** "What's my session ID?"
- **Environment:** "What page am I on?"

---

## Tool: `clear_buffer`

Clear all events from the buffer.

### Parameters

None.

### Return Value

```typescript
{
  cleared: number  // Number of events removed
}
```

### Examples

**Clear buffer:**
```typescript
// User: "Clear the logs"
// AI calls:
clear_buffer()

// Returns:
{ cleared: 42 }
```

### Use Cases

- **Start fresh:** Before reproducing a bug
- **Privacy:** Clear captured data
- **Testing:** Reset state between tests

---

## Common Patterns

### 1. Capture Timestamp, Then Filter

Best for reproducing bugs:

```typescript
// User: "Let me reproduce the issue..."
const before = Date.now();

// User reproduces bug...

// AI calls:
get_recent_logs({ since: before })
get_network_activity({ since: before })
```

### 2. Multi-Tool Investigation

Combine tools for complete picture:

```typescript
// User: "Why did login fail?"

// AI calls:
const logs = get_recent_logs({ level: "error" });
const network = get_network_activity({ status_filter: 401 });
const context = get_context();

// AI analyzes all three:
// "Your login failed because the JWT in localStorage is expired.
//  The POST /api/auth returned 401, and console shows 'Token expired'."
```

### 3. Progressive Filtering

Start broad, then narrow:

```typescript
// 1. Get all logs
const all = get_recent_logs({ limit: 200 });

// 2. If too many, filter to errors
const errors = get_recent_logs({ level: "error" });

// 3. If still too many, use timestamp
const recent = get_recent_logs({ level: "error", since: recentTimestamp });
```

---

## Limitations

### Buffer Size

- **Capacity:** 200 events total
- **Eviction:** Oldest events removed first (errors kept longer)
- **Persistence:** In-memory only (cleared on server restart)

**Impact:** Very old events may not be available. For long sessions, consider clearing buffer before reproducing bugs.

### Body Truncation

- **Request/response bodies:** Max 8KB each
- **Logged objects:** Large objects may be truncated

**Impact:** Very large payloads are abbreviated with `[truncated]`.

### Event Types

Only captures:
- Console logs (console.log, .warn, .error, .info)
- Network requests (fetch, XMLHttpRequest)
- Context snapshots (on-demand)

**Not captured:**
- WebSocket messages
- Server-sent events (SSE)
- Service worker activity
- Browser devtools-specific events

---

## Error Handling

### Empty Results

```typescript
get_recent_logs({})
// Returns: { events: [], count: 0, total: 0 }
```

**Causes:**
- Server just started (no events captured yet)
- Buffer was cleared
- Extension not sending events

### Invalid Parameters

```typescript
get_recent_logs({ limit: 999 })
// Error: "limit must be between 1 and 200"

get_recent_logs({ level: "invalid" })
// Error: "level must be one of: log, info, warn, error"
```

### Server Not Running

If the Mergen server is not running, MCP tool calls will fail with connection error.

**Fix:** Start server with `mergen-server start`

---

## Performance

### Latency

- **get_recent_logs:** <5ms for 50 events
- **get_network_activity:** <5ms for 50 events
- **get_context:** <2ms
- **clear_buffer:** <2ms

### Memory

- **Buffer:** ~50-100MB for 200 events
- **Per event:** ~200KB average

### Throughput

- **Ingestion:** 200-500 events/sec
- **Queries:** 1000+ queries/sec

---

## IDE-Specific Usage

### Claude Code

```typescript
// User asks:
"Get recent logs"

// Claude automatically calls:
get_recent_logs({ limit: 50 })
```

### Cursor

```typescript
// User asks:
"Why did that request fail?"

// Cursor Agent calls:
get_recent_logs({ level: "error" })
get_network_activity({ status_filter: 500 })
```

### VS Code (Copilot)

```typescript
// User asks:
"Show network activity"

// Copilot calls:
get_network_activity({ limit: 50 })
```

### Windsurf

```typescript
// User asks in Cascade:
"What's in localStorage?"

// Cascade calls:
get_context()
```

---

## Integration Examples

### Example 1: Debug Login Flow

```typescript
// User: "I clicked Login and got an error. What happened?"

// AI workflow:
const logs = await get_recent_logs({ level: "error", limit: 10 });
const network = await get_network_activity({ limit: 10 });
const context = await get_context();

// AI analysis:
// "Your login failed:
//  1. POST /api/auth → 401 Unauthorized (342ms)
//  2. console.error: 'Invalid credentials'
//  3. localStorage shows no auth token
//  Likely cause: Wrong password or account locked."
```

### Example 2: Performance Investigation

```typescript
// User: "Why is my app slow?"

// AI workflow:
const network = await get_network_activity({ limit: 50 });

// AI finds:
// "3 slow requests found:
//  - GET /api/products → 200 (4523ms) ⚠️
//  - GET /api/images/hero.jpg → 200 (2891ms)
//  - POST /api/analytics → 200 (1204ms)
//  Recommendation: Add pagination to /api/products"
```

### Example 3: Trace User Action

```typescript
// User: "I clicked Submit 30 seconds ago. Trace what happened."

// AI workflow:
const timestamp = Date.now() - 30000;
const logs = await get_recent_logs({ since: timestamp });
const network = await get_network_activity({ since: timestamp });

// AI builds timeline:
// "Timeline:
//  12:00:00 - console.log: 'Form validation passed'
//  12:00:01 - POST /api/submit → 200 (856ms)
//  12:00:02 - console.log: 'Success, redirecting...'
//  12:00:02 - GET /success → 200 (123ms)"
```

---

## Best Practices

### For AI Assistants

1. **Start with errors:** Check `get_recent_logs({ level: "error" })` first
2. **Use timestamps:** When user reproduces bug, filter with `since`
3. **Combine tools:** Use multiple tools for complete picture
4. **Explain findings:** Don't just dump data, analyze and summarize
5. **Suggest fixes:** After diagnosing, propose solutions

### For Users

1. **Be specific:** "Get logs from last 5 minutes" is better than "Get logs"
2. **Clear before repro:** Ask AI to clear buffer before reproducing bugs
3. **Provide context:** "I clicked X and Y happened" helps AI filter
4. **Ask follow-ups:** If AI's answer unclear, ask for more detail

---

## Debugging Tool Issues

### Tools not appearing in IDE

1. Restart IDE after setup
2. Check MCP config file exists
3. Verify server is running: `curl http://127.0.0.1:3000/health`

### Empty results

1. Check server is running
2. Check extension is enabled (chrome://extensions)
3. Generate test event: `console.error("Test")`
4. Query again: "Get recent logs"

### Incorrect results

1. Check timestamp filters (unix ms, not seconds)
2. Verify level filter spelling ("error" not "errors")
3. Check limit is reasonable (1-200)

---

## See Also

- [HTTP API Reference](API.md) - Underlying HTTP endpoints
- [Browser Extension](extension/README.md) - Event capture
- [QUICKSTART.md](QUICKSTART.md) - Setup guide
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) - Common issues

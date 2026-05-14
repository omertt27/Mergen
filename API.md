# Mergen HTTP API Reference

Complete reference for the Mergen HTTP server API.

---

## Base URL

```
http://127.0.0.1:3000
```

The server tries ports 3000-3010 and uses the first available port.

---

## Endpoints

### Health Check

**GET** `/health`

Check if the server is running and get status information.

**Response:**
```json
{
  "status": "ok",
  "version": "1.0.0",
  "bufferedEvents": 42,
  "lastEventTimestamp": 1715702400000,
  "uptime": 3600
}
```

**Fields:**
- `status` - Always "ok" if server is running
- `version` - Server version
- `bufferedEvents` - Number of events in buffer (0-200)
- `lastEventTimestamp` - Unix timestamp (ms) of most recent event, or null
- `uptime` - Server uptime in seconds

**Status:** 200 OK

---

### Ingest Event

**POST** `/ingest`

Ingest a telemetry event from the browser extension.

**Headers:**
```
Content-Type: application/json
```

Optional auth (if `MERGEN_SECRET` env var is set):
```
x-mergen-secret: <secret>
```

**Request Body:**

Console event:
```json
{
  "type": "console",
  "level": "error",
  "args": ["Error message", {"details": "object"}],
  "url": "https://example.com/page",
  "timestamp": 1715702400000
}
```

Network event:
```json
{
  "type": "network",
  "method": "POST",
  "url": "https://api.example.com/endpoint",
  "status": 200,
  "duration": 342,
  "requestHeaders": {"content-type": "application/json"},
  "responseHeaders": {"content-type": "application/json"},
  "requestBody": "{\"key\":\"value\"}",
  "responseBody": "{\"result\":\"success\"}",
  "timestamp": 1715702400000
}
```

Context snapshot:
```json
{
  "type": "context",
  "url": "https://example.com/page",
  "title": "Page Title",
  "activeElement": "INPUT",
  "localStorage": {"key": "value"},
  "sessionStorage": {"key": "value"},
  "timestamp": 1715702400000
}
```

**Required Fields (all event types):**
- `type` - Event type: "console", "network", or "context"
- `timestamp` - Unix timestamp in milliseconds
- `url` - Page URL where event occurred

**Console Event Fields:**
- `level` - Log level: "log", "info", "warn", "error"
- `args` - Array of logged values (any JSON-serializable type)

**Network Event Fields:**
- `method` - HTTP method: "GET", "POST", etc.
- `status` - HTTP status code (number)
- `duration` - Request duration in milliseconds (number)
- `requestHeaders` - Object of request headers (optional)
- `responseHeaders` - Object of response headers (optional)
- `requestBody` - Request body as string (optional, max 8KB)
- `responseBody` - Response body as string (optional, max 8KB)

**Context Event Fields:**
- `title` - Page title (optional)
- `activeElement` - Tag name of focused element (optional)
- `localStorage` - localStorage key-value pairs (optional)
- `sessionStorage` - sessionStorage key-value pairs (optional)

**Response:**
```json
{"ok": true}
```

**Status:** 200 OK

**Error Responses:**

400 Bad Request:
```json
{
  "error": "Validation error",
  "details": "Invalid event type"
}
```

401 Unauthorized (if using `MERGEN_SECRET`):
```json
{
  "error": "Unauthorized"
}
```

413 Payload Too Large (body > 1MB):
```json
{
  "error": "Payload too large"
}
```

---

### Get Logs

**GET** `/logs`

Retrieve console events from the buffer.

**Query Parameters:**
- `limit` - Max events to return (1-200, default: 50)
- `level` - Filter by log level: "log", "info", "warn", "error"
- `since` - Unix timestamp (ms), return only events after this time

**Examples:**
```bash
# Get last 50 logs
GET /logs

# Get last 10 error logs
GET /logs?limit=10&level=error

# Get logs since timestamp
GET /logs?since=1715702400000
```

**Response:**
```json
{
  "events": [
    {
      "type": "console",
      "level": "error",
      "args": ["Error message"],
      "url": "https://example.com",
      "timestamp": 1715702400000
    }
  ],
  "count": 1,
  "total": 42
}
```

**Fields:**
- `events` - Array of console events
- `count` - Number of events returned
- `total` - Total events in buffer matching filters

**Status:** 200 OK

---

### Get Network Activity

**GET** `/network`

Retrieve network events from the buffer.

**Query Parameters:**
- `limit` - Max events to return (1-200, default: 50)
- `status` - Filter by HTTP status code (e.g., 404, 500)
- `since` - Unix timestamp (ms), return only events after this time

**Examples:**
```bash
# Get last 50 network events
GET /network

# Get failed requests
GET /network?status=500

# Get recent 404s
GET /network?status=404&limit=10
```

**Response:**
```json
{
  "events": [
    {
      "type": "network",
      "method": "GET",
      "url": "https://api.example.com/data",
      "status": 200,
      "duration": 342,
      "timestamp": 1715702400000
    }
  ],
  "count": 1,
  "total": 12
}
```

**Status:** 200 OK

---

### Get Context

**GET** `/context`

Retrieve the most recent context snapshot (page state, localStorage, etc).

**Response:**
```json
{
  "type": "context",
  "url": "https://example.com/page",
  "title": "Page Title",
  "activeElement": "INPUT",
  "localStorage": {"theme": "dark"},
  "sessionStorage": {"sessionId": "abc123"},
  "timestamp": 1715702400000
}
```

**Status:** 200 OK

Returns 404 if no context snapshot exists.

---

### Clear Buffer

**DELETE** `/clear`

Clear all events from the buffer.

**Response:**
```json
{"ok": true, "cleared": 42}
```

**Fields:**
- `ok` - Always true
- `cleared` - Number of events removed

**Status:** 200 OK

---

### Setup UI

**GET** `/setup`

Web-based setup wizard (HTML page).

Returns an interactive setup interface for configuring Mergen.

**Status:** 200 OK

---

## Rate Limiting

The server implements basic rate limiting:
- **Burst:** Up to 100 requests in rapid succession
- **Sustained:** ~1000 requests per second

Exceeding limits returns:
```json
{
  "error": "Rate limit exceeded"
}
```

**Status:** 429 Too Many Requests

---

## Authentication

Optional shared-secret authentication:

```bash
# Start server with secret:
MERGEN_SECRET=mysecret mergen-server start

# All requests must include:
x-mergen-secret: mysecret
```

Without the header, requests return 401 Unauthorized.

**Not recommended for production** - use firewall rules instead since server should only be accessible on localhost.

---

## CORS

CORS is **enabled** with `Access-Control-Allow-Origin: *` to allow browser extensions to send events from any page.

Since the server binds to 127.0.0.1 only, this is safe (not reachable from internet).

---

## Error Handling

All errors return JSON:

```json
{
  "error": "Human-readable error message",
  "details": "Additional context (optional)"
}
```

**Common Status Codes:**
- `200` - Success
- `400` - Bad Request (validation error)
- `401` - Unauthorized (bad secret)
- `404` - Not Found
- `413` - Payload Too Large
- `429` - Rate Limit Exceeded
- `500` - Internal Server Error

---

## Event Validation

### Console Events

```typescript
{
  type: "console",
  level: "log" | "info" | "warn" | "error",  // required
  args: Array<any>,                           // required, JSON-serializable
  url: string,                                // required
  timestamp: number                           // required, unix ms
}
```

### Network Events

```typescript
{
  type: "network",
  method: string,                    // required (GET, POST, etc)
  url: string,                       // required
  status: number,                    // required (HTTP status code)
  duration: number,                  // required (milliseconds)
  requestHeaders?: Record<string, string>,
  responseHeaders?: Record<string, string>,
  requestBody?: string,              // max 8KB
  responseBody?: string,             // max 8KB
  timestamp: number                  // required, unix ms
}
```

### Context Events

```typescript
{
  type: "context",
  url: string,                       // required
  title?: string,
  activeElement?: string,            // tag name (INPUT, BUTTON, etc)
  localStorage?: Record<string, string>,
  sessionStorage?: Record<string, string>,
  timestamp: number                  // required, unix ms
}
```

---

## Buffer Behavior

- **Capacity:** 200 events
- **Eviction:** Priority-based (errors kept longer than info logs)
- **Storage:** In-memory only (cleared on restart)
- **Ordering:** Events returned oldest → newest

Priority levels:
1. Errors (console.error, HTTP 4xx/5xx) - kept longest
2. Warnings (console.warn)
3. Network events (fetch, XHR)
4. Info logs (console.log, console.info) - evicted first

---

## Examples

### Full Pipeline Test

```bash
# 1. Check health
curl http://127.0.0.1:3000/health

# 2. Send console error
curl -X POST http://127.0.0.1:3000/ingest \
  -H 'Content-Type: application/json' \
  -d '{
    "type": "console",
    "level": "error",
    "args": ["Test error"],
    "url": "http://test",
    "timestamp": '$(date +%s000)'
  }'

# 3. Retrieve logs
curl http://127.0.0.1:3000/logs

# 4. Clear buffer
curl -X DELETE http://127.0.0.1:3000/clear
```

### Get Recent Errors Only

```bash
curl 'http://127.0.0.1:3000/logs?level=error&limit=10'
```

### Get Failed Network Requests

```bash
curl 'http://127.0.0.1:3000/network?status=500'
```

### Get Events Since Timestamp

```bash
# Save current time
SINCE=$(date +%s000)

# ... reproduce bug ...

# Get events since saved time
curl "http://127.0.0.1:3000/logs?since=$SINCE"
```

---

## Client Libraries

### JavaScript (Browser Extension)

```javascript
// Send console event
await fetch('http://127.0.0.1:3000/ingest', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    type: 'console',
    level: 'error',
    args: ['Error message'],
    url: window.location.href,
    timestamp: Date.now()
  })
});
```

### Node.js (Testing)

```javascript
const response = await fetch('http://127.0.0.1:3000/ingest', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    type: 'console',
    level: 'error',
    args: ['Test error'],
    url: 'http://test',
    timestamp: Date.now()
  })
});

console.assert(response.ok);
```

---

## See Also

- [MCP Tools Reference](MCP_TOOLS.md) - AI IDE integration
- [Browser Extension](extension/README.md) - Event capture implementation
- [Troubleshooting](TROUBLESHOOTING.md) - Common API issues

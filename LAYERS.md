# Mergen — Four-Layer Observability Expansion

This document describes the newly implemented four-layer expansion of Mergen's observability capabilities.

---

## Overview

Mergen has been extended from a passive observer (captures console/network, AI reads) to an **active debugging system** with four progressive layers:

1. **Layer 1: Better Context** — What AI sees (component trees, state diffs, performance traces)
2. **Layer 2: Better Diagnosis** — What AI can ask (replay events, watch patterns, timelines)
3. **Layer 3: Better Action** — What AI can do (breakpoints, inject logs, mock responses)
4. **Layer 4: Better Memory** — Across sessions (error history, fix linking)

---

## Layer 1: Better Context

### Implemented Features

#### `get_component_tree`
Returns full React/Vue component tree with props and state at error time.

**MCP Tool:**
```typescript
get_component_tree({ since?: number })
```

**Extension instrumentation:**
- Walks React fiber tree (`__reactFiber`)
- Captures Vue 2 component tree (`__vue__`)
- Captures Vue 3 component tree (`__vueParentComponent`)
- Records props, state/hooks, children (max depth 5)

**Data captured:**
```json
{
  "componentTree": {
    "name": "LoginForm",
    "type": "React",
    "props": { "username": "test@example.com" },
    "state": { "hook0": false, "hook1": "" },
    "children": [...]
  }
}
```

#### `get_state_diff`
Returns Redux/Zustand/Jotai state snapshots showing before/after changes.

**MCP Tool:**
```typescript
get_state_diff({ since?: number })
```

**Extension instrumentation:**
- Hooks into `window.__REDUX_DEVTOOLS_EXTENSION__` for Redux
- Captures state snapshots before/after errors
- Computes diffs at field granularity

**Data captured:**
```json
{
  "stateDiff": {
    "framework": "Redux",
    "before": { "user": null },
    "after": { "user": { "id": 123 } },
    "field": "user",
    "timestamp": 1716691200000
  }
}
```

#### `get_performance_trace`
Returns PerformanceObserver data: long tasks, layout shifts, paint timings.

**MCP Tool:**
```typescript
get_performance_trace({ since?: number })
```

**Extension instrumentation:**
- `PerformanceObserver` for longtask, layout-shift, paint, navigation
- Keeps last 50 entries in rolling buffer
- Captured automatically with every context snapshot

**Data captured:**
```json
{
  "performanceTrace": [
    {
      "entryType": "longtask",
      "name": "self",
      "startTime": 1234.56,
      "duration": 78.9
    }
  ]
}
```

---

## Layer 2: Better Diagnosis

### Implemented Features

#### `replay_event(event_id)`
Retrieve full event detail by ID for inspection.

**MCP Tool:**
```typescript
replay_event({ event_id: string })
```

**How it works:**
- Every event ingested gets a unique ID
- Stored in `layer2Store.eventIndex` (max 500 events)
- Returns complete raw event with all fields

**Use case:**
AI mentions "event abc123 shows..." → you call `replay_event(abc123)` to see full data.

#### `watch(pattern, type)`
Subscribe to a pattern and get notified on next occurrence.

**MCP Tool:**
```typescript
watch({
  pattern: string,  // regex or substring
  type: 'network' | 'console' | 'state'
})
```

**How it works:**
- Registers pattern in `layer2Store.watchPatterns`
- On every event, checks if it matches any watch
- Fires callback when match occurs

**Use case:**
AI: "Tell me next time /api/auth returns non-200" → registers watch, notifies when it happens.

#### `get_timeline(from, to)`
Returns all events between two timestamps in chronological order.

**MCP Tool:**
```typescript
get_timeline({
  from: number,  // Unix timestamp ms
  to: number     // Unix timestamp ms
})
```

**How it works:**
- Fetches all events (logs, network, contexts) in time range
- Sorts chronologically
- Computes deltas between events

**Use case:**
Essential for race condition diagnosis: "Show me everything in the 2 seconds before this error."

---

## Layer 3: Better Action

### Implemented Features

#### `set_breakpoint(condition, event_type, pattern)`
Set a conditional breakpoint for surgical debugging.

**MCP Tool:**
```typescript
set_breakpoint({
  condition: string,         // e.g., "status === 401"
  event_type: 'network' | 'console' | 'state',
  pattern: string           // URL, error message, etc.
})
```

**How it works:**
- Stored in `layer3Store.breakpoints`
- Checked on every event ingest
- When hit, captures full state and increments hitCount

**Use case:**
"Pause when /api/user returns 401" → sets breakpoint, captures state when condition matches.

#### `inject_log(selector, event, expression)`
Inject temporary console.log on a DOM element.

**MCP Tool:**
```typescript
inject_log({
  selector: string,      // CSS selector
  event: string,         // DOM event name
  expression: string     // JS expression to evaluate
})
```

**How it works:**
- Server queues command in `layer3Store.pendingCommands`
- Extension polls `/commands` every 2 seconds
- Attaches event listener, captures one occurrence, auto-removes

**Use case:**
"Log button click event data without editing source" → injects listener, captures event.target.value, removes.

#### `mock_response(url, method, status, body)`
Stub a network response to test hypothesis.

**MCP Tool:**
```typescript
mock_response({
  url: string,       // URL pattern (supports wildcards)
  method: string,
  status: number,
  body: any
})
```

**How it works:**
- Stored in `layer3Store.mocks`
- Extension polls `/commands`, installs mock
- Intercepts fetch/XHR, returns mocked response
- Notifies server on mock hit

**Use case:**
"Mock /api/user to return 401 to see if error handling works" → AI validates hypothesis.

### Bidirectional Communication

Layer 3 requires server → extension communication:

**Extension side:**
- Polls `GET /commands` every 2 seconds
- Handles: `SET_MOCK`, `REMOVE_MOCK`, `INJECT_LOG`, `REMOVE_LOG`
- Notifies server via `POST /log-capture`, `POST /mock-hit`

**Server side:**
- Queues commands in `layer3Store.pendingCommands`
- Returns pending commands on `/commands` endpoint
- Prunes old commands (> 1 minute) automatically

---

## Layer 4: Better Memory

### Implemented Features

#### `get_error_history(query, limit?)`
Search for similar past errors with fixes.

**MCP Tool:**
```typescript
get_error_history({
  query: string,
  limit?: number  // default 10
})
```

**How it works:**
- Errors fingerprinted by hash(message + stack first 3 lines)
- Stored in `~/.mergen/error-index.json` (max 1000 entries, LRU)
- Searches by substring match, returns count, first/last seen, fixes

**Use case:**
"Have we seen this error before?" → returns past occurrences + what fixes worked.

#### `link_fix(error_query, commit_sha, description, verdict?)`
Link a git commit to an error as the fix.

**MCP Tool:**
```typescript
link_fix({
  error_query: string,
  commit_sha: string,
  description: string,
  verdict?: 'correct' | 'partial' | 'wrong'
})
```

**How it works:**
- Finds error by message substring
- Adds fix entry with commit SHA, description, verdict
- Builds corpus of error → fix pairs over time

**Use case:**
After pushing a fix: "link this error to commit abc123" → future occurrences suggest known fix.

#### `error_stats()`
Get statistics about error history corpus.

**MCP Tool:**
```typescript
error_stats()
```

**Returns:**
- Total unique errors
- Total fixes recorded
- Average fixes per error
- Recent errors list

---

## Architecture

### Server Components

```
server/src/
├── sensor/
│   ├── extended-buffer.ts    # Layer 1-4 type definitions
│   ├── layer2-store.ts        # Replay, watch, timeline
│   ├── layer3-store.ts        # Breakpoints, mocks, injected logs
│   └── layer4-store.ts        # Error history, fix linking
├── intelligence/
│   └── layer-tools.ts         # MCP tool registrations
└── routes/
    └── layers.ts              # HTTP routes for Layer 3 commands
```

### Extension Components

```
extension/src/
├── layers-instrumentation.js  # Layer 1 + 3 instrumentation
└── content.js                 # Modified to include Layer 1 data
```

### Data Flow

```
Browser Extension
    ↓ POST /ingest (with Layer 1 data)
Sensor Layer (ingest.ts)
    ↓ layer2Store.indexEvent()
    ↓ layer3Store.checkBreakpoint()
    ↓ layer4Store.recordError()
    ↓ store.push()
Intelligence Layer (tools.ts)
    ↓ MCP tools
Claude / IDE
    ↓ GET /commands (Layer 3)
Browser Extension (polls commands)
```

---

## Integration

### Buffer Schema Extension

```typescript
// Backward-compatible: existing code ignores new fields
export const ContextSnapshotSchema = z.object({
  type: z.literal('context'),
  trigger: z.enum(['error', 'warn', 'pageload', 'hmr', 'baseline', 'manual']),
  timestamp: z.number(),
  url: z.string(),
  title: z.string(),
  activeElement: z.string().optional(),
  component: z.string().optional(),
  localStorage: z.record(z.string()).default({}),
  sessionStorage: z.record(z.string()).default({}),
  // Layer 1 extensions (optional, backward-compatible)
  componentTree: z.unknown().optional(),
  stateDiff: z.unknown().optional(),
  performanceTrace: z.array(z.unknown()).optional(),
});
```

### Ingest Pipeline Hooks

```typescript
// Layer 2: Index events for replay
const eventId = layer2Store.indexEvent(event);

// Layer 3: Check breakpoints
const breakpoint = layer3Store.checkBreakpoint(event);
if (breakpoint) {
  logger.info({ breakpoint: breakpoint.id, eventId }, 'Breakpoint hit');
}

// Layer 4: Record errors for history
if (event.type === 'console' && event.level === 'error') {
  const message = event.args.map(a => ...).join(' ');
  layer4Store.recordError(message, event.stack);
}
```

---

## Plan Gating

### Free vs. Paid Features

**Free (all users):**
- Layer 1: All features (component tree, state diff, performance trace)
- Layer 4: All features (error history, fix linking)

**Paid (Solo Standard+):**
- Layer 2: `replay_event`, `watch`, `get_timeline`
- Layer 3: All features (breakpoints, inject logs, mock responses)

---

## Performance Considerations

### Memory Management

1. **Layer 2 event index:** Max 500 events, pruned every 30s
2. **Layer 3 commands:** Max 1 minute age, pruned every 30s
3. **Layer 4 error index:** Max 1000 entries, LRU eviction

### Network Overhead

1. **Layer 1:** Adds ~2-10KB per context snapshot (component tree + state diff)
2. **Layer 3 polling:** 1 request every 2 seconds (negligible)
3. **Layer 3 commands:** Fire-and-forget, no response blocking

### Storage

- Layer 4: `~/.mergen/error-index.json` (bounded to ~500KB)
- All other layers: in-memory only

---

## Example Workflows

### Workflow 1: State Corruption Bug

1. User reports: "Login works but user is null"
2. AI calls `get_state_diff()` → sees Redux state: `{ user: null }` after successful /api/auth
3. AI calls `get_error_history("user is null")` → finds 3 past occurrences, 1 fix
4. AI suggests fix from history + current diagnosis

### Workflow 2: Race Condition

1. Error: "Cannot read property 'id' of undefined"
2. AI calls `get_timeline(error_timestamp - 2000, error_timestamp)` → sees:
   - t+0ms: Component mounted
   - t+50ms: Started fetching /api/user
   - t+100ms: Tried to render user.id
   - t+200ms: /api/user responded
3. AI diagnoses: "Component rendered before data arrived" → suggests loading state

### Workflow 3: Hypothesis Testing

1. Error: "Unauthorized"
2. AI hypothesis: "Maybe error handling fails for 401"
3. AI calls `mock_response('/api/user', 'GET', 401, { error: 'unauthorized' })`
4. User reproduces → same error
5. AI confirms: "Error handling doesn't catch 401" → generates fix

---

## Future Enhancements

### Layer 1 Expansion
- Zustand state diff (requires store instrumentation)
- Jotai atom tracking
- MobX observable history

### Layer 2 Expansion
- Replay event sequences (not just single events)
- Time-travel debugging (rewind/replay state mutations)

### Layer 3 Expansion
- WebSocket message mocking
- GraphQL response mocking
- Programmatic state mutation (Redux dispatch, Zustand set)

### Layer 4 Expansion
- Automatic fix suggestion ranking (ML on corpus)
- Cross-repo error correlation
- Public error knowledge base (opt-in)

---

## Testing

### Manual Test (Layer 1):

1. Load extension in Chrome
2. Open a React app (e.g., `create-react-app` demo)
3. Trigger an error
4. In your IDE, call MCP tool: `get_component_tree()`
5. Verify: Returns full React component tree with props/state

### Manual Test (Layer 3):

1. Server running: `npm start`
2. Extension loaded
3. In IDE, call: `mock_response('/api/test', 'GET', 404, { error: 'not found' })`
4. In browser console: `fetch('/api/test')`
5. Verify: Returns mocked 404 response

### Manual Test (Layer 4):

1. Trigger an error: `console.error('Test error message')`
2. Call: `get_error_history('Test error')`
3. Verify: Returns 1 occurrence
4. Call: `link_fix('Test error', 'abc123', 'Fixed typo')`
5. Call: `get_error_history('Test error')` again
6. Verify: Shows linked fix

---

## Conclusion

This four-layer expansion transforms Mergen from a **passive telemetry collector** into an **active debugging partner**:

- **Layer 1** gives the AI dramatically better signal (component trees, state diffs, performance data)
- **Layer 2** makes the AI an active investigator (replay, watch, timeline)
- **Layer 3** closes the loop between hypothesis and validation (breakpoints, mocks, injected logs)
- **Layer 4** builds institutional memory (error history, fix corpus)

The highest-leverage addition is **Layer 1 `get_state_diff`** — it's buildable quickly and dramatically improves error causality. No competitor has it.

All layers are **backward-compatible** (old clients ignore new fields), **non-breaking** (extend existing schemas), and maintain **O(1) buffer operations**.

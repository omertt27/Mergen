# Mergen v1.4.0 Testing Guide

Quick manual testing checklist for all new features.

---

## 🧪 Test Environment Setup

```bash
# 1. Start Mergen server
cd server
npm start

# 2. Load extension in Chrome
# - Open chrome://extensions
# - Enable Developer mode
# - Click "Load unpacked"
# - Select extension/ folder

# 3. Open a test app (React recommended)
# Example: https://react-demo.example.com
```

---

## Sprint 1: Context Compression

### Test 1.1: Severity Filtering

```bash
# In your AI IDE (Cursor/Claude Code):
# 1. Generate some logs:
console.log("This is a log");
console.warn("This is a warning");
console.error("This is an error");

# 2. Test min_severity
get_recent_logs(min_severity: 'error')
# Expected: Only errors shown

get_recent_logs(min_severity: 'warn')
# Expected: Warnings + errors (default behavior)
```

**✅ Pass criteria:** Only events >= specified severity are returned.

---

### Test 1.2: Pattern Exclusion

```bash
# 1. Trigger HMR by saving a file in your dev server
# 2. Check logs include HMR spam:
get_recent_logs(min_severity: 'log')
# Expected: See [HMR] messages

# 3. Test exclusion:
get_recent_logs(exclude_patterns: ["HMR", "webpack"])
# Expected: No HMR/webpack messages
```

**✅ Pass criteria:** Filtered messages don't appear in output.

---

### Test 1.3: Token Budget Limits

```bash
# 1. Generate 100 console logs
for (let i = 0; i < 100; i++) {
  console.log(`Event ${i}: ${'x'.repeat(100)}`);
}

# 2. Test truncation:
get_recent_logs(max_tokens: 500)
# Expected: Response ends with "[...truncated, +X more items]"
```

**✅ Pass criteria:** Response includes truncation footer when limit exceeded.

---

### Test 1.4: DOM Context Compression

```bash
# 1. Trigger an error
throw new Error("Test error");

# 2. Test full context:
get_dom_context()
# Expected: Full localStorage + sessionStorage

# 3. Test focused mode:
get_dom_context(focused_element_only: true)
# Expected: Only activeElement + component (no storage)
```

**✅ Pass criteria:** `focused_element_only` mode skips storage, reducing tokens by ~80%.

---

## Sprint 2: WebSocket Inspection

### Test 2.1: WebSocket Capture

**Test app:** Use Socket.io demo or any WebSocket app

```bash
# 1. Open a page with WebSocket
# Example: https://socket.io/demos/chat/

# 2. Check activity:
get_websocket_activity()

# Expected output:
# [timestamp] WebSocket: wss://...
#   Connection ID: abc123
#   Status: OPEN
#   Frames captured: 10
#   Recent frames:
#     → [HH:MM:SS] {"type":"message","text":"hello"}
#     ← [HH:MM:SS] {"type":"ack"}
```

**✅ Pass criteria:** Shows connection status + last sent/received frames.

---

### Test 2.2: SSE Capture

**Test app:** Server-Sent Events demo

```bash
# 1. Open SSE demo page
# 2. Check activity:
get_sse_activity()

# Expected: Connection status + recent messages
```

**✅ Pass criteria:** SSE messages appear in output.

---

### Test 2.3: Frame Rate Limiting

```bash
# 1. Send 100 WebSocket messages rapidly
for (let i = 0; i < 100; i++) {
  socket.send(`Message ${i}`);
}

# 2. Check captured frames:
get_websocket_activity()

# Expected: Max 50 frames captured (rate-limited)
```

**✅ Pass criteria:** Only last 50 frames stored, despite 100 sent.

---

## Sprint 3: Debug Sessions

### Test 3.1: Start Session

```bash
# 1. Start a debug session
start_debug_session("Login button doesn't save token to localStorage")

# Expected output:
# Debug session started (ID: abc-123)
# Hypothesis: Login button doesn't save token...
# Baseline captured at: 2026-05-26T00:00:00.000Z
# Next step: Reproduce the issue now...
```

**✅ Pass criteria:** Returns session ID + baseline timestamp.

---

### Test 3.2: End Session & Compare

```bash
# 1. Reproduce the bug (click login, trigger error)

# 2. End session
end_debug_session("abc-123")

# Expected output:
# Debug Session Results
# Hypothesis: Login button doesn't save token...
# Duration: 15s
# What Changed:
#   New errors: 1
#   Network failures: 0
#   ...
# Next Steps: Call analyze_runtime with since: 1234567890
```

**✅ Pass criteria:** Shows diff between baseline and post-reproduction.

---

### Test 3.3: Invalid Session

```bash
end_debug_session("invalid-id")

# Expected: Error message listing active sessions
```

**✅ Pass criteria:** Clear error when session not found.

---

## Sprint 4–5: React/Vue DevTools

### Test 4.1: React Component Tree

**Test app:** Any React app (create-react-app, Next.js)

```bash
# 1. Trigger an error in a React component
function MyComponent() {
  const [count, setCount] = useState(0);
  throw new Error("Test error"); // Trigger capture
  return <div>{count}</div>;
}

# 2. Get component tree
get_component_tree()

# Expected output:
# Component Tree
# Captured at: 2026-05-26T00:00:00.000Z
# Framework: React
# URL: http://localhost:3000
#
# ```
# App
#   props:
#     title: "My App"
#   state:
#     user: null
#   hooks:
#     [0]: 0
#   MyComponent
#     props: {}
#     hooks:
#       [0]: 0  (count state)
# ```
```

**✅ Pass criteria:** Shows component hierarchy with props/state/hooks.

---

### Test 4.2: Vue Component Tree

**Test app:** Vue 2 or Vue 3 app

```bash
# 1. Trigger error in Vue component
# 2. Check tree:
get_component_tree()

# Expected: Vue component hierarchy with props/data
```

**✅ Pass criteria:** Shows Vue component tree (Vue 2: full, Vue 3: basic).

---

### Test 4.3: Max Depth Control

```bash
get_component_tree(max_depth: 2)

# Expected: Tree limited to 2 levels deep
```

**✅ Pass criteria:** Respects max_depth parameter.

---

## Integration Tests

### Test I.1: Full Debug Workflow

```bash
# 1. Start session
start_debug_session("Login fails silently")

# 2. Reproduce bug (click login)

# 3. End session
end_debug_session(session_id)

# 4. Analyze
analyze_runtime(since: baseline_timestamp)

# Expected: Complete causal chain from baseline to error
```

**✅ Pass criteria:** AI can debug issue end-to-end without manual copy-paste.

---

### Test I.2: WebSocket + Component Tree

```bash
# 1. Open React app with WebSocket
# 2. Trigger error in component that uses WebSocket
# 3. Check both:
get_component_tree()
get_websocket_activity()

# Expected: Both show relevant state at error time
```

**✅ Pass criteria:** Component state correlates with WebSocket activity.

---

## Performance Tests

### Test P.1: Component Tree Overhead

```bash
# 1. Measure baseline performance
# 2. Trigger 10 errors rapidly
# 3. Check page remains responsive

# Expected: No noticeable lag
```

**✅ Pass criteria:** Page doesn't freeze during component tree capture.

---

### Test P.2: Token Budget Effectiveness

```bash
# 1. Generate 200 events
# 2. Call all tools with max_tokens: 1000
# 3. Measure total tokens used

# Expected: < 5000 tokens total (vs. 15K+ without limits)
```

**✅ Pass criteria:** 60%+ token reduction vs. v1.0.0.

---

## Edge Cases

### Test E.1: No Framework Detected

```bash
# 1. Open plain HTML page (no React/Vue)
# 2. Trigger error
# 3. Call get_component_tree()

# Expected: Message saying no component trees captured
```

**✅ Pass criteria:** Graceful handling when no framework present.

---

### Test E.2: Very Deep Component Tree

```bash
# 1. Create 20-level deep React tree
# 2. Trigger error
# 3. Call get_component_tree(max_depth: 20)

# Expected: Tree limited to prevent memory issues
```

**✅ Pass criteria:** Doesn't crash, respects depth limit.

---

### Test E.3: WebSocket Disconnects

```bash
# 1. Open WebSocket connection
# 2. Close it immediately
# 3. Check activity:
get_websocket_activity()

# Expected: Shows status: CLOSED
```

**✅ Pass criteria:** Captures disconnection events correctly.

---

## Smoke Test Checklist

Run this quick checklist before releasing:

- [ ] All Sprint 1 tests pass (4/4)
- [ ] All Sprint 2 tests pass (3/3)
- [ ] All Sprint 3 tests pass (3/3)
- [ ] All Sprint 4-5 tests pass (3/3)
- [ ] Integration tests pass (2/2)
- [ ] Performance tests pass (2/2)
- [ ] Edge cases handled (3/3)
- [ ] Build succeeds: `npm run build`
- [ ] No console errors in extension
- [ ] Server starts without errors

---

## Automated Testing (Future)

These would be good to add in v1.5.0:

```bash
# Unit tests
cd server && npm test

# Integration tests
npm run test:integration

# E2E tests with Playwright
npm run test:e2e
```

Currently: Manual testing only (adequate for v1.4.0 launch).

---

**Total test time:** ~30 minutes  
**Critical path tests:** Sprint 2 (WebSocket) + Sprint 4 (React)  
**Risk areas:** Component tree serialization on complex apps

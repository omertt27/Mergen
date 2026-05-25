# Testing the Four-Layer Implementation

## Quick Verification Tests

### Prerequisites
1. Build server: `cd server && npm run build`
2. Start server: `npm start`
3. Load extension in Chrome: `chrome://extensions` → Load unpacked → select `extension/` folder

---

## Layer 1: Better Context

### Test Component Tree Capture

1. Open a React application in Chrome (e.g., any create-react-app demo)
2. Trigger an error: `console.error('test error')`
3. In your AI IDE (Claude Code, Cursor, etc.), run MCP tool:
   ```
   get_component_tree()
   ```

**Expected result:** Returns JSON with component tree showing React component hierarchy with props and state.

### Test State Diff (Redux)

1. Open a React app with Redux DevTools
2. Perform an action that changes Redux state
3. Trigger an error
4. Call:
   ```
   get_state_diff()
   ```

**Expected result:** Shows before/after state snapshot with the changed field.

### Test Performance Trace

1. Open any webpage
2. Trigger an error
3. Call:
   ```
   get_performance_trace()
   ```

**Expected result:** Returns performance entries (paint, navigation, etc.).

---

## Layer 2: Better Diagnosis

### Test Event Replay

1. Trigger a console error: `console.error('test message')`
2. Call `get_recent_logs()` and note an event ID in the buffer
3. Call:
   ```
   replay_event({ event_id: "<id-from-logs>" })
   ```

**Expected result:** Returns full event detail with all fields.

### Test Watch Pattern

1. Call:
   ```
   watch({ pattern: "/api/test", type: "network" })
   ```
2. In browser console: `fetch('/api/test')`
3. Watch should trigger (check logs or AI notification)

**Expected result:** Watch ID returned, pattern registered.

### Test Timeline

1. Note current timestamp: `Date.now()` → e.g., 1716691200000
2. Trigger several events (errors, network calls)
3. Note new timestamp after events
4. Call:
   ```
   get_timeline({ from: <first-timestamp>, to: <second-timestamp> })
   ```

**Expected result:** Returns chronological list of all events between timestamps with deltas.

---

## Layer 3: Better Action

### Test Mock Response

1. Call:
   ```
   mock_response({
     url: "/api/test",
     method: "GET",
     status: 404,
     body: { error: "not found" }
   })
   ```
2. In browser console: `fetch('/api/test').then(r => r.json()).then(console.log)`

**Expected result:** Returns mocked 404 response with `{ error: "not found" }`.

### Test Breakpoint

1. Call:
   ```
   set_breakpoint({
     condition: "status === 401",
     event_type: "network",
     pattern: "/api/.*"
   })
   ```
2. Trigger a network call that returns 401

**Expected result:** Breakpoint ID returned, logs show "Breakpoint hit" when condition matches.

### Test Inject Log

1. Call:
   ```
   inject_log({
     selector: "button",
     event: "click",
     expression: "event.target.innerText"
   })
   ```
2. Click any button on the page

**Expected result:** Log ID returned, captures button text on first click, auto-removes.

---

## Layer 4: Better Memory

### Test Error History

1. Trigger an error: `console.error('unique test error 12345')`
2. Wait 1 second
3. Call:
   ```
   get_error_history({ query: "unique test error" })
   ```

**Expected result:** Returns 1 error with count=1, firstSeen and lastSeen timestamps.

### Test Link Fix

1. After triggering the error above, call:
   ```
   link_fix({
     error_query: "unique test error",
     commit_sha: "abc123",
     description: "Fixed test error",
     verdict: "correct"
   })
   ```
2. Call `get_error_history({ query: "unique test error" })` again

**Expected result:** Shows linked fix with commit abc123.

### Test Error Stats

1. Call:
   ```
   error_stats()
   ```

**Expected result:** Returns total errors, total fixes, average fixes per error, recent errors list.

---

## Integration Test: Full Workflow

### Scenario: Debug Race Condition

1. **Capture timeline around error:**
   ```javascript
   // In browser console
   const before = Date.now();
   
   // Trigger async operation
   fetch('/api/slow-endpoint').then(() => {
     // Access data before it arrives
     console.log(user.id); // Error: Cannot read 'id' of undefined
   });
   
   setTimeout(() => {
     const after = Date.now();
     console.log('Timeline window:', before, after);
   }, 2000);
   ```

2. **AI calls timeline:**
   ```
   get_timeline({ from: <before>, to: <after> })
   ```

3. **AI sees sequence:**
   - t+0ms: fetch started
   - t+50ms: console.error (undefined access)
   - t+1500ms: fetch completed

4. **AI diagnoses:** "Accessed user.id before fetch completed — classic race condition"

5. **AI tests hypothesis with mock:**
   ```
   mock_response({
     url: "/api/slow-endpoint",
     method: "GET",
     status: 200,
     body: { user: { id: 123 } }
   })
   ```

6. **User retries** → Error disappears (mock returns immediately)

7. **AI confirms:** "Add loading state or await the fetch"

8. **After fix, link it:**
   ```
   link_fix({
     error_query: "Cannot read 'id' of undefined",
     commit_sha: "def456",
     description: "Added loading state to prevent race condition",
     verdict: "correct"
   })
   ```

---

## Verify Backward Compatibility

1. **Without Layer 1 instrumentation:**
   - Comment out the layers-instrumentation.js load in manifest.json
   - Reload extension
   - Trigger error
   - Verify: Basic telemetry still works (console, network, context)

2. **Old event format:**
   - Events without `componentTree`, `stateDiff`, `performanceTrace` should still ingest normally

---

## Performance Tests

### Memory Leak Check

1. Start server: `npm start`
2. Ingest 1000 events:
   ```javascript
   for (let i = 0; i < 1000; i++) {
     console.error(`Test error ${i}`);
   }
   ```
3. Check memory usage: `ps aux | grep "node.*dist/index"`
4. Wait 5 minutes
5. Check memory again

**Expected:** Memory stable (event index pruned to 500, error index to 1000).

### Command Polling Overhead

1. Open Chrome DevTools → Network tab
2. Filter for `localhost:3000/commands`
3. Observe request frequency

**Expected:** 1 request every 2 seconds, minimal payload (<1KB).

---

## Cleanup

```bash
# Kill test server
pkill -f "node dist/index.js"

# Clear error history (optional)
rm ~/.mergen/error-index.json
```

---

## Troubleshooting

### "Tool not found" error
- Verify server restarted after build
- Check MCP connection: `claude mcp list`

### Component tree returns empty
- Verify React app has `__reactFiber` keys on DOM nodes
- Check browser console for extension errors
- Ensure layers-instrumentation.js loaded before content.js

### Mock not working
- Check extension polls `/commands` (every 2s)
- Verify mock registered: `layer3Store.listMocks()`
- Check browser console for [mergen:layers] logs

### Error history not persisting
- Verify `~/.mergen/` directory exists and is writable
- Check file: `cat ~/.mergen/error-index.json`

---

## Success Criteria

✅ All Layer 1 tools return enhanced data (component tree, state diff, performance)  
✅ All Layer 2 tools work (replay, watch, timeline)  
✅ All Layer 3 tools work (breakpoint, inject log, mock)  
✅ All Layer 4 tools work (error history, link fix, stats)  
✅ Bidirectional communication works (extension polls commands)  
✅ Backward compatibility maintained (old events still ingest)  
✅ Memory bounded (pruning works)  
✅ Server starts without errors  

If all criteria pass: **Implementation successful! 🎉**

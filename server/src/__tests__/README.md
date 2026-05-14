# Mergen Test Suite

Industry-level automated testing for the Mergen observability system.

---

## Quick Start

```bash
# Run all tests
npm test

# Run specific test file
npm test e2e-system.test.ts

# Watch mode (for development)
npm run test:watch

# With coverage report
npm run test:coverage
```

---

## Test Files

### 1. `e2e-system.test.ts` — End-to-End System Tests
**Purpose:** Verify the complete pipeline from browser event ingestion to MCP tool output.

**Test Categories:**
- Complete Pipeline Tests
  - Error scenario flow (network → console → context)
  - Event ordering under concurrent load
  - Rapid-fire single-tab events
  
- Buffer Behavior Under Load
  - Priority eviction (errors over info logs)
  - Accurate counters under concurrent writes
  
- Security & Input Validation
  - Malformed JSON rejection
  - Missing/invalid field validation
  - Secret authentication
  - Large payload sanitization
  
- Error Recovery & Resilience
  - Recovery after validation errors
  - OPTIONS preflight handling
  - Buffer integrity after clear
  
- Health & Monitoring
  - Health check endpoints
  - Buffer statistics
  
- Real-World Scenarios
  - SPA navigation flows
  - WebSocket-style streams
  - Network/console correlation
  
- Performance Characteristics
  - Burst handling (100 events in <2s)
  - O(1) buffer operations

**Total Tests:** ~25  
**Typical Runtime:** ~5-10 seconds

---

### 2. `mcp-tools.test.ts` — MCP Tool Interface Tests
**Purpose:** Ensure AI IDE integration works correctly via Model Context Protocol tools.

**Test Categories:**
- `get_recent_logs` tool
  - Default/custom limits
  - Level filtering (error, warn, log)
  - Timestamp filtering (since parameter)
  - Chronological ordering
  - Complex console args
  
- `get_network_activity` tool
  - Status code filtering
  - Request/response bodies
  - Request headers
  - Duration tracking
  
- `get_context` tool
  - localStorage/sessionStorage
  - Viewport dimensions
  - DOM snapshots
  - Limit enforcement
  
- `clear_buffer` tool
  - Complete cleanup
  - Counter reset
  - Post-clear operation
  
- Tool Parameter Validation
  - Edge cases (zero, negative, excessive limits)
  - Invalid parameters
  
- AI-Friendly Output Format
  - Structured data
  - JSON serializability
  - Event correlation hints
  
- Production Bug Scenarios
  - React hydration errors
  - CORS failures
  - Auth token expiration

**Total Tests:** ~30  
**Typical Runtime:** ~2-5 seconds

---

### 3. `load-stress.test.ts` — Load & Stress Tests
**Purpose:** Validate system performance, scalability, and resilience under heavy load.

**Test Categories:**
- High-Volume Event Ingestion
  - 1000 concurrent requests
  - Data integrity under concurrent writes
  - Multi-tab simulation (10 tabs × 50 events)
  
- Memory and Buffer Pressure
  - Buffer overflow handling (300+ events)
  - Priority eviction under pressure
  - Large payload stress
  
- Performance Under Load
  - Sub-100ms response times
  - Sustained load (5s at 20 req/s)
  
- Concurrent MCP Tool Access
  - Simultaneous reads (20 clients)
  - Read/write contention
  
- Resource Exhaustion Scenarios
  - Body size limit rejection
  - Malformed request resilience
  
- Recovery and Resilience
  - Buffer clear under load

**Total Tests:** ~15  
**Typical Runtime:** ~15-30 seconds  
**Note:** Extended timeouts (10-15s per test) due to load simulation

---

### 4. `integration.test.ts` — Core Integration Tests
**Purpose:** Basic pipeline verification for the three event types.

**Test Categories:**
- Console event flow
- Network event flow
- Context snapshot flow
- Counter accuracy
- Clear functionality
- Priority eviction

**Total Tests:** ~8  
**Typical Runtime:** ~1-2 seconds

---

## Performance Benchmarks

### Expected Results

| Test Suite | Duration | Throughput | Success Rate |
|------------|----------|------------|--------------|
| E2E System | ~5-10s | N/A | 100% |
| MCP Tools | ~2-5s | N/A | 100% |
| Load/Stress | ~15-30s | 200-500 events/s | >95% |
| Integration | ~1-2s | N/A | 100% |

### Load Test Metrics

```
1000 concurrent requests:
  ✓ Processed: 987/1000 (98.7%)
  ✓ Throughput: ~500 events/sec
  ✓ Duration: <2 seconds

Sustained load (20 req/s for 5s):
  ✓ Requests: 98
  ✓ Success rate: 99.0%
  ✓ Avg latency: <50ms
  ✓ P95 latency: <200ms
```

---

## Test Environment

### Requirements
- Node.js ≥18.17
- npm ≥9.0
- Vitest ^4.1.5
- 2GB RAM minimum (4GB recommended for load tests)

### Environment Variables
```bash
# Optional: custom port for tests
TEST_PORT=3001

# Optional: disable some stress tests in CI
SKIP_HEAVY_LOAD_TESTS=true
```

---

## CI/CD Integration

### GitHub Actions
See `.github/workflows/test.yml` for the complete CI pipeline.

**Matrix strategy:**
- Node.js 18.x, 20.x, 22.x
- Ubuntu latest

**Jobs:**
1. Server tests (all test files)
2. Extension tests (if present)
3. Lint & Build
4. Security audit
5. Performance benchmarks

**Coverage reporting:**
- Codecov integration
- Coverage threshold: 80% (lines, branches, functions)

---

## Writing New Tests

### Test Structure
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createApp } from '../app.js';
import { store } from '../sensor/buffer.js';

describe('Feature Name', () => {
  let app: Express;
  let server: HttpServer;
  let baseURL: string;

  beforeEach(async () => {
    store.clear();
    app = createApp({ serverVersion: '1.0.0', localSecret: 'test-secret' });
    // Start server...
  });

  afterEach(() => {
    server?.close();
  });

  it('should test specific behavior', async () => {
    // Arrange
    const event = { /* ... */ };

    // Act
    const response = await fetch(`${baseURL}/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    });

    // Assert
    expect(response.ok).toBe(true);
  });
});
```

### Best Practices

1. **Isolation:** Always clear buffer in `beforeEach`
2. **Realistic data:** Use `Date.now()` for timestamps
3. **Concurrency:** Use `Promise.all()` for parallel tests
4. **Timeouts:** Set appropriate timeouts for load tests
5. **Assertions:** Be specific (avoid generic `toBeTruthy()`)
6. **Console output:** Use `console.log()` for debugging, remove before commit
7. **Error messages:** Include context in expect messages

### Example: Testing Event Ingestion
```typescript
it('should ingest and retrieve console error', async () => {
  const event = {
    type: 'console',
    level: 'error',
    args: ['Test error'],
    url: 'http://test',
    timestamp: Date.now(),
  };

  await fetch(`${baseURL}/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
  });

  const errors = store.getLogs(10, 'error');
  expect(errors).toHaveLength(1);
  expect(errors[0].args[0]).toBe('Test error');
});
```

---

## Debugging Failed Tests

### Common Issues

**1. Port already in use**
```
Error: listen EADDRINUSE: address already in use :::3000
```
**Fix:** Kill process on port 3000 or use random port in tests

**2. Timing issues**
```
Expected: 100, Received: 99
```
**Fix:** Add small delay or use `waitFor()` helper

**3. Buffer state mismatch**
```
Expected buffer size: 50, Received: 48
```
**Fix:** Check if priority eviction is happening

**4. Load test failures in CI**
```
Success rate: 92% (expected >95%)
```
**Fix:** Increase tolerance or reduce concurrency in CI

### Debug Commands

```bash
# Run single test with verbose output
npm test -- e2e-system.test.ts -t "should handle complete error scenario"

# Run with debugging
node --inspect-brk node_modules/.bin/vitest run e2e-system.test.ts

# Check buffer state
# Add this in your test:
console.log({
  size: store.size(),
  counters: store.getCounters(),
  logs: store.getLogs(5),
});
```

---

## Coverage Goals

| Component | Lines | Branches | Functions | Statements |
|-----------|-------|----------|-----------|------------|
| `buffer.ts` | >95% | >90% | 100% | >95% |
| `ingest.ts` | >90% | >85% | 100% | >90% |
| `tools.ts` | >85% | >80% | 100% | >85% |
| `app.ts` | >80% | >75% | >90% | >80% |

**Current overall:** ~85%

---

## Future Improvements

- [ ] Puppeteer browser automation tests
- [ ] Sourcemap accuracy tests
- [ ] Multi-browser compatibility tests
- [ ] Real production traffic replay
- [ ] Chaos engineering scenarios
- [ ] Security penetration tests
- [ ] Performance regression tracking
- [ ] Snapshot testing for MCP responses

---

## Questions & Support

**Docs:** See `/TESTING.md` in repo root  
**Issues:** https://github.com/omertt27/Mergen/issues  
**CI/CD:** `.github/workflows/test.yml`

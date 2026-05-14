# Mergen — Quick Test Guide

Fast reference for running Mergen tests.

---

## ⚡ Quick Commands

```bash
# Run everything
cd server && npm test

# Specific test suite
npm test e2e-system.test.ts       # End-to-end pipeline
npm test mcp-tools.test.ts        # MCP tool interface
npm test load-stress.test.ts      # Performance & load
npm test integration.test.ts      # Basic integration

# Watch mode (auto-rerun on changes)
npm run test:watch

# Coverage report
npm run test:coverage

# Single test by name
npm test -- -t "should handle complete error scenario"

# Verbose output
npm test -- --reporter=verbose

# Run all (server + extension)
bash scripts/run-all-tests.sh
```

---

## 📋 Test Suites

| File | Tests | Duration | Purpose |
|------|-------|----------|---------|
| `e2e-system.test.ts` | ~25 | 5-10s | Full pipeline testing |
| `mcp-tools.test.ts` | ~30 | 2-5s | AI IDE integration |
| `load-stress.test.ts` | ~15 | 15-30s | Performance testing |
| `integration.test.ts` | ~8 | 1-2s | Core functionality |

---

## 🎯 What Each Suite Tests

### e2e-system.test.ts
- ✅ Complete error flow (browser → server → MCP)
- ✅ 1000 concurrent requests
- ✅ Security validation
- ✅ Input sanitization
- ✅ Error recovery
- ✅ Real-world scenarios

### mcp-tools.test.ts
- ✅ `get_recent_logs` filtering
- ✅ `get_network_activity` status filtering
- ✅ `get_context` snapshots
- ✅ Event correlation
- ✅ Production bug patterns

### load-stress.test.ts
- ✅ 1000 concurrent requests
- ✅ Sustained load (20 req/s)
- ✅ Buffer overflow handling
- ✅ Priority eviction
- ✅ Read/write contention

### integration.test.ts
- ✅ Basic console/network/context flow
- ✅ Counter accuracy
- ✅ Buffer operations

---

## 🚨 Troubleshooting

### Tests won't run
```bash
# Install dependencies
cd server && npm install

# Check Node version (need >=18.17)
node --version
```

### Port conflicts
```bash
# Kill process on port 3000
lsof -ti:3000 | xargs kill -9
```

### Out of memory (load tests)
```bash
# Increase Node memory
NODE_OPTIONS="--max-old-space-size=4096" npm test
```

### CI failures
- Increase timeouts in `.github/workflows/test.yml`
- Reduce concurrency in `load-stress.test.ts`
- Check Node.js version matrix

---

## 📊 Expected Results

### Performance Benchmarks
```
Throughput:      500+ events/sec
Avg Latency:     <50ms
P95 Latency:     <200ms
Success Rate:    >95%
```

### Coverage Targets
```
Overall:         >80%
buffer.ts:       >90%
ingest.ts:       >85%
tools.ts:        >80%
```

---

## 🔧 Development Workflow

1. **Make changes** to source code
2. **Run affected tests**
   ```bash
   npm test -- buffer.test.ts
   ```
3. **Check coverage**
   ```bash
   npm run test:coverage
   ```
4. **Commit** when all tests pass

---

## 📚 Full Documentation

- **Complete guide:** `/TESTING.md`
- **Test details:** `/server/src/__tests__/README.md`
- **Summary:** `/TEST_SUMMARY.md`
- **CI/CD:** `.github/workflows/test.yml`

---

## 🆘 Need Help?

**Tests failing?** Check Node version and dependencies  
**Port conflicts?** Kill process on port 3000  
**Performance issues?** Increase Node memory limit  
**CI/CD issues?** Review `.github/workflows/test.yml`  

**Report bugs:** https://github.com/omertt27/Mergen/issues

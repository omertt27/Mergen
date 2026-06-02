# Mergen — Golden Proof

Proves that an AI agent can reconstruct a cross-runtime failure chain
**without manual trace IDs, without prior knowledge of the bug, and without custom debugging scripts.**

One button click. One AI prompt. Root cause identified by identity graph, not guesswork.

---

## What this proves

```
Browser click
  → fetch POST /api/checkout   (traceparent injected by Mergen extension)
      → backend receives request (traceparent logged to stdout)
          → backend throws Error("Cart is empty at checkout.js:42")
              → console.error in browser
                  → get_unified_timeline
                      → EXACT label: browser POST ↔ backend log (same traceId)
                          → root cause identified
```

The `EXACT` confidence label means Mergen matched the browser request to the backend
log line using the **same generated traceId** — a deterministic causal join, not
timestamp proximity guessing.

---

## Setup (2 minutes)

**Prerequisites:**
- Mergen server running (`mergen-server start` or `npx mergen-server start`)
- Mergen extension loaded in Chrome (`chrome://extensions` → Load unpacked → `extension/`)
- MCP configured in your AI IDE (`mergen-server setup`)

**Install dependencies:**
```bash
cd proof
npm install
```

---

## Run the proof

### Terminal 1 — Backend under Mergen's watcher
```bash
cd proof
npm run backend
# or: mergen-server watch --name backend node backend/server.js
```

Expected output:
```
[Mergen] Watching: node backend/server.js
[Mergen] Streaming to Mergen on 127.0.0.1:3000 as process "backend"
[backend] Proof backend running on http://localhost:4000
```

### Terminal 2 — Frontend
```bash
cd proof
npm run frontend
# or: npx http-server frontend -p 5173 --cors -c-1
```

Open `http://localhost:5173` in Chrome (with the Mergen extension active).

---

## Trigger the failure

Click **"Checkout (Empty Cart)"**.

You will see:
- Status turns red: `HTTP 500 — Cart is empty at checkout.js:42`
- Browser DevTools console shows a `console.error` with stack trace
- Backend terminal shows the access log line with the traceId

---

## Run the proof query

In your AI IDE (Claude Code, Cursor, etc.), paste this exact prompt — **no other context provided:**

```
The checkout failed. Find the root cause.
```

---

## Verify the result

The agent **must** call `get_unified_timeline` first (enforced by the MCP system prompt).

In the timeline output, look for the `EXACT` label on two adjacent rows:

```
`HH:MM:SS`  🔴  `EXACT   `  **[BROWSER]**  POST /api/checkout → 500 (Xms)  ↔ backend
`HH:MM:SS`  💻  `EXACT   `  **[BACKEND]**  [backend] {"traceId":"abc...","method":"POST","url":"/api/checkout"}
`HH:MM:SS`  💻  `OBS     `  **[BACKEND]**  [backend] Error: Cart is empty at checkout.js:42
`HH:MM:SS`  🔴  `LINKED  `  **[BROWSER]**  [BROWSER] Checkout failed: Internal Server Error  [git-sha · author]
```

**The proof passes if:**
- `EXACT` label appears on both the browser POST and the backend access log
- The agent identifies `checkout.js:42` as the root cause without being told
- No trace IDs were manually supplied at any point

**The proof fails if:**
- Only `~CORR` appears (timestamp proximity — means traceId wasn't logged by backend)
- Agent required additional prompting to find the cause
- EXACT join is missing

---

## Docker variant

```bash
# Start Mergen server on all interfaces (required for containers to reach host)
MERGEN_BIND=0.0.0.0 mergen-server start

# Run backend container
docker run -e MERGEN_HOST=host.docker.internal \
  -v $(pwd)/proof/backend:/app node:20 \
  sh -c "cd /app && npm install && node --require mergen-server/sdk/node server.js"
```

The `EXACT` label should still appear — the Node SDK injects traceparent on all
outbound requests from inside the container, and posts events to the host Mergen server.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Only `~CORR` in timeline | Backend not logging traceId | Check backend stdout has `{"traceId":...}` line |
| No events in timeline | Extension not active | Ensure Mergen extension is enabled on `localhost:5173` |
| Network error on button click | Backend not running | Run `npm run backend` in proof/ |
| MCP tools not called | IDE not configured | Run `mergen-server status` to verify |

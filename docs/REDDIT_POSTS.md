# Reddit Posts

## Post 1 — r/cursor

**Title:** I built a tool that gives Cursor/Claude real-time access to your browser console — caught a race condition I'd been debugging for 2 hours in 30 seconds

**Body:**

I hit one of those frontend bugs today where the UI would briefly show the correct user, then reset back to stale state.

I’d already spent way too long doing the usual routine:
- DevTools open
- network tab open
- console spam everywhere
- trying to explain the timeline to Cursor manually

The problem wasn’t that I had *no* logs. It was that I had raw logs and a timing bug.

So I used a small tool I’ve been building called Mergen. It’s local-only: Chrome extension captures console + network events, posts them to `127.0.0.1:3000`, and exposes them to Cursor/Claude over MCP.

What was actually useful is that Cursor could inspect the browser events directly *while* I reproduced the bug.

I asked:

```text
Why did the user state reset?
```

Cursor called:

```text
get_recent_logs({ level: "warn", since: 1710000003000 })
get_network_activity({ since: 1710000003000 })
```

And the useful part of the response was basically:

```text
Hypothesis ranking
1. Race condition causing stale state overwrite (0.81)
2. Reducer fallback reset (0.43)

Causal chain
- GET /api/user/42 started
- GET /api/user/99 started
- /api/user/99 returned first and updated state
- /api/user/42 returned later and overwrote state with stale payload
- console.warn at UserPanel.tsx:88: "state replaced by older response"
```

That was enough to immediately go fix it with request identity guards.

I’m posting because this felt like the first time an AI editor actually had the *runtime context* I was looking at, instead of me copy-pasting screenshots or logs into chat.

Not trying to hard-sell anything — I’m mostly curious if other people here would actually use this workflow.

Repo if anyone wants to poke at it:
https://github.com/omertt27/Mergen

---

## Post 2 — r/ClaudeAI

**Title:** How I connected Claude Code to my browser console via MCP — live network errors, source-mapped stack traces, zero cloud

**Body:**

I wanted Claude Code to see what my browser was doing *while* I reproduced a bug, without sending anything to a cloud service and without manually pasting DevTools output.

So I wired up a local MCP flow:
- Chrome extension captures console logs + fetch/XHR activity
- events POST to `127.0.0.1:3000/ingest`
- local server stores the last 200 events in memory
- MCP server exposes tools Claude can call

The Claude setup looks like this:

```bash
claude mcp add mergen --transport stdio -- node "$(pwd)/server/dist/index.js"
```

Then in Claude Code I can ask something normal like:

```text
Get recent logs
```

And the MCP tool returns something like:

```json
[
  {
    "type": "console",
    "level": "error",
    "args": ["Token refresh failed"],
    "stack": "src/auth.ts:142:18",
    "url": "http://localhost:5173/dashboard",
    "timestamp": 1710000005120
  },
  {
    "type": "console",
    "level": "warn",
    "args": ["retrying request without auth header"],
    "url": "http://localhost:5173/dashboard",
    "timestamp": 1710000005193
  }
]
```

The nice part is that it’s not just raw console access:
- source-mapped stacks instead of minified bundle lines
- local-only / no cloud hop
- network events alongside console logs
- PII redaction before storage
- better context for Claude when the issue is timing-related

Why would you want this?

Because a lot of browser bugs are annoying specifically because the runtime evidence is split across tabs and tools. Claude is much better at helping once it can inspect the same stream of logs and requests you’re looking at.

This won’t replace production tools like Sentry. It’s more of a local dev debugging bridge.

If that sounds useful, repo is here:
https://github.com/omertt27/Mergen

# Mergen 3-Minute Demo Script: Catching a Race Condition

## Goal

Show, in under three minutes, that Mergen is not just a raw browser log pipe. It captures live browser telemetry, sends it locally to an MCP server, and helps an AI IDE explain a real debugging issue: a race condition where stale data overwrites fresh user state.

## Scene Breakdown

### [0:00–0:15] Hook

**On screen**
- Fast cuts: browser bug, console noise, raw JSON, then Mergen’s structured diagnosis.
- Title card: **"Catching a race condition in 3 minutes"**

**Narration**
> Browser MCP gives you raw logs. Sentry only knows about production. What catches race conditions during development, right now, in your browser? Mergen.

### [0:15–0:45] Setup

**On screen**
- Chrome extensions page showing Mergen enabled
- Terminal with Mergen server running
- Claude Code open next to a React app
- Quick view of `npx mergen-server setup`

**Narration**
> This is Mergen. A local-first production telemetry server for AI IDEs. The Chrome extension captures console logs and network events, posts them to localhost, and the MCP server exposes them directly to tools like Claude Code, Cursor, and VS Code Copilot. No cloud. No copy-paste.

### [0:45–1:30] Trigger the bug

**On screen**
- Editor showing a React component with two concurrent requests:
  - `fetchUserProfile(userId)`
  - `fetchUserPreferences(userId)`
- A subtle bug: an earlier response resolves later and overwrites newer state
- Browser interaction: switch users quickly or click refresh twice
- UI briefly shows correct data, then resets to stale or empty state
- Console shows a warning and a noisy sequence of logs
- Network panel shows overlapping requests with different completion times

**Narration**
> Here’s the bug. This component fires two overlapping fetches when the selected user changes. The first request comes back late, but it still wins and overwrites the newer state. It’s the kind of bug that looks random until you can line up timing, logs, and state transitions in one place.

### [1:30–2:15] Ask Claude Code

**On screen**
- Claude Code prompt: **"Why did the user state reset?"**
- Tool activity visible:
  - `get_recent_logs`
  - `get_network_activity`
- Then show structured output:
  - repeated request sequence
  - stale response arriving last
  - ranked hypothesis: race condition / stale async write

**Narration**
> Now I ask Claude Code one question: why did the user state reset? Claude calls Mergen’s MCP tools, pulls recent logs and network activity, and Mergen turns that telemetry into a causal chain. Instead of a wall of browser noise, we get a ranked explanation: two concurrent fetches, response order inversion, stale state write, user state reset.

### [2:15–2:45] Compare

**On screen**
- Left side: raw JSON dump labeled **Browser MCP**
- Right side: structured chain labeled **Mergen**
- Highlight the difference: same raw ingredients, different usefulness

**Narration**
> Here’s the difference. Browser MCP is useful if you just want raw access to console output. But for debugging, raw access is not the same thing as diagnosis. Mergen resolves source-mapped stacks, redacts obvious sensitive values, understands hot reload noise, and ranks likely causes instead of making you read everything manually.

### [2:45–3:00] CTA

**On screen**
- Terminal command large on screen: `npx mergen-server setup`
- GitHub repo URL below
- Final product shot: browser + IDE + terminal

**Narration**
> If you want to try it, install in 30 seconds: `npx mergen-server setup`. Link in the description.

---

## Word-for-Word Narration Script

> Browser MCP gives you raw logs. Sentry only knows about production. What catches race conditions during development, right now, in your browser? Mergen.
>
> This is Mergen. A local-first production telemetry server for AI IDEs. The Chrome extension captures console logs and network events, posts them to localhost, and the MCP server exposes them directly to tools like Claude Code, Cursor, and VS Code Copilot. No cloud. No copy-paste.
>
> Here’s the bug. This component fires two overlapping fetches when the selected user changes. The first request comes back late, but it still wins and overwrites the newer state. It’s the kind of bug that looks random until you can line up timing, logs, and state transitions in one place.
>
> Now I ask Claude Code one question: why did the user state reset? Claude calls Mergen’s MCP tools, pulls recent logs and network activity, and Mergen turns that telemetry into a causal chain. Instead of a wall of browser noise, we get a ranked explanation: two concurrent fetches, response order inversion, stale state write, user state reset.
>
> Here’s the difference. Browser MCP is useful if you just want raw access to console output. But for debugging, raw access is not the same thing as diagnosis. Mergen resolves source-mapped stacks, redacts obvious sensitive values, understands hot reload noise, and ranks likely causes instead of making you read everything manually.
>
> If you want to try it, install in 30 seconds: `npx mergen-server setup`. Link in the description.

## Suggested On-Screen MCP Response

Use a clean, readable response card instead of tiny terminal text:

```text
Hypothesis ranking
1. Race condition causing stale state overwrite (0.81)
2. Reducer reset triggered by fallback branch (0.43)
3. Auth/session invalidation (0.19)

Causal chain
- GET /api/user/42 started at 12:01:03.120
- GET /api/user/99 started at 12:01:03.412
- /api/user/99 returned first and updated selected user state
- /api/user/42 returned later and wrote stale payload into the same store
- console.warn at UserPanel.tsx:88: "state replaced by older response"
```

## Suggested Browser MCP Comparison Card

```json
[
  {
    "type": "network",
    "method": "GET",
    "url": "/api/user/42",
    "status": 200,
    "duration": 611,
    "timestamp": 1710000003120
  },
  {
    "type": "network",
    "method": "GET",
    "url": "/api/user/99",
    "status": 200,
    "duration": 188,
    "timestamp": 1710000003412
  },
  {
    "type": "console",
    "level": "warn",
    "args": ["state replaced by older response"]
  }
]
```

## Filming Notes

- Record at 1440p or 4K, then crop for YouTube/X/short clips later.
- Increase terminal and editor font size before recording.
- Use a dark theme with high contrast; avoid tiny browser devtools text.
- Pre-stage the bug so the race condition reproduces on the first take.
- Hide bookmarks, personal tabs, and unrelated desktop notifications.
- Keep the terminal visible long enough for viewers to read `npx mergen-server setup`.
- If possible, add a subtle zoom during the causal-chain reveal.

## Screen Recording Tips

- Use side-by-side layout: **browser on left, Claude Code on right**.
- Turn on keystroke overlays only for the prompt moment so the screen stays clean.
- Use short punch-in zooms for:
  - extension enabled
  - server output
  - Claude’s MCP tool calls
  - ranked hypothesis
- Cut dead air between the bug trigger and the diagnosis reveal.
- Add captions for the hook and CTA even if narration is clear.

## B-Roll Suggestions

- Close-up of React component code with overlapping fetch logic
- Network waterfall showing response inversion
- Console warning appearing exactly as the UI resets
- Terminal output: `HTTP ingest listening on http://127.0.0.1:3000`
- Claude tool list showing `get_recent_logs` and `get_network_activity`
- Final repo shot with GitHub URL and install command

## Demo Prep Checklist

- Mergen server already built and running
- Extension loaded and pinned in Chrome
- Claude Code connected to the MCP server
- Demo app reset to known state
- Race condition reliably reproducible
- Comparison screenshots prepared for Browser MCP vs Mergen
- Repo link copied to clipboard for final screen

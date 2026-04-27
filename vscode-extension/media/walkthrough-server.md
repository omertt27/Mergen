# Step 1 — Start the local server

Mergen runs a small Node server on `127.0.0.1`. It receives events from the
browser extension, correlates them into a **causal chain**, and exposes the
result to your AI assistant via MCP.

**Nothing leaves your machine.** The server binds to localhost only.

If you cloned the Mergen repo, the **Start Local Server** button will find
`server/dist/index.js` automatically. If you installed it elsewhere, set
`mergen.serverPath` in Settings to the absolute path.

If the server fails to start, see the
[60-second install guide](https://github.com/omertt27/Mergen#install-in-60-seconds).

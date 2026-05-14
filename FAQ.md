# Mergen FAQ

Frequently asked questions about Mergen.

---

## General

### What is Mergen?

Mergen streams live browser telemetry (console logs, network requests, DOM state) to your AI IDE, enabling your AI assistant to debug your app in real-time without copy-pasting.

### Is it free?

Yes! Mergen is 100% free and open source (MIT license).

### Does my data leave my computer?

No. All data stays on `127.0.0.1` (localhost). The server binds to localhost only and uses stdio for MCP communication. Nothing leaves your machine.

### Which AI IDEs are supported?

- Claude Code
- Cursor
- VS Code (with GitHub Copilot)
- Windsurf
- Any IDE that supports Model Context Protocol (MCP)

### Which browsers are supported?

- Chrome
- Edge (Chromium-based)
- Brave
- Any Chromium-based browser

---

## Installation

### Do I need to know how to code?

Basic command-line skills help, but the installation is designed to be simple:
```bash
npx mergen-server@latest setup
```

### Can I use Docker instead?

Yes!
```bash
docker-compose up
```

### Do I need Node.js?

For most install methods, yes (Node 18+). But you can use pre-built binaries or Docker which don't require Node.js.

### Can I install without npm?

Yes, use:
- Docker: `docker-compose up`
- Homebrew (Mac): `brew install mergen`
- Pre-built binary: Download from releases

---

## Usage

### How do I ask my AI to use Mergen?

Just ask natural questions:
- "Get recent logs"
- "Show network activity"
- "Why did that request fail?"
- "What's in localStorage?"

Your AI will automatically call the Mergen MCP tools.

### What data can Mergen see?

- Console logs (console.log, .warn, .error)
- Network requests (fetch, XMLHttpRequest)
- HTTP status codes and response bodies
- Page URL, title, and active element
- localStorage and sessionStorage

### How much history is kept?

The buffer stores the last 200 events. When full, old events are evicted (errors are kept longer than info logs).

### Can I clear the buffer?

Yes:
- In your AI: "Clear buffer"
- Via API: `curl -X DELETE http://127.0.0.1:3000/clear`

---

## Security & Privacy

### Is my data sent to the cloud?

No. All data stays on localhost (127.0.0.1). Mergen never sends data to external servers.

### What about sensitive data (passwords, tokens)?

Best practices:
- Don't log sensitive data in your application
- Server binds to localhost only
- No external connections
- Optional: Set `MERGEN_SECRET` env var for additional auth

### Can I use Mergen in a corporate environment?

Yes! Since everything runs locally, it works in air-gapped networks and behind corporate firewalls. No external connections are made.

### Do you collect telemetry?

No. Mergen does not collect any usage data or telemetry.

---

## Technical

### What's the performance impact?

Minimal:
- Extension: <1ms per console.log
- Server: <5ms per event ingestion
- Memory: ~50MB for server + 200 events
- No impact on production (dev-only tool)

### Does it work with source maps?

Yes! If your app generates `.map` files, Mergen automatically de-minifies stack traces.

Run the server from your frontend project root:
```bash
cd /path/to/your/frontend
node /path/to/Mergen/server/dist/index.js
```

### Can I use it with TypeScript?

Yes! Mergen works with any framework or language that runs in the browser.

### Does it work with React/Vue/Angular?

Yes! Framework-agnostic. Works with any web app.

### Can I integrate it with my CI/CD?

The server is designed for local development, not CI. For production observability, use Sentry, DataDog, etc.

### What's the buffer size?

200 events by default. Configurable via `MERGEN_BUFFER_SIZE` env var.

### How are events prioritized?

When the buffer is full:
- Errors are kept longer
- Info logs are evicted first
- Uses priority-based ring buffer (O(1) eviction)

---

## Troubleshooting

### "Port 3000 already in use"

Mergen tries ports 3000-3010 automatically. If all are taken:
```bash
lsof -ti:3000 | xargs kill -9
```

### Extension not capturing events

1. Check extension is enabled (chrome://extensions)
2. Check server is running: `curl http://127.0.0.1:3000/health`
3. Restart browser

### IDE not showing Mergen tools

1. Restart IDE after setup
2. Run: `mergen-server test`
3. Check IDE MCP settings

### "command not found: mergen-server"

Use `npx` instead:
```bash
npx mergen-server@latest setup
```

See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for more detailed solutions.

---

## Contributing

### How can I contribute?

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

Good first issues:
- Documentation improvements
- Test additions
- Bug fixes
- Browser compatibility

### I found a bug, what do I do?

Open an issue: https://github.com/omertt27/Mergen/issues

Include:
- OS and version
- Node.js version
- Steps to reproduce
- Error messages
- Output of `mergen-server test`

### I have a feature request

Open a discussion: https://github.com/omertt27/Mergen/discussions

Include:
- What problem it solves
- Your use case
- How you'd expect it to work

---

## More Questions?

- **Documentation:** [README.md](README.md)
- **Quick Start:** [QUICKSTART.md](QUICKSTART.md)
- **Installation Guide:** [INSTALL.md](INSTALL.md)
- **Troubleshooting:** [TROUBLESHOOTING.md](TROUBLESHOOTING.md)
- **Contributing:** [CONTRIBUTING.md](CONTRIBUTING.md)
- **GitHub Issues:** https://github.com/omertt27/Mergen/issues
- **Discussions:** https://github.com/omertt27/Mergen/discussions

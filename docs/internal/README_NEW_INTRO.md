# Mergen

### Local-first runtime debugging for AI assistants

Stream live browser telemetry directly to your AI IDE. Zero cloud, 100% local, perfect for debugging with Claude, Cursor, or Copilot.

[![NPM](https://img.shields.io/npm/v/mergen-server)](https://www.npmjs.com/package/mergen-server)
[![Tests](https://img.shields.io/badge/tests-190%20passing-brightgreen)](./server)
[![License](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![MCP](https://img.shields.io/badge/Model%20Context%20Protocol-stdio-black)](https://modelcontextprotocol.io)

---

## ⚡ Quick Install (2 minutes)

```bash
# 1. Install server
npx mergen-server@latest setup

# 2. Install extension
# https://chrome.google.com/webstore/detail/mergen/xxx

# 3. Ask your AI: "Get recent logs"
```

✅ **That's it!** Your AI can now see console logs, network requests, and page context.

**Other install methods:** [Docker](INSTALL.md#method-2-docker), [Homebrew](INSTALL.md#method-3-homebrew), [Binaries](INSTALL.md#method-4-pre-built-binary), [From Source](INSTALL.md#method-5-from-source)

---

## 🎯 What You Get

Ask your AI assistant:

| Question | What Mergen Provides |
|----------|---------------------|
| **"Get recent logs"** | Last 50 console.log/warn/error with timestamps |
| **"Why did that request fail?"** | Network activity with status, duration, response body |
| **"Show me all 401 errors"** | Filtered network events |
| **"What's in localStorage?"** | Page context including storage, URL, active element |

Your AI sees everything happening in your browser, **without you copy-pasting**.

---

## 🔥 Demo

[Add GIF/video here showing:
1. Browser console error
2. Asking AI "What just happened?"
3. AI analyzing logs + network + context
4. Suggesting fix]

---


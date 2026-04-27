# Distribution Checklist

> Mergen's growth model is **distribution through the AI hosts, not against them.** A one-line `mcp.json` install is our TikTok. This file tracks every channel we need to land on, with the exact metadata each one wants.

## Sequencing — do not submit everywhere at once

The goal of v1 launch is to **land in every IDE marketplace at once**
(MS + Open VSX), treat the first 20–50 installs as our most important
feedback signal, fix onboarding based on what they say, *then* push the
MCP directories. Every new channel we open before onboarding is solid is
a wasted impression.

> **Why two registries on day 0:** the Microsoft Marketplace covers stock
> VS Code + Codespaces. **Open VSX covers Cursor, Windsurf, VSCodium,
> Gitpod, and code-server** — the entire AI-IDE long tail that *cannot*
> install from MS for licensing reasons. Shipping to only MS amputates
> our most important users. See `docs/PUBLISHING.md` for the full
> editor-to-registry map.

**Order of operations:**

1. **Day 0** — `npm run publish:all` ships to **Microsoft Marketplace +
   Open VSX** simultaneously. (See `docs/PUBLISHING.md`.)
2. Watch:
   - `mergen.sendFeedback` clicks in GitHub Discussions
   - First-run walkthrough completion rate (we open it on first activation)
   - `analyses-per-day` reported on `/usage` from telemetry opt-ins
   - Install counts on both registries (MS realtime, Open VSX 24–48 h)
3. After 50 installs (or 1 week, whichever first), iterate on:
   - Disconnected-card copy & buttons (`vscode-extension/src/panel.ts`)
   - Walkthrough markdown (`vscode-extension/media/walkthrough-*.md`)
   - `Mergen: Start Local Server` resolver (`vscode-extension/src/extension.ts`)
4. **Then** submit Cursor MCP directory + Anthropic catalog + awesome-mcp PRs.
   These are *indexes*, not registries — they link back to our listings.
5. Chrome Web Store + Edge Add-ons last — review cycles are 1–3 weeks and
   we don't want them locking in pre-feedback copy.
6. **JetBrains plugin** is v1.1, not v1. JetBrains AI Assistant already
   supports MCP via stdio config so power users can wire Mergen today;
   a native plugin waits until VS Code-side passes ~1 k installs.

---

## 1. Microsoft VS Code Marketplace ⬅ ship first (with Open VSX)

**Listing slug:** `mergen.mergen`
**Status:** ✅ ready to ship — `vsce package` works.

Pre-flight checklist:

- [x] `repository`, `bugs`, `qna`, `homepage` fields set in `package.json`
- [x] `LICENSE` file at the repo root (MIT)
- [x] `vscode-extension/README.md` (Marketplace listing copy)
- [x] `vscode-extension/CHANGELOG.md`
- [x] First-run walkthrough (`mergen.getStarted`) with 3 steps
- [x] Auto-start the local server on activation (`mergen.autoStartServer`)
- [x] Disconnected card has one-click **Start server** / **Install guide**
- [x] `Mergen: Send Feedback` command linking to GitHub Discussions
- [ ] 60-second demo GIF added to `vscode-extension/README.md` top
- [ ] `your-org` placeholders replaced with the real org slug
- [ ] `vsce login mergen` (one-time, requires Azure DevOps PAT)

```bash
cd vscode-extension
npm install
npm run build
npx vsce package          # produces mergen-1.0.0.vsix — sanity-check this first
npx vsce publish          # ships to marketplace
```

Required metadata (already set in `vscode-extension/package.json`):
- ✅ `displayName` — "Mergen — Local-First Runtime Debugging for AI"
- ✅ `description` — leads with "AI-native" + "127.0.0.1"
- ✅ `categories` — `Debuggers`, `Other`
- ✅ `keywords` — `mcp`, `copilot`, `cursor`, `claude`, `local-first`, `privacy`, …
- ✅ `icon` — `icons/icon128.png`
- ⏳ `repository` field (add before publishing)
- ⏳ Marketplace `README.md` (the root `README.md` is the source of truth — copy or symlink)
- ⏳ A 60-second demo GIF at the top (see `docs/DEMO.md`)

---

## 2. Open VSX (Cursor / Windsurf / VSCodium / Gitpod / code-server) ⬅ ship same day as MS

**Listing slug:** `mergen.mergen` on https://open-vsx.org
**Status:** ✅ ready to ship via the same `.vsix` artifact.

This is the **single biggest reach win** after MS Marketplace. Cursor and
Windsurf — our highest-intent users, since they're already an AI IDE —
*cannot* install from the Microsoft gallery for licensing reasons.

```bash
# One-time:
#   • Sign in at https://open-vsx.org with GitHub
#   • Generate a token at https://open-vsx.org/user-settings/tokens
#   • export OVSX_PAT=<token>
#   • npx ovsx create-namespace mergen      # if the slug isn't taken yet

cd vscode-extension
npm run build
npm run publish:openvsx                     # ships the .vsix to Open VSX
```

Or do both registries in one shot:

```bash
npm run preflight && npm run publish:all    # MS + Open VSX
```

See [`docs/PUBLISHING.md`](./PUBLISHING.md) for the full editor-to-registry
map and token-setup walkthrough.

---

## 3. Cursor MCP Directory

**URL:** https://cursor.directory/mcp (community), https://docs.cursor.com/context/model-context-protocol (official integration page)

Submit via PR to https://github.com/cursor-ai/cursor-directory or the equivalent registry.

Submission JSON:

```jsonc
{
  "name": "mergen",
  "displayName": "Mergen",
  "description": "Local-first runtime debugging. Streams browser console, network, and DOM to your AI assistant via MCP. Causally correlated, source-mapped, and never leaves 127.0.0.1.",
  "homepage": "https://mergen.dev",
  "repository": "https://github.com/your-org/mergen",
  "license": "MIT",
  "tags": ["debugging", "browser", "observability", "local-first"],
  "command": "node",
  "args": ["/absolute/path/to/mergen/server/dist/index.js"],
  "tools": [
    "get_status",
    "get_recent_logs",
    "get_network_activity",
    "get_dom_context",
    "clear_buffer",
    "analyze_runtime"
  ]
}
```

---

## 4. Anthropic MCP Catalog

**URL:** https://github.com/modelcontextprotocol/servers

Open a PR adding Mergen to the **Community Servers** section of the README:

```markdown
- **[Mergen](https://github.com/your-org/mergen)** — Local-first browser observability for AI debugging. Streams console, network, and DOM from Chrome/Edge to a 127.0.0.1 server, then exposes a causally-correlated Context Pack via `analyze_runtime`. PII-redacted, no cloud dependency.
```

Also submit to https://modelcontextprotocol.io/examples once it accepts community contributions.

---

## 5. `awesome-mcp-servers`

**URL:** https://github.com/punkpeye/awesome-mcp-servers (the most-trafficked community list)

PR adding under the **🛠️ Developer Tools** or **🐛 Debugging** section:

```markdown
- **[Mergen](https://github.com/your-org/mergen)** — Local-first runtime debugging for AI. Browser → 127.0.0.1 → MCP. Causal chain, ranked hypotheses, source-mapped Context Packs.
```

---

## 6. Chrome Web Store

**Status:** ⏳ extension is MV3-compliant; needs Google Developer account ($5 one-time).

Steps:
1. Zip `extension/` (excluding `node_modules`, `*.log`).
2. Upload at https://chrome.google.com/webstore/devconsole.
3. Submit screenshots: popup, sidebar, welcome page (already in `extension/`).
4. **Privacy disclosure:** declare `host_permissions` on `127.0.0.1:3000–3010` only. No remote code, no analytics. Reference SETUP.md "Telemetry" section.

Listing copy (lifted from `manifest.json` description, expanded):

> Mergen captures `console.*`, fetch, and DOM state from your active tab and forwards them to a local server on 127.0.0.1 — never the internet. Your AI assistant (Copilot, Cursor, Claude) reads them via MCP and diagnoses runtime bugs without you copy-pasting stack traces.
>
> **Privacy:** All data stays on your machine. No accounts. No tracking. PII (JWTs, emails, tokens) is redacted before storage.

---

## 7. Edge Add-ons store

Same artifact as the Chrome Web Store; submit at https://partner.microsoft.com/dashboard/microsoftedge.

---

## 8. JetBrains Marketplace *(v1.1)*

Out of scope for v1 — JetBrains' AI Assistant supports MCP via stdio config, so users can add Mergen by hand today. Consider a JetBrains plugin once the VS Code extension has > 1k installs.

---

## 9. Launch posts

Order matters — go where the AI-native crowd hangs out *first*, then broaden.

1. **Hacker News** — "Show HN: Mergen — local-first runtime debugging for AI assistants"
2. **r/LocalLLaMA** — privacy + local-first angle resonates here
3. **r/ChatGPTCoding**, **r/cursor**, **r/github_copilot**
4. **Twitter / X** — tag `@cursor_ai`, `@AnthropicAI`, `@github`, embed the demo GIF
5. **Product Hunt** — schedule for a Tuesday launch
6. **Dev.to / Hashnode** — long-form: "Why I built a 127.0.0.1-only observability tool for AI assistants"
7. **Indie Hackers** — pricing/MRR transparency post once we hit $1k MRR

---

## Tracking

| Channel              | Submitted | Live | Installs / Stars |
| -------------------- | --------- | ---- | ---------------- |
| VS Code Marketplace  | ⏳        | ⏳   | —                |
| Cursor Directory     | ⏳        | ⏳   | —                |
| Anthropic Catalog    | ⏳        | ⏳   | —                |
| awesome-mcp-servers  | ⏳        | ⏳   | —                |
| Chrome Web Store     | ⏳        | ⏳   | —                |
| Edge Add-ons         | ⏳        | ⏳   | —                |

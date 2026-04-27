# Publishing Mergen to every IDE that matters

> Goal of this doc: make it impossible to ship Mergen to *only* one
> registry. Every IDE our target users actually run (VS Code, Cursor,
> Windsurf, VSCodium, Gitpod, code-server, JetBrains) needs us where it
> looks for extensions.

---

## The IDE-marketplace map

VS Code-family editors all use one of **two** registries. Knowing which
editor pulls from which is what stops us from accidentally shipping to
"only the AI users running stock VS Code."

| Editor                 | Pulls from                | Notes                                      |
| ---------------------- | ------------------------- | ------------------------------------------ |
| **VS Code (MS build)** | Microsoft Marketplace     | The default. `vsce publish`.               |
| **VS Code Insiders**   | Microsoft Marketplace     | Same listing.                              |
| **Cursor**             | **Open VSX**              | Cursor cannot legally use the MS gallery.  |
| **Windsurf** (Codeium) | **Open VSX**              | Same — non-Microsoft fork.                 |
| **VSCodium**           | **Open VSX**              | The libre VS Code; biggest OSS audience.   |
| **Gitpod**             | **Open VSX**              | Cloud IDE; default registry.               |
| **code-server**        | **Open VSX**              | Self-hosted browser VS Code.               |
| **GitHub Codespaces**  | Microsoft Marketplace     | Bundled with VS Code.                      |
| **JetBrains IDEs**     | JetBrains Plugin Repo     | Different format — **v1.1**, not v1.       |
| **Claude Desktop**     | npm (`mergen-server`)     | Configured via `claude_desktop_config.json`. |
| **Continue / Cline / Zed** | npm (`mergen-server`) | Generic MCP stdio host — same `npx` install. |

> **The bottom line:** publishing only to the MS Marketplace cuts us off
> from Cursor and Windsurf — exactly the AI-IDE users we want most.
> **Open VSX is Tier-1, not Tier-2.** And the npm package is what
> every non-VS Code AI host (Claude Desktop, Cline, Continue, Zed)
> actually installs — see `mcp/` for the marketplace manifests that
> wrap it.

---

## The MCP marketplaces (parallel surface)

VS Code + Open VSX cover the *IDE extension*. The MCP marketplaces below
list the *server* — they're how users who already have an AI host shop
for tools. All of them install the same `mergen-server` npm package, so
**there is one binary to maintain, ten places it shows up.**

| Marketplace            | Manifest in repo            | Submission                                    |
| ---------------------- | --------------------------- | --------------------------------------------- |
| **Smithery**           | `mcp/smithery.json`         | `smithery.ai` → New Server → upload manifest  |
| **Glama**              | `mcp/glama.json`            | PR to `punkpeye/glama-mcp-registry`           |
| **mcp.so**             | `mcp/mcp-so.yaml`           | PR to `chatmcp/mcp-directory`                 |
| **PulseMCP**           | `mcp/pulsemcp.json`         | Submit form on pulsemcp.com                   |
| **Cursor Directory**   | `mcp/cursor-directory.json` | PR to `pontusab/cursor.directory`             |
| **Anthropic catalog**  | `mcp/claude-desktop.json`   | PR to `modelcontextprotocol/servers`          |
| **awesome-mcp-servers**| (one-line README entry)     | PR to `punkpeye/awesome-mcp-servers`          |

See [`mcp/README.md`](../mcp/README.md) for the full submission playbook
and [`mcp/install-buttons.md`](../mcp/install-buttons.md) for the
one-click install badges to paste at the top of `README.md`.

---

## One-time token setup

You need two API tokens. Both are free; both are 5 minutes of paperwork.

```bash
# Microsoft Marketplace — Azure DevOps Personal Access Token
# Scope: "Marketplace > Manage". https://dev.azure.com → user settings → PATs
export VSCE_PAT=<your token>

# Open VSX — Eclipse Foundation account token
# https://open-vsx.org/user-settings/tokens   (sign in with GitHub)
export OVSX_PAT=<your token>
```

Drop those into `~/.zshrc` or your secrets manager. CI uses the same env
vars; no source changes needed.

You also need a publisher namespace on each registry:

- Microsoft: `vsce create-publisher mergen` (one-time, requires Azure DevOps)
- Open VSX:  the namespace is created the first time you `ovsx publish`.
  If the slug `mergen` is already taken, run `ovsx create-namespace mergen`
  and contact open-vsx.org ops to claim it (usually < 24 h).

---

## Publish in one command

From `vscode-extension/`:

```bash
npm run preflight        # sanity-check before anything moves
npm run publish:all      # build → package → vsce publish → ovsx publish → npm publish (mergen-server)
```

The pre-flight script (`scripts/preflight.mjs`) refuses to ship if it
finds:

- Unset `publisher`, `repository`, `homepage`, `bugs`
- Missing `LICENSE`, `README.md`, `CHANGELOG.md`, `dist/extension.js`
- Walkthrough media files referenced in `package.json` that don't exist
- The literal string `omertt27` anywhere in `package.json` or `README.md`
- Missing `VSCE_PAT` / `OVSX_PAT` (warning only — `vsce login` works too)

If you only want to push to one registry:

```bash
npm run publish:vscode   # Microsoft Marketplace only
npm run publish:openvsx  # Open VSX only (Cursor / Windsurf / VSCodium / Gitpod)
npm run publish:npm      # npm only — Claude Desktop / Cline / Continue / Zed / MCP marketplaces
```

---

## Sequencing for v1

We want **one launch announcement** that covers every VS Code-family IDE.
The sequence is:

1. **Day 0** — `npm run publish:all` ships to MS Marketplace + Open VSX
   simultaneously. Both listings live within 5 min.
2. **Day 0–7** — watch first 20–50 installs across both registries.
   Open VSX usually takes 24–48 h to show install counts; MS is realtime.
3. **Day 7+** — submit to the curated *directories* (these aren't
   registries; they're indexes that link back):
   - Cursor MCP directory (PR to `cursor-ai/cursor-directory`)
   - Anthropic MCP catalog (PR to `modelcontextprotocol/servers`)
   - `awesome-mcp-servers` (PR to `punkpeye/awesome-mcp-servers`)
4. **Day 14+** — Chrome Web Store + Edge Add-ons for the *browser*
   extension. Their review cycles are 1–3 weeks, so we want post-feedback
   copy locked in first.

---

## JetBrains (v1.1, not v1)

JetBrains' AI Assistant supports MCP via stdio config today, so users on
IntelliJ / PyCharm / WebStorm can already wire Mergen by hand. A native
plugin needs a Kotlin shim around the MCP server and a separate
`plugin.xml`. Open the door once VS Code-side hits ~1 k installs — the
JetBrains review cycle is real (1–2 weeks) and we want the messaging
proven first.

Track this in [#jetbrains-plugin](https://github.com/omertt27/Mergen/labels/jetbrains).

---

## What about updates?

Both registries pick up new versions automatically when you bump
`vscode-extension/package.json#version` and re-run `npm run publish:all`.

- MS shows the new version within ~30 s.
- Open VSX usually takes 1–2 min, sometimes up to 10 min during peak.
- Users on auto-update get the new build within 24 h with no action.

If you publish a broken build, **unpublish from MS only as a last resort**
(it loses install-count history). Prefer shipping `1.0.X+1` with the fix.

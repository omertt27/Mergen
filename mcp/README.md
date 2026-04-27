# MCP Marketplace Submissions

> **Strategy.** VS Code-family marketplaces (MS + Open VSX) cover the IDE
> *surface*. The MCP marketplaces below cover the *server* — they're how
> Cursor, Claude Desktop, Continue, Cline, Zed, and the other AI hosts
> discover Mergen. Both halves matter: the IDE listing wins drive-by
> users; the MCP listings win users who already have an AI assistant and
> are shopping for tools.

## What ships from this folder

| File | Target | Format |
|---|---|---|
| `smithery.json`         | [Smithery](https://smithery.ai)             | Smithery server manifest (canonical) |
| `glama.json`            | [Glama](https://glama.ai/mcp/servers)       | Glama server manifest |
| `mcp-so.yaml`           | [mcp.so](https://mcp.so)                    | YAML front-matter for the listing PR |
| `pulsemcp.json`         | [PulseMCP](https://www.pulsemcp.com)        | PulseMCP submission JSON |
| `cursor-directory.json` | [Cursor Directory](https://cursor.directory)| `cursor-directory` PR payload |
| `claude-desktop.json`   | Claude Desktop config snippet               | What we paste into the Anthropic catalog |
| `install-buttons.md`    | README install buttons                      | One-click deeplinks for Cursor / VS Code / Claude |

The **same `npx -y mergen-server` command** is the entry point in every
manifest. That's deliberate — one publish, one binary, ten listings.

## Prerequisites (one-time)

```bash
# 1. Publish the MCP server to npm so every marketplace can `npx` it.
cd server
npm version 1.0.0           # only if not already at 1.0.0
npm publish --access public # name is `mergen-server`

# 2. The IDE extension is published separately — see docs/PUBLISHING.md.
```

`npm publish` is what turns "git clone + build" into "one line in
mcp.json", which is what every marketplace below actually requires.

## Submission order

Same philosophy as `docs/DISTRIBUTION.md`: **don't open every channel
before onboarding is solid.** Land MS + Open VSX, watch 20–50 installs,
fix friction, *then* fan out.

1. **Day 0** — npm publish + MS + Open VSX (covers ~99% of IDE installs).
2. **Day 7+** — Smithery + Glama + mcp.so + PulseMCP (the 4 active MCP marketplaces).
3. **Day 7+** — Cursor directory + Anthropic `modelcontextprotocol/servers` catalog.
4. **Day 14+** — `awesome-mcp-servers` + `awesome-cursor` PRs.

Each `*.json` / `*.yaml` here is the exact payload to submit; copy-paste
or attach to the PR. Any field that's a placeholder is marked with
`TODO:` and surfaced by the preflight script.

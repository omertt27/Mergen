# One-Click Install Buttons

These are the deeplinks every IDE / AI host now supports for installing
an MCP server with a single click. Paste them at the **top** of the
repo `README.md` so Marketplace and directory traffic lands on a button,
not a `git clone`.

> All buttons resolve to the same payload — `npx -y mergen-server` — so
> there is one source of truth and one binary to maintain.

## Markdown to paste in `README.md`

```markdown
[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_MCP-007ACC?logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect/mcp/install?name=mergen&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22mergen-server%22%5D%7D)
[![Install in Cursor](https://img.shields.io/badge/Cursor-Install_MCP-000000?logo=cursor&logoColor=white)](https://cursor.com/install-mcp?name=mergen&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIm1lcmdlbi1zZXJ2ZXIiXX0%3D)
[![Install in Claude Desktop](https://img.shields.io/badge/Claude_Desktop-Add_via_config-D97757?logo=anthropic&logoColor=white)](https://github.com/omertt27/Mergen/blob/main/mcp/claude-desktop.json)
[![Install in Smithery](https://smithery.ai/badge/mergen)](https://smithery.ai/server/mergen)
```

## How each button works

| Button             | Mechanism                                                                                       |
| ------------------ | ----------------------------------------------------------------------------------------------- |
| **VS Code**        | `vscode.dev/redirect/mcp/install` — opens VS Code, prompts "Install MCP server `mergen`?"       |
| **Cursor**         | `cursor.com/install-mcp` with base64-encoded config — opens Cursor's MCP install confirm sheet  |
| **Claude Desktop** | Anthropic doesn't have a deeplink yet; the badge links to a JSON snippet the user copy-pastes   |
| **Smithery**       | `smithery.ai` walks the user through `npx @smithery/cli install mergen --client <name>`         |

If a future IDE ships a deeplink scheme (Windsurf is rumored to be next),
add the badge here and re-paste the block into `README.md`. **Do not**
fork the install command per IDE — keep them all pointed at
`npx -y mergen-server`.

## Verifying the deeplinks

```bash
# Decode the Cursor base64 to confirm the payload before publishing
echo 'eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIm1lcmdlbi1zZXJ2ZXIiXX0=' | base64 -d
# → {"command":"npx","args":["-y","mergen-server"]}
```

The preflight script (`vscode-extension/scripts/preflight.mjs`) does
**not** validate these — they're a separate publish surface from the
.vsix. Re-run the decode above whenever the install command changes.

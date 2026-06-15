# ADR-002: MCP protocol over custom REST for AI IDE integration

**Date:** 2024-02-01
**Status:** Accepted

## Decision

Expose Mergen's analysis and triage capabilities as Model Context Protocol (MCP) tools over stdio transport, rather than a proprietary REST API that each AI IDE would need to integrate separately.

## Alternatives considered

- **Custom REST API with IDE plugins** — rejected: every IDE would need a bespoke plugin; the integration surface multiplies with each new IDE, and the AI model would have no standard way to discover or call tools.
- **Language Server Protocol (LSP)** — rejected: LSP is designed for code intelligence (completions, diagnostics), not arbitrary tool invocation; mapping incident triage onto LSP semantics would be a square-peg-in-round-hole adaptation.
- **OpenAI function-calling format** — rejected: not IDE-agnostic; tightly couples Mergen to a single model vendor.

## Rationale

MCP is the emerging standard for AI tool exposure. A single MCP server declaration in a project config file (`.cursor/mcp.json`, `.vscode/mcp.json`) immediately surfaces all Mergen tools in every compatible IDE. The stdio transport requires no network port, simplifying local security. As more IDEs adopt MCP, Mergen's integration footprint grows for free.

## Consequences

- The HTTP server (`:3000`) and the MCP server (stdio) are separate processes sharing state via the in-memory buffer; both are started by `index.ts`.
- Tool schemas must conform to MCP's JSON Schema constraints; Zod is used for both validation and schema generation.
- MCP version upgrades (`@modelcontextprotocol/sdk`) may require updating tool registration patterns.

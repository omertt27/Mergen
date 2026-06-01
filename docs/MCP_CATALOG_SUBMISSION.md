# Submitting Mergen to the Anthropic MCP Catalog

This guide is a practical checklist for listing Mergen in the Anthropic / Model Context Protocol community server catalog.

## Submission Checklist

Before opening the PR, make sure the following are ready:

- [ ] Public GitHub repository with clear README and install instructions
- [ ] Working server entry point for stdio MCP usage
- [ ] Tool list documented clearly (`get_recent_logs`, `get_network_activity`, `clear_buffer`)
- [ ] Example configuration for at least one MCP client
- [ ] License file present in the repository
- [ ] Short catalog description prepared
- [ ] Category decided
- [ ] Screenshots or demo material available for curious reviewers (optional but helpful)
- [ ] Any setup caveats called out clearly (Chrome extension requirement, localhost ingest, local-first design)
- [ ] Tool behavior verified end-to-end before submission

## Server Description (for catalog listing)

Mergen is a local-first browser debugging MCP server for AI IDEs. It captures browser console logs, network activity, and context snapshots via a Chrome extension, stores them locally, and exposes debugging tools over MCP so clients like Claude Code, Cursor, and VS Code Copilot can inspect live frontend telemetry.

Mergen is designed for development-time diagnosis rather than production monitoring, with source-map de-minification, PII redaction at the edge, and browser-to-IDE debugging workflows that stay on localhost.

## Tool Descriptions (for catalog)

### `get_recent_logs`
Returns recent browser console events, with optional filtering by log level and timestamp.

### `get_network_activity`
Returns recent fetch/XHR activity, with optional filtering by HTTP status and timestamp.

### `clear_buffer`
Clears the in-memory event buffer used for the current debugging session.

## Submission Steps

1. Review the community servers repository:
   https://github.com/modelcontextprotocol/servers
2. Open the catalog source file referenced by the maintainers:
   https://github.com/modelcontextprotocol/servers/blob/main/README.md
3. Fork the repository if you do not already have write access.
4. Add Mergen to the appropriate **community servers** section in `README.md`.
5. Include:
   - project name
   - short description
   - repository link
   - install or usage hint if the section format allows it
6. Commit the change in your fork.
7. Open a pull request explaining what Mergen does and why it belongs in the catalog.
8. Monitor maintainer feedback and update the listing copy if requested.

## Category

**Suggested category:** `Browser / Web Development / Debugging`

If the catalog uses broader buckets, Mergen should still be described as a browser debugging / web development MCP server rather than a general observability platform.

## Differentiators to Highlight

- **Local-first browser telemetry for AI IDEs:** console logs and network events flow directly from the browser to MCP tools on localhost.
- **Diagnosis-oriented workflow:** source-map de-minification, causal analysis, and detector-based ranking make it more than a raw event pipe.
- **Privacy-conscious developer experience:** localhost-only ingest and edge redaction help keep sensitive debugging data off external services.

---

**Note:** The submission is a PR to https://github.com/modelcontextprotocol/servers/blob/main/README.md adding Mergen to the community servers list.

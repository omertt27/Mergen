# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| Latest (main) | ✅ |
| Older releases | ❌ — please upgrade |

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Email **security@mergen.dev** with:

1. A description of the vulnerability and its potential impact
2. Steps to reproduce (proof of concept, if applicable)
3. Affected versions
4. Any suggested mitigations

We will acknowledge your report within **48 hours** and aim to release a fix within **14 days** for critical issues, **30 days** for high severity.

We follow responsible disclosure: we ask that you give us 90 days before public disclosure to allow us to ship a fix and notify users.

## Scope

In-scope:
- The Mergen server (`server/`)
- The MCP tool-guard and policy engine
- The CLI and setup wizard
- The browser extension (`extension/`)

Out of scope:
- Attacks requiring physical access to the machine running Mergen
- Social engineering
- Issues in third-party dependencies (please report those upstream)

## Security Assumptions

Mergen is designed to run locally on a developer's machine (bound to `127.0.0.1` by default). The threat model assumes:

- The local machine is trusted
- Inbound network connections to the server are from the developer or their tools
- In team/cloud mode (`MERGEN_BIND=0.0.0.0`), TLS + API key authentication is required

See `CLAUDE.md` for environment variable configuration for hardened deployments.

# Contributing to Mergen

## Governance model: Public Source, Closed Development

Mergen is **public-source infrastructure** — the source code is published so that enterprise security teams, CISOs, and platform engineers can audit our PII shield, command allowlist, and autonomous execution logic before deploying Mergen inside their production VPCs.

**It is not a community-development project. We do not accept external pull requests.**

This is a deliberate architectural and security decision, not a bandwidth problem:

> *"Mergen is local-first, public-source infrastructure with autonomous production execution rights. Because our server controls live remediation commands inside enterprise VPCs, we maintain strict code-signing and architectural governance. We do not accept external pull requests to guarantee absolute supply-chain security and mathematical calibration integrity for our enterprise clients."*

---

## Why no external PRs?

### 1. Supply-chain security
Mergen executes autonomous remediation commands (`MERGEN_AUTOPILOT=true`) inside your production infrastructure. Every line of server code is reviewed and signed by the core team before it ships. We cannot make that guarantee for external contributions.

### 2. Calibration integrity
The Hypothesis Engine's confidence thresholds are mathematically calibrated against our incident corpus. External modifications to detection or scoring logic would corrupt the calibration and produce false positives or missed incidents — directly affecting production systems.

### 3. Execution speed
At our current stage, every sprint is focused on product-market fit and enterprise ARR. Open governance adds review overhead that is incompatible with our velocity requirements.

---

## How you can participate

| Channel | Use for |
|---------|---------|
| [💬 GitHub Discussions](https://github.com/omertt27/Mergen/discussions) | Questions, ideas, debugging patterns, design feedback |
| [🐛 GitHub Issues](https://github.com/omertt27/Mergen/issues) | Confirmed bugs with reproduction steps |
| [🗺️ ROADMAP.md](./ROADMAP.md) | See what's planned and vote with reactions |
| [📧 Enterprise](https://mergen.dev/pricing) | Custom integrations, SLAs, on-prem support |

We read every Discussion and Issue. Strong ideas land on the roadmap. The [VS Code feedback buttons](./vscode-extension/) (👍/👎 on hypotheses) directly improve the Hypothesis Engine's calibration corpus — that is the highest-signal contribution path available.

---

## What the open-source layer is for

The following components are MIT-licensed and their source is published for transparency and SDK reuse:

| Path | Purpose |
|------|---------|
| `extension/` | Chrome/Edge browser extension — audit our data collection |
| `extension-firefox/` | Firefox browser extension |
| `vscode-extension/` | VS Code sidebar extension |
| `packages/` | `mergen-node` and `mergen-python` SDKs |
| `sdk/` | Integration helpers and plugins |
| `server/src/sensor/` | Ingest pipeline, ring buffer, event schemas |
| `server/src/routes/` | HTTP API routes |
| `server/src/app.ts` | Express application factory |
| `server/src/index.ts` | Boot entrypoint |
| `scripts/` | Setup and tooling scripts |

The **Hypothesis Engine** (`server/src/intelligence/`) is licensed under the [Elastic License 2.0](./LICENSE). It is published for auditability but may not be used to build a competing hosted or managed service.

---

## License

By interacting with this repository you agree to the terms described in [LICENSE](./LICENSE).

- **MIT layer** (extensions, SDKs, routes, ingest): standard MIT terms
- **ELv2 layer** (Hypothesis Engine): you may use, audit, and modify for internal purposes; you may not offer it as a managed service

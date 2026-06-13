## ⚠️ Mergen does not accept external pull requests

Mergen is **public-source, closed-governance** infrastructure.

The source code is published for **auditability and transparency** — enterprise security teams and CISOs need to verify our PII shield, command allowlist, and autonomous execution logic before deploying Mergen inside their production VPCs. That is the purpose of public source.

It is **not** a community-development project. We do not accept external pull requests because:

1. **Supply-chain security** — Mergen executes autonomous remediation commands inside your infrastructure. Every line of server code must be signed and audited by the core team before it can run in production environments. We cannot make that guarantee for external contributions.

2. **Calibration integrity** — The Hypothesis Engine's confidence scores are mathematically calibrated against our incident corpus. External modifications to detection logic would break calibration and produce incorrect confidence values, which could cause autonomous actions to fire at the wrong threshold.

3. **Venture-scale execution speed** — At our current stage, our only job is to find product-market fit. We ship at a pace that is incompatible with the review overhead of open governance.

---

### How to contribute ideas

If you have a suggestion, bug report, or feature request:

- 💬 **[Open a Discussion](https://github.com/omertt27/Mergen/discussions)** — for questions, ideas, and design feedback
- 🐛 **[Open an Issue](https://github.com/omertt27/Mergen/issues)** — for confirmed bugs with reproduction steps

We read everything and incorporate the good ideas into our roadmap.

---

*We appreciate your interest in Mergen. This PR will be closed.*

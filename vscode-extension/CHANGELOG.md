# Changelog

## 1.0.0 — 2026-04-27

Initial public release on the VS Code Marketplace.

### Continuous-watch model
- Mergen now produces a fresh diagnosis on every pageload, hot-reload,
  network burst, and 15 s idle tick — not just on `console.error`.
- New silent-failure detectors: slow API (no error fired) and empty 2xx
  response.
- New `/timeline` endpoint — text-based session replay.

### VS Code extension
- Three-step **Get Started with Mergen** walkthrough on first activation.
- Auto-start local server on activation (configurable via
  `mergen.autoStartServer`).
- Disconnected card now offers one-click **Start local server**, **Install
  guide**, and **Send feedback** buttons.
- New settings: `mergen.serverPath`, `mergen.autoStartServer`.
- New commands: `Mergen: Start Local Server`, `Mergen: Open Browser-Extension
  Install Guide`, `Mergen: Send Feedback`.
- Status bar surfaces analyses-per-day count alongside live error counts.

### CLI
- New `mergen guard` pre-commit subcommand: fails the commit when an
  unresolved HIGH-confidence runtime anomaly sits in the buffer. Flags:
  `--warn`, `--min-confidence LOW|MEDIUM|HIGH`.

### Calibration & accountability
- Every hypothesis now ships with a stable prediction id, a verdict button
  (✅ correct / ❌ wrong / ◐ partial), and an inline accuracy badge —
  trust is binary, so we let users verify it.
- Hypotheses are ranked by `confidence × historical accuracy`, not raw
  confidence. A detector that lies five times in a row is automatically
  demoted (HIGH → MEDIUM) or suppressed (`accuracy < 20%`).
- New panel section: **Detector Health** dashboard — per-detector
  accuracy, 7-day trend (↑ / ↓), sample size, and the most-frequent
  "often incorrect when:" notes from real users.
- Status-bar nudges only fire from detectors with ≥ 60% accuracy and
  ≥ 5 verdicts. Untrusted detectors stay quiet until they earn trust.
- New command: **Mergen: Show Detector Accuracy** — Quick Pick listing
  every detector with its track record.
- New endpoints: `POST /feedback`, `GET /calibration`,
  `GET /calibration/export` (RFC-4180 CSV — privacy-safe by construction;
  the calibration ring only ever stores tag, confidence, verdict, and an
  optional ≤ 140-char note).

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

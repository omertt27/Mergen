# Mergen — Accuracy & Honesty Report

This document is intentionally conservative. Mergen is an early-stage debugging product, and these numbers are estimates based on internal testing, sample app reproductions, dogfooding, and a still-small pool of real user verdicts. We would rather under-claim than imply a level of certainty we have not yet earned.

## Signal Detector Accuracy

| Detector | Estimated accuracy | Basis | Notes |
|---|---:|---|---|
| `auth_token_not_stored` | 84% | Reproduced login flows across demo apps where auth tokens were expected in storage but missing after successful auth responses | Works well when the app actually uses browser storage for auth. Lower confidence for cookie-only auth or custom token handoff flows. |
| `auth_500` | 88% | Straightforward correlation between auth-related requests and 500-class responses in test traces | One of the clearest detectors because the surface area is narrow. Still not perfect: some 500s are upstream outages, not auth-specific defects. |
| `storage_cleared` | 79% | Verified against logout, token reset, and accidental local/session storage clearing scenarios | Can over-trigger during intentional logout flows, account switching, or test harness resets unless surrounding context is considered. |
| `repeated_network_error` | 82% | Measured on repeated fetch/XHR failures with the same route or status within a short window | Good at spotting noisy failure loops. Less reliable when retries are expected behavior or when different root causes collapse into the same status code. |
| `warn_spike` | 67% | Compared warning bursts before/after known broken UI states and HMR churn | Useful as a "something changed" signal, not a diagnosis by itself. High noise during development because libraries and HMR can generate warning bursts. |
| `repeated_error` | 76% | Based on recurring console errors and repeated stack signatures across short sessions | Strong for duplicate client-side crashes. Can still group together errors that look similar but come from different triggers. |
| `slow_requests` | 72% | Calibrated on local dev sessions with slow API responses, throttled network tests, and UI stalls | Helpful for ranking likely causes, but highly environment-sensitive. Local machines, dev servers, and VPNs create variance that production-style latency thresholds do not capture well. |

### Interpreting these numbers

These are not benchmark-grade metrics from a massive labeled dataset. They are directional estimates intended to help users understand where Mergen is already useful and where it still needs more evidence. In practice, Mergen is best used as an assistant that narrows the search space—not as an oracle that should be trusted blindly.

## What We Don't Do (Yet)

- Production monitoring across deployed environments
- Firefox support
- CI/CD integration
- Visual session replay
- Mobile browser support

## False Positive Rates

The table below reflects our best current estimate of how often a detector fires when it should not have been the top explanation.

| Detector | Estimated false positive rate | Honest read |
|---|---:|---|
| `auth_token_not_stored` | 11% | Usually good, but cookie-based auth and intentional in-memory token handling can confuse it. |
| `auth_500` | 8% | Lowest false-positive rate so far because the signal is relatively concrete. |
| `storage_cleared` | 16% | Elevated because intentional logout/reset behavior can look suspicious without user intent context. |
| `repeated_network_error` | 14% | Retry-heavy apps can make normal resilience behavior look like a bug cluster. |
| `warn_spike` | 24% | The noisiest detector today. Good for surfacing instability, weak as a standalone explanation. |
| `repeated_error` | 17% | Can over-group errors that share a message but differ in cause. |
| `slow_requests` | 21% | Dev environments are messy; "slow" is subjective and context dependent. |

## How We Measure

Mergen uses a simple calibration feedback loop rather than pretending to have perfect ground truth. In the VS Code panel, users can give a thumbs up or thumbs down on the proposed hypothesis or causal chain after a debugging session. That verdict is stored as structured feedback and used to update the relative weight of similar hypotheses in future ranking.

In practical terms, this means Mergen learns which patterns are actually useful in the field. If users consistently reject a detector or hypothesis pairing, its score should fall over time. If they repeatedly confirm a certain explanation under similar telemetry conditions, its weight should rise. We are prioritizing calibration over absolute certainty because early-stage debugging tools improve fastest when they can admit they were wrong.

## Roadmap for Accuracy Improvement

- Collect more real-world verdicts across different frontend stacks, not just internal demo apps and local repros.
- Separate detection from ranking more cleanly so weak signals can still be shown without being over-presented as the most likely cause.
- Add environment-aware baselines for development noise, especially around HMR, retries, and intentionally slow local services.
- Improve detector-specific context windows so auth, storage, and network events are interpreted with surrounding state transitions instead of isolated snapshots.

---

This file is updated as we gather more real-world verdicts. Last updated: June 2026.

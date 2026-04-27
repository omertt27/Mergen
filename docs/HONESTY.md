# How we know Mergen is actually useful

> A note for skeptical senior engineers — and a contract with ourselves.
> If any claim below stops being true, that's a release-blocking bug.

A senior engineer's first reaction to a tool like Mergen is the right
one: "Cool demo. But is the signal actually good, or is it a confident
wrapper around `console.log`?" This document is how we answer that
without marketing.

## The four questions and how we measure them

### 1. Is the signal actually good?

**Risk:** A detector says HIGH and is wrong. Trust collapses on the spot.

**What we ship to make this measurable:**

- Every hypothesis the engine produces gets a stable **prediction id**
  (`pid`) before it's surfaced. See `server/src/calibration.ts`.
- The user (or the IDE panel, or the AI host) can `POST /feedback {pid,
  verdict}` to tell us whether the call was right. Three verdicts:
  `correct`, `wrong`, `partial`.
- After **5 verdicts** on a detector tag, that detector is **trusted**.
  - If empirical accuracy < **50%** → next prediction is **demoted one
    band** (HIGH→MEDIUM, MEDIUM→LOW).
  - If accuracy < **20%** → the detector is **suppressed entirely**.
- `GET /calibration` exposes a per-detector accuracy table so anyone
  can audit the engine's own track record.

**Where to look:** `server/src/calibration.ts`,
`server/src/__tests__/calibration.test.ts`. The calibration suite is
**release-blocking** — a regression there can't ship.

**What this rules out:** A noisy heuristic cannot get away with
shouting HIGH forever. The system disciplines itself; the user never
has to disable anything by hand.

### 2. Is this faster than debugging manually?

**Risk:** Mergen takes more attention than reading the logs would.

**What we ship to make this measurable:**

- The Context Pack must render **≤ 2 s after the trigger event**
  (pageload, error, HMR, network burst). The watcher debounces to 2 s
  by design — see `hypothesis-history.REBUILD_DEBOUNCE_MS`.
- The North-Star metric on `/usage` is **analyses per developer per
  day**. If it stays at 0–1 we're not in the loop; if it climbs to 5+
  per active day we're a habit. Either is data.
- `mergen guard` (the pre-commit hook) gives a **binary** answer in
  < 200 ms — no reading, no thinking. Engineers either accept the
  result or they don't; either way it cost nothing.

**What this rules out:** "Death by sophistication." If a result needs
> 3 s of reading to act on, it's a bug, not a feature.

### 3. Does this work on real apps?

**Risk:** Looks great on a clean Vite demo; falls apart on a 500-component
React app with retries, race conditions, and noisy third-party scripts.

**What we ship to make this measurable:**

- **PII redaction at ingest** (`server/src/redact.ts`) so we can run on
  apps that handle real user data without anyone needing to file a
  security review.
- **Body clamping at the edge** (8 KB default) so a 12 MB analytics
  POST doesn't poison the buffer.
- **Bounded everything**: ring buffer (50 free / 200 paid), 20-entry
  hypothesis history, 500-record calibration ring. No unbounded growth.
- **Detector confidence floors** (`MIN_SIGNAL_CONFIDENCE = 0.45`,
  `MIN_HYPOTHESIS_SCORE = 0.25`) keep weak signals out of the panel
  even before calibration kicks in.
- **Same-trigger de-dupe** in `hypothesis-history` — a reload loop
  doesn't flood the panel with 50 identical entries.

**Honest gaps (we will tell you, not hide):**

- We do not yet detect React-specific state-update races. A detector
  for "setState called on unmounted component → fetch responded after
  unmount" is on the roadmap.
- We do not parse source maps for chunked Webpack output above 5 MB
  per chunk (memory cap). On those apps the stack frames stay
  minified — open an issue with a repro.

### 4. Why isn't this built into the platform?

**Risk:** "OpenAI / Anthropic / Chrome will ship this in 6 months."

**Honest answer:** They might ship a *part* of it. The defensible
shape is the **specific, opinionated combination**:

1. **Local-first.** A platform vendor's incentives push toward cloud
   buffers; ours push the opposite way. Air-gapped enterprises and
   privacy-skeptical solos can use Mergen, period.
2. **Causal correlation across console + network + DOM** in a 30-second
   window — not three separate panels.
3. **Ranked hypotheses with a feedback loop** — the calibration layer
   above is what makes "ranked" mean something past week one.
4. **MCP-native from day zero.** Anything a platform ships will be
   bolted-on chat. Mergen *is* the tool surface.

If a platform vendor builds all four of those, we lose, and that's
fine — the user wins, which is the only outcome that matters. Until
then we're alone in this slot.

## What to do when this stops being true

If you find a `HIGH` that's wrong:

```bash
curl -s http://127.0.0.1:3000/last-pack | jq '.topHypothesis.pid' \
  | xargs -I{} curl -s -X POST http://127.0.0.1:3000/feedback \
      -H 'content-type: application/json' \
      -d '{"pid":"{}","verdict":"wrong"}'
```

Five of those on the same tag and the next prediction will be demoted.
Ten and the detector goes quiet. **The system gets better the more
mistakes you tell it about.** That's the contract.

## What we explicitly refuse to do

- We will not surface a hypothesis without a `pid` attached. No pid
  means no accountability, which means we won't show it.
- We will not raise a demoted detector back to HIGH automatically. A
  detector that has lied to you needs human re-trust (re-trained or
  rewritten) — not a sliding-window memory hole.
- We will not put marketing words like "AI-native" into a code comment.
  Either it's measurable or it's not in the repo.

— the maintainers, April 2026

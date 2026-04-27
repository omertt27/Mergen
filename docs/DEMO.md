# Demo Recording Script — 60-second GIF

> **Goal:** Show "bug → Context Pack → fix" in under 60 seconds, single take, no narration. This GIF goes at the top of the README, the VS Code Marketplace listing, the Chrome Web Store listing, and every launch post.

---

## Setup (one-time)

1. Use a clean macOS user account with the **Tokyo Night** VS Code theme and **JetBrains Mono 14pt**.
2. Window size: **1280 × 800** (matches Marketplace recommendation; renders crisp at 2× retina).
3. Recording tool: **Kap** (https://getkap.co) → export as GIF, target ≤ 4 MB.
4. Hide the dock, menu bar, and any notification badges.
5. Pre-stage:
   - VS Code open with `examples/buggy-react-app` (a small React app that crashes on a 401).
   - Chrome with the buggy app loaded at `http://localhost:5173`, DevTools **closed** (this is the point).
   - Mergen server running (`mergen start`), Mergen sidebar visible in VS Code.
   - Copilot Chat panel open and empty.

---

## The shot list (60 seconds, no cuts)

| t (s) | Action | What the viewer sees |
| ----- | ------ | -------------------- |
| 0–3   | Cursor on the React form. Click **"Sign in"**. | Form posts. Page goes blank. |
| 3–6   | Camera (no mouse) glances to the **Mergen sidebar**. | Status bar flips from `✓ Mergen` to `❌ Mergen 1 err`. Sidebar pops a red **Context Pack** card with `auth_500` tag, 87% confidence. |
| 6–10  | Mouse moves to sidebar. Hover the Context Pack card. | "POST /api/login → 401 (Unauthorized) — token cleared from localStorage 240ms before error." Fix hint visible: 💡 *"Refresh-token endpoint is returning 401; bearer is being cleared by interceptor on line 42 of `auth.ts`."* |
| 10–13 | Click **→ Send to AI Chat**. | Copilot Chat opens with the Context Pack pre-pasted as the user message. |
| 13–18 | Hit **Enter**. | Copilot streams a one-paragraph diagnosis + a code edit suggestion targeting `auth.ts:42`. |
| 18–24 | Click **Apply** on the suggested edit. | The diff lands. Save (`⌘S`). |
| 24–30 | Switch to Chrome. **Hard reload** (⌘⇧R). Re-submit the form. | Login succeeds. Dashboard renders. |
| 30–35 | Glance back at sidebar. | Status bar back to `✓ Mergen`. **Recent Diagnoses** card now shows the just-fixed `auth_500` entry with a ✅ tag. |
| 35–60 | Hold on the green "Mergen ✓" status bar with the dashboard visible behind. | Title overlay fades in: **"30 seconds. Bug to fix. Nothing left the laptop."** |

---

## Title card (last 3s, optional)

Black background, white type:

```
mergen
local-first runtime debugging for AI

→ github.com/your-org/mergen
```

---

## Variants to record from the same take

| Variant      | Length  | Used for                         |
| ------------ | ------- | -------------------------------- |
| `hero.gif`   | 60s     | README, Marketplace, Chrome Store |
| `quick.gif`  | 12s     | Twitter / X (auto-loop)           |
| `still.png`  | 1 frame | OG image, Hacker News thumb       |

Frame for the still: t = 8s, the moment the Context Pack card is fully expanded with the fix hint visible. This is the "money shot" — the entire pitch in one image.

---

## Copy that ships *with* the GIF

Use exactly this caption everywhere:

> **The 30 seconds between a bug appearing in your browser and the fix landing in your editor — and nothing in between leaves your laptop.**

Do not vary it. Repetition is the marketing.

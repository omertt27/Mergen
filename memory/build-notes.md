---
name: build-notes
description: Known build quirks, pre-existing TypeScript errors, node_modules issues
metadata:
  type: project
---

**Pre-existing TS2589 errors that do NOT block emit:**
- `src/intelligence/layer-tools.ts(10,3)` — Type instantiation too deep (Zod schema complexity)
- `src/intelligence/tools.ts(60,3)` — Same issue in get_recent_logs inputSchema

These cause `tsc` to exit code 2 but still emit JS. The `&&` in `npm run build` short-circuits, so run `node scripts/build-cli.mjs` manually after `tsc` if needed.

**Memory-hungry tsc:** `tools.ts` is 2200+ lines of Zod schemas. Normal `npm run build` OOMs at default heap. Run locally with `NODE_OPTIONS="--max-old-space-size=8192" npm run build`. CI sets this via step-level `env:` in both `test.yml` and `release.yml`.

**Corrupted node_modules (fixed 2026-06-03):** `debug@2.6.9` and `ipaddr.js@1.9.1` were missing their `src/` and `lib/` directories. Fixed with `rm -rf node_modules && npm install`.

**Why:** The node_modules had a partial installation from a previous npm issue. Full clean reinstall restores them.

**How to apply:** If the server crashes with `Cannot find module '...lib/...'` or `...src/...`, do a clean reinstall.

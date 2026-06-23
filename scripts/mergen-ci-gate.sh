#!/bin/bash
# mergen-ci-gate.sh — Reusable CI/CD safety gate for local hooks and non-GitHub CI systems.
#
# Queries the local or remote Mergen server's /ci/gate endpoint to cross-reference
# modified files against the operational memory and override corpus.
#
# Usage:
#   ./scripts/mergen-ci-gate.sh [mergen-url] [x-mergen-secret] [service]
#
# Exit Codes:
#   0 — Pass (or warning, if strictly non-blocking)
#   1 — Blocked (unresolved failures or custom policy constraints triggered)

set -e

MERGEN_URL="${1:-http://127.0.0.1:3000}"
MERGEN_SECRET="$2"
SERVICE="$3"
ACTOR="${GITHUB_ACTOR:-${GITLAB_USER_LOGIN:-$(git config user.name || echo "unknown")}}"
PR_TITLE="${GITHUB_REF_NAME:-$(git log -1 --pretty=%B || echo "manual commit")}"

echo "⬡ Mergen CI/CD Safety Gate"
echo "-----------------------------------"

# 1. Gather changed files
if [ -d .git ]; then
  # In CI, get diff against target branch (e.g. main/master)
  if git rev-parse --verify origin/main >/dev/null 2>&1; then
    CHANGED_FILES=$(git diff --name-only origin/main...HEAD)
  elif git rev-parse --verify origin/master >/dev/null 2>&1; then
    CHANGED_FILES=$(git diff --name-only origin/master...HEAD)
  else
    # Fallback to staged/local diff
    CHANGED_FILES=$(git diff --cached --name-only)
    if [ -z "$CHANGED_FILES" ]; then
      CHANGED_FILES=$(git diff --name-only HEAD~1 HEAD)
    fi
  fi
else
  echo "⚠️ Not in a git repository. Skipping file diff checks."
  exit 0
fi

if [ -z "$CHANGED_FILES" ]; then
  echo "✅ No changed files detected. Safe to proceed."
  exit 0
fi

# Format files into JSON array
FILES_JSON=$(echo "$CHANGED_FILES" | jq -R . | jq -s .)

# 2. Query gate endpoint
PAYLOAD=$(jq -n \
  --argjson files "$FILES_JSON" \
  --arg prTitle "$PR_TITLE" \
  --arg service "$SERVICE" \
  --arg actor "$ACTOR" \
  '{files: $files, prTitle: $prTitle, service: (if $service == "" then null else $service end), actor: $actor}')

echo "Checking staged changes..."
RESPONSE=$(curl -s -X POST "$MERGEN_URL/ci/gate" \
  -H "Content-Type: application/json" \
  ${MERGEN_SECRET:+-H "x-mergen-secret: $MERGEN_SECRET"} \
  -d "$PAYLOAD")

VERDICT=$(echo "$RESPONSE" | jq -r '.verdict // "pass"')
RISK_SCORE=$(echo "$RESPONSE" | jq -r '.riskScore // 0')
REASONS=$(echo "$RESPONSE" | jq -r '.reasons[]')

echo ""
echo "Verdict: ${VERDICT^^} (Risk Score: $RISK_SCORE/100)"
echo "-----------------------------------"

if [ -n "$REASONS" ]; then
  echo "Reasons:"
  echo "$RESPONSE" | jq -r '.reasons[] | "- " + .'
  echo ""
fi

echo "$(echo "$RESPONSE" | jq -r '.recommendation // ""')"

if [ "$VERDICT" = "block" ]; then
  echo "🚫 Pipeline blocked by Mergen Safety Gate."
  exit 1
elif [ "$VERDICT" = "warn" ]; then
  echo "⚠️ Safety Gate warnings. Review recommendation before merging."
  exit 0
else
  echo "✅ Safety Gate passed."
  exit 0
fi

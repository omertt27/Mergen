#!/usr/bin/env bash
# post-result.sh — Universal Mergen CI reporter
#
# Works with any CI system: GitLab CI, CircleCI, Jenkins, Buildkite, etc.
# Copy this file into your repo and call it at the end of your CI job.
#
# Environment variables:
#   MERGEN_URL     (required) — e.g. http://192.168.1.10:3000
#   MERGEN_SECRET  (optional) — shared secret for the team instance
#   MERGEN_ENV     (optional) — deployment environment name (default: staging)
#
# Usage:
#   # In GitLab CI (.gitlab-ci.yml):
#   after_script:
#     - bash sdk/ci/post-result.sh
#
#   # In CircleCI (config.yml):
#   - run:
#       name: Report to Mergen
#       when: always
#       command: bash sdk/ci/post-result.sh
#
#   # In any shell:
#   CI_SHA=abc123 CI_STATUS=failure bash sdk/ci/post-result.sh

set -euo pipefail

MERGEN_URL="${MERGEN_URL:-}"
if [ -z "$MERGEN_URL" ]; then
  echo "[Mergen] MERGEN_URL not set — skipping CI report"
  exit 0
fi

# ── Detect SHA ────────────────────────────────────────────────────────────────
SHA="${CI_SHA:-${GITHUB_SHA:-${CI_COMMIT_SHA:-${GIT_COMMIT:-$(git rev-parse HEAD 2>/dev/null || echo '')}}}}"
if [ -z "$SHA" ]; then
  echo "[Mergen] Could not determine commit SHA — skipping"
  exit 0
fi

# ── Detect status ─────────────────────────────────────────────────────────────
STATUS="${CI_STATUS:-${CI_JOB_STATUS:-${BUILD_STATUS:-unknown}}}"
# Normalise common variants
case "$STATUS" in
  0|success|passed|pass)    STATUS="success" ;;
  1|failure|failed|fail)    STATUS="failure" ;;
  cancelled|canceled)       STATUS="cancelled" ;;
  *)                        STATUS="failure" ;;
esac

# ── Detect provider + metadata ────────────────────────────────────────────────
PROVIDER="unknown"
BRANCH=""
WORKFLOW=""
JOB=""
URL=""

if [ -n "${GITHUB_ACTIONS:-}" ]; then
  PROVIDER="github_actions"
  BRANCH="${GITHUB_REF_NAME:-}"
  WORKFLOW="${GITHUB_WORKFLOW:-}"
  JOB="${GITHUB_JOB:-}"
  URL="${GITHUB_SERVER_URL:-}/${GITHUB_REPOSITORY:-}/actions/runs/${GITHUB_RUN_ID:-}"
elif [ -n "${GITLAB_CI:-}" ]; then
  PROVIDER="gitlab_ci"
  BRANCH="${CI_COMMIT_REF_NAME:-}"
  WORKFLOW="${CI_PIPELINE_NAME:-pipeline}"
  JOB="${CI_JOB_NAME:-}"
  URL="${CI_JOB_URL:-}"
elif [ -n "${CIRCLECI:-}" ]; then
  PROVIDER="circleci"
  BRANCH="${CIRCLE_BRANCH:-}"
  JOB="${CIRCLE_JOB:-}"
  URL="${CIRCLE_BUILD_URL:-}"
elif [ -n "${BUILDKITE:-}" ]; then
  PROVIDER="unknown"
  BRANCH="${BUILDKITE_BRANCH:-}"
  JOB="${BUILDKITE_STEP_KEY:-}"
  URL="${BUILDKITE_BUILD_URL:-}"
fi

SECRET_HEADER=""
if [ -n "${MERGEN_SECRET:-}" ]; then
  SECRET_HEADER="-H \"x-mergen-secret: ${MERGEN_SECRET}\""
fi

# ── Post CI result ────────────────────────────────────────────────────────────
curl -s -X POST "${MERGEN_URL}/ci/generic" \
  -H "Content-Type: application/json" \
  ${SECRET_HEADER:+$SECRET_HEADER} \
  -d "{
    \"sha\":      \"${SHA}\",
    \"branch\":   \"${BRANCH}\",
    \"workflow\": \"${WORKFLOW}\",
    \"job\":      \"${JOB}\",
    \"status\":   \"${STATUS}\",
    \"provider\": \"${PROVIDER}\",
    \"url\":      \"${URL}\"
  }" && echo "[Mergen] CI result posted (${SHA:0:7} ${STATUS})" || echo "[Mergen] Could not reach server — skipping"

# ── Post deployment notification (if MERGEN_DEPLOY=true) ─────────────────────
if [ "${MERGEN_DEPLOY:-false}" = "true" ] && [ "$STATUS" = "success" ]; then
  ENV="${MERGEN_ENV:-staging}"
  curl -s -X POST "${MERGEN_URL}/deployments" \
    -H "Content-Type: application/json" \
    ${SECRET_HEADER:+$SECRET_HEADER} \
    -d "{
      \"sha\":         \"${SHA}\",
      \"environment\": \"${ENV}\",
      \"status\":      \"success\",
      \"actor\":       \"${GITLAB_USER_LOGIN:-${GITHUB_ACTOR:-ci}}\"
    }" && echo "[Mergen] Deployment posted (${ENV})" || true
fi

#!/usr/bin/env bash
#
# End-to-end stress test for pr-media.
#
# Runs `pr-media add` against a REAL pull request N times (default 10),
# using the real fixtures in test/fixtures/, and verifies that every run:
#   1. exits 0,
#   2. emits valid JSON with a URL per uploaded file,
#   3. that URL is actually reachable (HTTP 200 or 302) when authenticated
#      the same way `gh` is (`Authorization: token $(gh auth token)`).
#
# This is NOT a unit test — it hits the live GitHub API/CDN and mutates the
# target PR (adds a comment + uploads media) on every run, so point it at a
# scratch/test PR, not a real one people are reviewing.
#
# Usage:
#   ./test/e2e-stress.sh <pr-url> [strategy] [runs=10]
#
# Examples:
#   ./test/e2e-stress.sh https://github.com/acme/widgets/pull/42
#   ./test/e2e-stress.sh https://github.com/acme/widgets/pull/42 hidden-ref
#   ./test/e2e-stress.sh https://github.com/acme/widgets/pull/42 auto 25
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

PR_URL="${1:-}"
STRATEGY="${2:-auto}"
RUNS="${3:-10}"

if [[ -z "${PR_URL}" ]]; then
  echo "Usage: $0 <pr-url> [strategy] [runs=10]" >&2
  exit 1
fi

for bin in jq curl gh node; do
  if ! command -v "${bin}" >/dev/null 2>&1; then
    echo "error: required command '${bin}' not found on PATH." >&2
    exit 1
  fi
done

CLI="${REPO_ROOT}/dist/cli.js"
if [[ ! -f "${CLI}" ]]; then
  echo "error: ${CLI} not found — run 'npm run build' first." >&2
  exit 1
fi

PNG_FIXTURE="${REPO_ROOT}/test/fixtures/sample.png"
GIF_FIXTURE="${REPO_ROOT}/test/fixtures/sample.gif"
for f in "${PNG_FIXTURE}" "${GIF_FIXTURE}"; do
  if [[ ! -f "${f}" ]]; then
    echo "error: fixture ${f} not found." >&2
    exit 1
  fi
done

GH_TOKEN="$(gh auth token 2>/dev/null || true)"
if [[ -z "${GH_TOKEN}" ]]; then
  echo "error: could not obtain a token via 'gh auth token'. Run 'gh auth login' first." >&2
  exit 1
fi

echo "pr-media e2e stress test"
echo "  PR:       ${PR_URL}"
echo "  strategy: ${STRATEGY}"
echo "  runs:     ${RUNS}"
echo

ok_count=0
fail_count=0
declare -a failure_details=()

for ((i = 1; i <= RUNS; i++)); do
  echo "== run ${i}/${RUNS} =="

  json_output="$(node "${CLI}" add "${PNG_FIXTURE}" "${GIF_FIXTURE}" \
    --pr-url "${PR_URL}" \
    --strategy "${STRATEGY}" \
    --json \
    --to comment 2>"/tmp/pr-media-e2e-run-${i}.stderr")"
  exit_code=$?

  if [[ ${exit_code} -ne 0 ]]; then
    fail_count=$((fail_count + 1))
    detail="run ${i}: cli exited ${exit_code} — $(tail -n 1 "/tmp/pr-media-e2e-run-${i}.stderr" 2>/dev/null || echo 'no stderr captured')"
    failure_details+=("${detail}")
    echo "  FAIL: ${detail}"
    continue
  fi

  urls="$(printf '%s' "${json_output}" | jq -r '.[].url' 2>/dev/null)"
  if [[ -z "${urls}" ]]; then
    fail_count=$((fail_count + 1))
    detail="run ${i}: no URLs found in JSON output"
    failure_details+=("${detail}")
    echo "  FAIL: ${detail}"
    continue
  fi

  run_ok=true
  while IFS= read -r url; do
    [[ -z "${url}" ]] && continue
    status="$(curl -sIL -o /dev/null -w '%{http_code}' \
      -H "Authorization: token ${GH_TOKEN}" \
      "${url}")"
    if [[ "${status}" != "200" && "${status}" != "302" ]]; then
      run_ok=false
      detail="run ${i}: ${url} -> HTTP ${status} (expected 200 or 302)"
      failure_details+=("${detail}")
      echo "  FAIL: ${detail}"
    else
      echo "  OK: ${url} -> HTTP ${status}"
    fi
  done <<< "${urls}"

  if [[ "${run_ok}" == true ]]; then
    ok_count=$((ok_count + 1))
  else
    fail_count=$((fail_count + 1))
  fi
done

echo
echo "================================"
echo "Summary: ${ok_count}/${RUNS} OK"
echo "================================"

if [[ ${fail_count} -gt 0 ]]; then
  echo
  echo "Failures (${fail_count}):"
  for detail in "${failure_details[@]}"; do
    echo "  - ${detail}"
  done
  exit 1
fi

exit 0

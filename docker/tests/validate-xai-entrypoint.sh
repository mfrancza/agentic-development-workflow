#!/usr/bin/env bash
# =============================================================================
# Validation script for issue #309: Grok developer image — local docker run
# validation of the xAI runner changes from issue #308.
#
# Usage:
#   # Static-analysis checks only (no Docker or API key required):
#   ./validate-xai-entrypoint.sh --static
#
#   # Full validation including Docker build (requires Docker + optional XAI_API_KEY):
#   XAI_API_KEY=<your-key> GH_TOKEN=<token> GITHUB_REPO=<owner/repo> \
#       ./validate-xai-entrypoint.sh
#
# Required environment for Docker tests:
#   GH_TOKEN          — GitHub token for the container's gh calls
#   GITHUB_REPO       — e.g. "myorg/myrepo"
#   XAI_API_KEY       — xAI API key (only for test case 2; all other cases work
#                       without it, or with a dummy value)
#
# This script documents the test cases from issue #309 and records pass/fail
# for each. Test case 2 (end-to-end via real xAI API) requires a real
# XAI_API_KEY; all other cases use dummy or absent values.
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
DOCKERFILE="${REPO_ROOT}/docker/Dockerfile"
ENTRYPOINT="${REPO_ROOT}/docker/scripts/entrypoint.sh"

STATIC_ONLY="${1:-}"
IMAGE_TAG="agentic-dev-xai-validation:test"

pass() { echo "  ✅ PASS: $*"; }
fail() { echo "  ❌ FAIL: $*"; return 1; }
skip() { echo "  ⏭  SKIP: $*"; }
info() { echo "  ℹ️  $*"; }

echo "============================================================"
echo "Issue #309 — xAI Grok developer image validation"
echo "Entrypoint: ${ENTRYPOINT}"
echo "Dockerfile:  ${DOCKERFILE}"
echo "============================================================"
echo ""

# =============================================================================
# Static analysis checks (runnable without Docker)
# =============================================================================

echo "--- Static Analysis ---"
echo ""

echo "Check A: resolve_provider xai) arm — all three Grok model names present"
for model in grok-3 grok-3-mini grok-code-fast-1; do
    # Model names appear in pipe-separated case patterns: name| or name)
    if grep -qE "(^|[|])\s*${model}\s*([|)])" "${ENTRYPOINT}"; then
        pass "resolve_provider case arm includes '${model}'"
    else
        fail "resolve_provider case arm missing '${model}'"
    fi
done

echo ""
echo "Check B: wildcard error message lists all three Grok names"
for model in grok-3 grok-3-mini grok-code-fast-1; do
    if grep -q "${model}" "${ENTRYPOINT}"; then
        pass "Error message references '${model}'"
    else
        fail "Error message missing '${model}'"
    fi
done

echo ""
echo "Check C: run_xai() function exists"
if grep -q "^run_xai()" "${ENTRYPOINT}"; then
    pass "run_xai() function defined"
else
    fail "run_xai() function not found"
fi

echo ""
echo "Check D: run_agent() dispatches xai) to run_xai"
if grep -A3 "xai)" "${ENTRYPOINT}" | grep -q "run_xai"; then
    pass "run_agent() xai) arm delegates to run_xai"
else
    fail "run_agent() xai) arm does not delegate to run_xai"
fi

echo ""
echo "Check E: preamble key-validation has xai) arm requiring XAI_API_KEY"
if grep -q 'XAI_API_KEY:?XAI_API_KEY is required' "${ENTRYPOINT}"; then
    pass "Preamble xai) arm: XAI_API_KEY required check present"
else
    fail "Preamble xai) arm: XAI_API_KEY required check missing"
fi

echo ""
echo "Check F: NO active codex login call in xai) preamble arm"
# The openai) arm calls codex login. The xai) arm must not.
# Verify that codex login only appears in the openai) arm (line 240 per baseline).
CODEX_LOGIN_COUNT=$(grep -c "codex login" "${ENTRYPOINT}" || true)
# Comment-only references are acceptable; only executable invocations must be in openai)
NON_COMMENT_LOGIN_COUNT=$(grep -v "^\s*#" "${ENTRYPOINT}" | grep -c "codex login" || true)
if [ "${NON_COMMENT_LOGIN_COUNT}" -eq 1 ]; then
    # Confirm it is inside the openai) arm
    OPENAI_ARM_LINE=$(grep -n "printenv OPENAI_API_KEY | codex login" "${ENTRYPOINT}" | head -1 | cut -d: -f1)
    if [ -n "${OPENAI_ARM_LINE}" ]; then
        # Check that the 10 lines before it contain openai) — meaning it is inside that arm
        if sed -n "$((OPENAI_ARM_LINE - 10)),${OPENAI_ARM_LINE}p" "${ENTRYPOINT}" | grep -q "openai)"; then
            pass "codex login appears exactly once, inside openai) arm only — not in xai) arm"
        else
            fail "codex login found but not confirmed inside openai) arm"
        fi
    else
        fail "Expected codex login invocation not found"
    fi
else
    fail "Expected exactly 1 non-comment codex login invocation, found: ${NON_COMMENT_LOGIN_COUNT}"
fi

echo ""
echo "Check G: XAI_API_KEY redaction block present in _log_capture_exit()"
if grep -q 'REDACTED-XAI_API_KEY' "${ENTRYPOINT}"; then
    pass "XAI_API_KEY redaction pass present in _log_capture_exit()"
else
    fail "XAI_API_KEY redaction pass missing from _log_capture_exit()"
fi

echo ""
echo "Check H: Dockerfile writes [model_providers.xai] config.toml block"
if grep -q 'model_providers.xai' "${DOCKERFILE}"; then
    pass "Dockerfile contains [model_providers.xai] config.toml block"
else
    fail "Dockerfile missing [model_providers.xai] config.toml block"
fi
if grep -q 'XAI_API_KEY' "${DOCKERFILE}"; then
    pass "Dockerfile config.toml block references XAI_API_KEY (env_key)"
else
    fail "Dockerfile config.toml block missing XAI_API_KEY env_key"
fi
if grep -q 'https://api.x.ai/v1' "${DOCKERFILE}"; then
    pass "Dockerfile config.toml block references correct xAI base_url"
else
    fail "Dockerfile config.toml block missing or wrong base_url"
fi

echo ""
echo "Check I: run_xai() uses --config model_provider=\"xai\""
if grep -q 'model_provider="xai"' "${ENTRYPOINT}"; then
    pass "run_xai() passes --config model_provider=\"xai\" to codex exec"
else
    fail "run_xai() missing --config model_provider=\"xai\""
fi

echo ""
echo "Check J: run_xai() uses --sandbox workspace-write"
if grep -A30 "^run_xai()" "${ENTRYPOINT}" | grep -q "workspace-write"; then
    pass "run_xai() passes --sandbox workspace-write to codex exec"
else
    fail "run_xai() missing --sandbox workspace-write"
fi

echo ""
echo "--- Static analysis complete ---"
echo ""

if [ "${STATIC_ONLY}" = "--static" ]; then
    echo "Skipping Docker tests (--static flag set)."
    echo ""
    echo "To run Docker tests: XAI_API_KEY=<key> GH_TOKEN=<token> GITHUB_REPO=<owner/repo> $0"
    exit 0
fi

# =============================================================================
# Docker tests (requires Docker)
# =============================================================================

if ! command -v docker &>/dev/null; then
    echo "Docker not found — skipping Docker-based test cases."
    echo "(Install Docker and re-run without --static to exercise the container.)"
    exit 0
fi

echo "--- Docker Tests ---"
echo ""

echo "Building developer image (tag: ${IMAGE_TAG}) ..."
docker build -t "${IMAGE_TAG}" "${REPO_ROOT}/docker/"
pass "Image built successfully"
echo ""

# Common dummy env for tests that must not reach the agent API
DUMMY_GH_TOKEN="${GH_TOKEN:-dummy-gh-token}"
DUMMY_REPO="${GITHUB_REPO:-dummy-owner/dummy-repo}"

# ---------------------------------------------------------------------------
# Test case 1: AGENT_MODEL=grok-3 with XAI_API_KEY unset
# Expected: container fails in preamble with "XAI_API_KEY is required"
# ---------------------------------------------------------------------------
echo "Test 1: AGENT_MODEL=grok-3, XAI_API_KEY unset — expect preamble failure"
TC1_OUTPUT="$(docker run --rm \
    -e AGENT_MODEL=grok-3 \
    -e GH_TOKEN="${DUMMY_GH_TOKEN}" \
    -e GITHUB_REPO="${DUMMY_REPO}" \
    -e AGENT_ACTION=groom \
    -e GITHUB_ISSUE_NUMBER=1 \
    "${IMAGE_TAG}" 2>&1 || true)"
echo "  Output:"
echo "${TC1_OUTPUT}" | sed 's/^/    /'
if echo "${TC1_OUTPUT}" | grep -q "XAI_API_KEY is required"; then
    pass "Container exited with 'XAI_API_KEY is required' before any clone or API call"
else
    fail "Expected 'XAI_API_KEY is required' in output"
fi
echo ""

# ---------------------------------------------------------------------------
# Test case 2: AGENT_MODEL=grok-3 with XAI_API_KEY set — end-to-end via xAI
# Expected: action completes via run_xai (routes to xAI Codex path)
# ---------------------------------------------------------------------------
echo "Test 2: AGENT_MODEL=grok-3, XAI_API_KEY set — end-to-end groom run"
if [ -z "${XAI_API_KEY:-}" ]; then
    skip "XAI_API_KEY not set — cannot run end-to-end test against live xAI API"
else
    TC2_OUTPUT="$(docker run --rm \
        -e AGENT_MODEL=grok-3 \
        -e XAI_API_KEY="${XAI_API_KEY}" \
        -e GH_TOKEN="${GH_TOKEN}" \
        -e GITHUB_REPO="${GITHUB_REPO}" \
        -e AGENT_ACTION=groom \
        -e GITHUB_ISSUE_NUMBER="${FIXTURE_ISSUE_NUMBER:-1}" \
        "${IMAGE_TAG}" 2>&1 || true)"
    echo "  Output:"
    echo "${TC2_OUTPUT}" | sed 's/^/    /'
    if echo "${TC2_OUTPUT}" | grep -q "provider: xai"; then
        pass "Container routed to xAI provider and started action"
    else
        fail "xAI routing not confirmed in container log"
    fi
    if echo "${TC2_OUTPUT}" | grep -qi "codex login"; then
        fail "Unexpected 'codex login' call found in xai run log"
    else
        pass "No codex login call in xai run (expected by design)"
    fi
fi
echo ""

# ---------------------------------------------------------------------------
# Test case 3: AGENT_MODEL=bogus — "Unknown model" error listing Grok names
# ---------------------------------------------------------------------------
echo "Test 3: AGENT_MODEL=bogus — expect 'Unknown model' error listing Grok names"
TC3_OUTPUT="$(docker run --rm \
    -e AGENT_MODEL=bogus \
    -e GH_TOKEN="${DUMMY_GH_TOKEN}" \
    -e GITHUB_REPO="${DUMMY_REPO}" \
    -e AGENT_ACTION=groom \
    -e GITHUB_ISSUE_NUMBER=1 \
    "${IMAGE_TAG}" 2>&1 || true)"
echo "  Output:"
echo "${TC3_OUTPUT}" | sed 's/^/    /'
if echo "${TC3_OUTPUT}" | grep -q "Unknown model"; then
    pass "Error message contains 'Unknown model'"
else
    fail "Expected 'Unknown model' in output"
fi
for model in grok-3 grok-3-mini grok-code-fast-1; do
    if echo "${TC3_OUTPUT}" | grep -q "${model}"; then
        pass "Error message lists '${model}'"
    else
        fail "Error message missing '${model}'"
    fi
done
echo ""

# ---------------------------------------------------------------------------
# Test case 4: AGENT_MODEL=sonnet — routes to run_anthropic (regression check)
# ---------------------------------------------------------------------------
echo "Test 4: AGENT_MODEL=sonnet — expect routing to run_anthropic (Anthropic regression)"
TC4_OUTPUT="$(docker run --rm \
    -e AGENT_MODEL=sonnet \
    -e GH_TOKEN="${DUMMY_GH_TOKEN}" \
    -e GITHUB_REPO="${DUMMY_REPO}" \
    -e AGENT_ACTION=groom \
    -e GITHUB_ISSUE_NUMBER=1 \
    "${IMAGE_TAG}" 2>&1 || true)"
echo "  Output:"
echo "${TC4_OUTPUT}" | sed 's/^/    /'
if echo "${TC4_OUTPUT}" | grep -q "provider: anthropic"; then
    pass "Container resolved provider as 'anthropic' for AGENT_MODEL=sonnet"
elif echo "${TC4_OUTPUT}" | grep -q "ANTHROPIC_API_KEY is required"; then
    pass "Container reached ANTHROPIC_API_KEY validation (routed to anthropic provider)"
else
    fail "Expected anthropic routing for AGENT_MODEL=sonnet"
fi
echo ""

# ---------------------------------------------------------------------------
# Test case 5: AGENT_MODEL=o3 — routes to run_openai (regression check)
# ---------------------------------------------------------------------------
echo "Test 5: AGENT_MODEL=o3 — expect routing to run_openai (OpenAI regression)"
TC5_OUTPUT="$(docker run --rm \
    -e AGENT_MODEL=o3 \
    -e GH_TOKEN="${DUMMY_GH_TOKEN}" \
    -e GITHUB_REPO="${DUMMY_REPO}" \
    -e AGENT_ACTION=groom \
    -e GITHUB_ISSUE_NUMBER=1 \
    "${IMAGE_TAG}" 2>&1 || true)"
echo "  Output:"
echo "${TC5_OUTPUT}" | sed 's/^/    /'
if echo "${TC5_OUTPUT}" | grep -q "provider: openai"; then
    pass "Container resolved provider as 'openai' for AGENT_MODEL=o3"
elif echo "${TC5_OUTPUT}" | grep -q "OPENAI_API_KEY is required"; then
    pass "Container reached OPENAI_API_KEY validation (routed to openai provider)"
else
    fail "Expected openai routing for AGENT_MODEL=o3"
fi
echo ""

# ---------------------------------------------------------------------------
# Test case 6: Inspect container log — no codex login in xai) preamble
# ---------------------------------------------------------------------------
echo "Test 6: Capture log for AGENT_MODEL=grok-3 — confirm no codex login in preamble"
TC6_OUTPUT="$(docker run --rm \
    -e AGENT_MODEL=grok-3 \
    -e GH_TOKEN="${DUMMY_GH_TOKEN}" \
    -e GITHUB_REPO="${DUMMY_REPO}" \
    -e AGENT_ACTION=groom \
    -e GITHUB_ISSUE_NUMBER=1 \
    "${IMAGE_TAG}" 2>&1 || true)"
echo "  Output:"
echo "${TC6_OUTPUT}" | sed 's/^/    /'
if echo "${TC6_OUTPUT}" | grep -qi "codex login"; then
    fail "codex login call found in xai) preamble container log"
else
    pass "No codex login call in xai) preamble container log"
fi
echo ""

echo "============================================================"
echo "Validation complete."
echo "============================================================"

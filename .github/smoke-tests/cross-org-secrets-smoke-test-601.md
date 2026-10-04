# Cross-Org Secrets Smoke Test — Issue #601

**Date:** 2026-10-04  
**Test ID:** #601 (Disposable smoke-test issue)  
**Parent Issue:** #593 (e2e validation)  
**Status:** ✅ PASSED

## Test Objective

Validate that the rewritten caller stubs with explicit `secrets:` blocks (replacing `secrets: inherit`) correctly mint a developer-agent token and allow the grooming agent to run to completion.

## Test Flow

1. Issue #601 was created as a disposable test marker
2. Grooming agent was invoked via `agent:groom` label
3. Grooming agent completed successfully, confirming:
   - Explicit-secrets wiring in the caller stubs is correct
   - Developer-agent App token was minted successfully
   - Cross-org secrets propagation works as expected

## Validation Evidence

- Grooming agent completed without errors
- Token minting was successful (grooming ran with the correct credentials)
- No missing or extra secret keys in the explicit blocks

## Conclusion

The cross-org secrets fix (Issue #593 / PR #595–#600) has been validated end-to-end. The explicit `secrets:` blocks in all rewritten caller stubs correctly match their corresponding `*-reusable.yml` counterparts, and the token minting flow works as expected.

This disposable test issue has served its purpose and can be closed.

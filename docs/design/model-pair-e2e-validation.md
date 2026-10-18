# End-to-end validation: reviewer model pairing

**Issue:** [#476](https://github.com/mfrancza/agentic-development-workflow/issues/476)

**Parent design:** [`docs/design/configurable-model-pair-preferences.md`](configurable-model-pair-preferences.md)

## Status

**Static / unit-test layer: complete** (all seven acceptance scenarios covered below).

**Live-run layer: pending** — live workflow runs require:
1. Enabling `REVIEW_MODEL_PAIRING` in `terraform.tfvars` and running `terraform apply`.
2. Temporarily disabling Tier 2 (`reviewer_models = []`) so Tier 3 (the pairing tier) activates.
3. Creating a test issue, triggering the developer agent with `model:developer:opus`, and observing the review workflow runs against the resulting PR.

See [Pending live-run scenarios](#pending-live-run-scenarios) for the checklist.

## Static / unit-test layer

### Unit test run

```
Test Files  26 passed (26)
     Tests  508 passed (508)
  Duration  2.67s
```

TypeScript strict-mode type-check: clean (`npx --no-install tsc --noEmit` exits 0).

### Scenario 1 — Marker injection (Design Decision 4)

**Verification method:** static analysis + observed live PR bodies.

**Implementation:** `docker/scripts/entrypoint.sh` defines `inject_authored_by_marker()` (called after
`action_implement`, `action_fix_checks`, `action_respond_review`, `action_fix_deployment`, and
`action_design`). The function fetches the PR body, strips any existing
`<!-- authored-by-model: … -->` markers (idempotent), prepends a fresh marker with the current
`AGENT_MODEL` value, and writes the result back via `gh pr edit --body-file`.

**Live evidence:** two recently merged implementation PRs confirm the marker was injected:

- PR [#644](https://github.com/mfrancza/agentic-development-workflow/pulls/644) (agent/issue-474 — add `selectReviewerModel` pairing library): PR body opens with `<!-- authored-by-model: sonnet -->`.
- PR [#654](https://github.com/mfrancza/agentic-development-workflow/pulls/654) (agent/issue-475 — wire pairing tier into agent-review): PR body opens with `<!-- authored-by-model: sonnet -->`.

Both PRs were opened by `mfrancza-developer-agent[bot]` with `AGENT_MODEL=sonnet` (the repo default). The marker appears on its own line at the start of each PR body, confirming the injection path is working end-to-end.

**`parseAuthoredByModel` unit tests** (`test/find-authored-by-model.test.ts`, 11 tests):
- Returns model name from a well-formed marker.
- Returns empty string when marker is absent, malformed, or body is null.
- Handles extra whitespace around the model name.
- Extracts the model from a longer PR body (text before and after the marker).
- Matches case-insensitively; returns the first match when multiple markers are present.

### Scenario 2 — Primary pairing pick: different-vendor-same-class (Design Decision 1, 2, 5)

**Verification method:** unit tests.

**`selectReviewerModel` unit tests** (`test/model-pair.test.ts`, 35 tests):
- `"different-vendor-same-class"` picks the canonical OpenAI model for an Anthropic-authored sonnet PR (expected: first OpenAI entry in `sonnet` class).
- Canonical opus pick: for an Anthropic `opus`-authored PR with `preferred_vendors = ["openai", "xai", "anthropic"]`, picks `gpt-5.6-sol` (first entry of `classes.opus.openai`).
- Honours `preferred_vendors` order: `["xai", "openai", "anthropic"]` picks the xAI canonical opus pick (`grok-4.20-0309-reasoning`).
- Skips a vendor whose API key is unavailable (emits a `core.warning()`).
- Falls through the fallback chain when no cross-vendor entry exists.

**Class-table consistency** (`test/model-classes.test.ts`, 27 tests covering Checks 1–4):
- Check 1: every canonical pick in `classes[class][vendor][0]` is mapped consistently in `modelToClass`.
- Check 2: `modelToClass` is a superset of every entry across `classes`.
- Check 3: no dual-class models exist today (no-op check, activates on future dual-class edits).
- Check 4: canonical picks appear in the `Cross-Vendor Class Table` section of `docs/model-guidance.md`.

**Pending live-run:** step 2 of the acceptance checklist — see [Pending live-run scenarios](#pending-live-run-scenarios).

### Scenario 3 — Label override wins (Design Decision 1, Tier ordering)

**Verification method:** unit tests.

**`resolveReviewerSet` unit tests** (`test/resolve-reviewer-set.test.ts`, Tier 1 describe block):
- One `model:review:*` label → single-entry set; multiple labels → multi-entry set; strips the prefix.
- Tier 1 takes precedence over a non-empty `reviewerModels` list (Tier 2) and over a generic `model:*` label (Tier 3).
- Makes exactly one API call when Tier 1 matches.

When a `model:review:sonnet` label is present on the PR, the Tier 1 waterfall returns `["sonnet"]` and the pairing tier (Tier 3) is never consulted. This is confirmed by the Tier 1 precedence tests above.

**Pending live-run:** step 3 of the acceptance checklist.

### Scenario 4 — Vendor-preference tie-break (Design Decision 2, 5)

**Verification method:** unit tests.

**`selectReviewerModel` unit tests:**
- `["openai", "xai", "anthropic"]` prefers OpenAI → picks `gpt-5.6-sol` for an Anthropic opus PR.
- `["xai", "openai", "anthropic"]` prefers xAI → picks `grok-4.20-0309-reasoning` for an Anthropic opus PR.

Both cases verified by the `"honours preferred_vendors order"` test in `model-pair.test.ts`.

**Pending live-run:** step 4 of the acceptance checklist.

### Scenario 5 — API-key fallback with `core.warning()` (Design Decision 5)

**Verification method:** unit tests.

**`selectReviewerModel` unit tests:**
- Skips vendors without an available key; emits a `core.warning()` warning string.
- Falls through to `default-model` fallback when no cross-vendor key is available at all.
- Warning text confirmed by the `"emits a warning when the primary pick fails"` test.

**`available-providers` computation** in `agent-review-reusable.yml` (resolve job): derives the JSON array from `secrets.ANTHROPIC_API_KEY != ''` / `secrets.OPENAI_API_KEY != ''` / `secrets.XAI_API_KEY != ''`; passes it to `resolve-reviewer-set` as `available-providers`. Reviewed in static analysis of the workflow YAML.

**Pairing-tier error routing:** `resolve-reviewer-set.test.ts` includes the test `"calls core.error() (not core.warning()) when DEFAULT_MODEL equals the authoring model after fallback"`, verifying the `ERROR:` prefix on the warning string is mapped to `core.error()` by the entry point.

**Pending live-run:** step 5 of the acceptance checklist (requires temporarily excluding a provider from the available set in a workflow-dispatch run).

### Scenario 6 — Marker absence fallback (Design Decision 4, 5)

**Verification method:** unit tests.

**`parseAuthoredByModel` unit tests:** return empty string when the marker is absent or the body is null.

**`resolveReviewerSet` behavior when `authoring-model` is empty:** when the `find-authored-by-model` activity returns an empty string (absent marker), the pairing tier receives an empty `authoring-model` input. The `selectReviewerModel` function is called with an empty authoring model; `inferVendor("")` returns `undefined`, triggering the `"cannot infer vendor for authoring model"` warning path, which walks the fallback chain and ultimately returns `DEFAULT_MODEL`. A `core.warning()` is emitted for the missing vendor.

Static analysis of the `agent-review-reusable.yml` resolve job confirms the `find-authored-by-model` step runs first and its `authoring_model` output (empty when marker is absent) is forwarded to `resolve-reviewer-set`'s `authoring-model` input.

**Pending live-run:** step 6 of the acceptance checklist (use a pre-marker PR or manually remove the marker).

### Scenario 7 — `same-model` policy honoured (Design Decision 2, 5)

**Verification method:** unit tests.

**`selectReviewerModel` unit tests:**
- `"same-model"` policy returns the authoring model unchanged (source: `"primary"`, no warnings).
- Also works for an OpenAI authoring model.
- Falls through when the author vendor API key is unavailable.

This is the only policy where returning the same model as the author is permitted; all other policies emit `core.error()` or `core.warning()` if the pick would equal the author model.

**Pending live-run:** step 7 of the acceptance checklist (set `policy = "same-model"` in Terraform and re-trigger).

## Pending live-run scenarios

The seven acceptance steps from the issue body require live GitHub Actions runs with `REVIEW_MODEL_PAIRING` enabled in Terraform. The following checklist tracks their status:

| Step | Description | Status |
|------|-------------|--------|
| 1 | Marker injection: open test issue with `model:developer:opus`, confirm PR body has `<!-- authored-by-model: opus -->` | Confirmed via PR #644 and #654 (sonnet marker); opus variant pending |
| 2 | Primary pairing pick (`different-vendor-same-class`, `preferred_vendors: ["openai",…]`): confirm reviewer runs on `gpt-5.6-sol` | Pending live run |
| 3 | Label override: add `model:review:sonnet`, confirm review runs on `sonnet` (pairing tier skipped) | Pending live run |
| 4 | Vendor tie-break: change `preferred_vendors` to `["xai",…]`, confirm reviewer runs on `grok-4.20-0309-reasoning` | Pending live run |
| 5 | API-key fallback: unset OpenAI key, confirm resolver falls through to xAI model with `core.warning()` | Pending live run |
| 6 | Marker absence: confirm reviewer falls through to `DEFAULT_MODEL` with loud warning | Pending live run |
| 7 | `same-model` policy: confirm review runs on author's model | Pending live run |

To unblock steps 2–7, an operator must:

1. In `terraform/terraform.tfvars`, add:
   ```hcl
   review_model_pairing = {
     enabled           = true
     policy            = "different-vendor-same-class"
     preferred_vendors = ["openai", "xai", "anthropic"]
     explicit_map      = {}
     fallback_chain    = ["default-model"]
   }
   ```
   and set `reviewer_models = []` to disable Tier 2 (otherwise Tier 2 takes precedence and Tier 3 never fires).
2. Run `terraform apply`.
3. Open a test issue, apply `model:developer:opus` + `agent:developer`, wait for the PR, then apply `agent:review` and observe the resolve job's "Resolved reviewer set" output.
4. Record the workflow-run URLs, resolved model, and warning output as a comment on issue #476.
5. Repeat steps 2–7 of the acceptance checklist, adjusting Terraform config as specified.

Per the issue scope: if observed behaviour diverges from the design, open a follow-up issue rather than patching here.

## Key files

| File | Role |
|------|------|
| `docker/scripts/entrypoint.sh` | `inject_authored_by_marker()` — stamps PR body with `<!-- authored-by-model: … -->` |
| `.github/actions/find-authored-by-model/` | Reads the marker from a PR body; returns empty string when absent |
| `.github/actions/resolve-reviewer-set/` | Three-tier waterfall (Tier 3 now includes pairing) |
| `.github/scripts/src/lib/model-pair.ts` | `selectReviewerModel()` pure function |
| `.github/scripts/src/lib/model-classes.ts` | Cross-vendor class table loader |
| `.github/scripts/data/model-classes.json` | Class table: haiku/sonnet/opus × anthropic/openai/xai |
| `.github/scripts/test/model-pair.test.ts` | 35 unit tests for all policies and fallback paths |
| `.github/scripts/test/model-classes.test.ts` | 27 unit tests for class table consistency |
| `.github/scripts/test/find-authored-by-model.test.ts` | 11 unit tests for marker parsing |
| `.github/scripts/test/resolve-reviewer-set.test.ts` | 27 unit tests (including pairing-tier routing) |
| `.github/workflows/agent-review-reusable.yml` | Wires `find-authored-by-model` and `available-providers` into `resolve-reviewer-set` |
| `terraform/variables.tf` | `review_model_pairing` variable definition |
| `terraform/modules/agent-vars/main.tf` | Exposes the variable as `REVIEW_MODEL_PAIRING` Actions variable |

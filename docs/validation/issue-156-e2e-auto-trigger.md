# E2E Validation: Auto-trigger chain (issue #156)

> Design: `docs/design/auto-trigger-agents.md`  
> Workflow: `.github/workflows/agent-auto-trigger.yml`  
> Parent: issue #145

## Validation matrix

Each row captures an individual test case from the [issue #156 scope](https://github.com/mfrancza/agentic-development-workflow/issues/156).

---

### Test case 1 — All gates off (safe-default) ✅ VALIDATED

**Gate state:** `AUTO_TRIGGER_AGENTS = {"groom":false,"design":false,"developer":false,"review":false}` (default)

**Objective:** Confirm that opening a fresh issue does not auto-apply `agent:groom` and no downstream
workflow fires.

**Observations:**

| Event | Trigger issue | Run ID | Workflow | Conclusion |
|-------|--------------|--------|----------|------------|
| `issues.opened` | [#271](https://github.com/mfrancza/agentic-development-workflow/issues/271) | [33036058819](https://github.com/mfrancza/agentic-development-workflow/actions/runs/33036058819) | agent-auto-trigger | **skipped** (all 5 jobs) |
| `issues.labeled` (enhancement) | [#271](https://github.com/mfrancza/agentic-development-workflow/issues/271) | [33036058723](https://github.com/mfrancza/agentic-development-workflow/actions/runs/33036058723) | agent-auto-trigger | **skipped** (all 5 jobs) |
| `issues.opened` | [#156](https://github.com/mfrancza/agentic-development-workflow/issues/156) | [33035792250](https://github.com/mfrancza/agentic-development-workflow/actions/runs/33035792250) | agent-auto-trigger | **skipped** (all 5 jobs) |
| `issues.opened` | [#155](https://github.com/mfrancza/agentic-development-workflow/issues/155) | [33035336213](https://github.com/mfrancza/agentic-development-workflow/actions/runs/33035336213) | agent-auto-trigger | **skipped** (all 5 jobs) |
| `pull_request.opened` (agent/issue-155) | PR [#269](https://github.com/mfrancza/agentic-development-workflow/pull/269) | [33034052222](https://github.com/mfrancza/agentic-development-workflow/actions/runs/33034052222) | agent-auto-trigger | **skipped** (all 5 jobs, including `auto-review`) |

**Result:** ✅ All jobs skipped across 5 independent triggering events. No `agent:groom` was applied to
the fresh test issue (#271). No downstream agent workflow fired.

**Safe-default requirement:** Satisfied. The `vars.AUTO_TRIGGER_AGENTS != ''` guard (fail-closed)
and `fromJSON(vars.AUTO_TRIGGER_AGENTS).<key> == true` checks behave correctly when all gates are
`false` — every job skips without error.

---

### Test case 2 — `groom = true` ⏳ PENDING OPERATOR ACTION

**Gate state required:** `AUTO_TRIGGER_AGENTS = {"groom":true,"design":false,"developer":false,"review":false}`

**Objective:** Open a fresh issue; confirm `agent:groom` is auto-applied by the developer-agent bot
and `agent-groom.yml` runs to completion.

**Operator steps:**
1. In `terraform.tfvars`, set `auto_trigger_agents = { groom = true, design = false, developer = false, review = false }`.
2. Run `terraform apply` to update the `AUTO_TRIGGER_AGENTS` Actions variable.
3. Open a fresh test issue (title: `[E2E-156 test-2] groom gate`).
4. Observe `agent-auto-trigger` → `auto-groom` job runs (not skipped).
5. Confirm `agent:groom` label is applied with sender `mfrancza-developer-agent[bot]` (or equivalent App slug).
6. Confirm `agent-groom.yml` is triggered and runs to completion.
7. Record: test issue number, `agent-auto-trigger` run URL, `agent-groom.yml` run URL.

---

### Test case 3 — `groom = true, design = true` ⏳ PENDING OPERATOR ACTION

**Gate state required:** `AUTO_TRIGGER_AGENTS = {"groom":true,"design":true,"developer":false,"review":false}`

**Objective:** Confirm that for a `plan`-classified issue, `agent:design` is auto-applied after the
groomer adds the `plan` label, `agent-design.yml` runs, and a design PR is opened.

**Operator steps:**
1. Set `groom = true, design = true` and run `terraform apply`.
2. Open a fresh test issue with a `plan`-type request (title: `[E2E-156 test-3] design gate`).
3. Wait for `auto-groom` to apply `agent:groom`, then for `agent-groom.yml` to apply `plan`.
4. Confirm `auto-design` job fires (sender is the developer-agent bot, so `AGENT_ALLOWLIST` passes).
5. Confirm `agent:design` is applied, `agent-design.yml` runs, and a `design/issue-N` PR is opened.
6. Record: test issue number, design PR number, both workflow run URLs.

---

### Test case 4 — `developer = true` ⏳ PENDING OPERATOR ACTION

**Gate state required:** `AUTO_TRIGGER_AGENTS = {"groom":false,"design":false,"developer":true,"review":false}`

**Objective:** Validate two paths:

**Path A — `do` label applied manually:**
1. Set `developer = true` and run `terraform apply`.
2. Open a fresh test issue; apply the `do` label.
3. Confirm `auto-developer-do` job fires and `agent:developer` is applied.
4. Confirm `agent-implement.yml` runs.
5. Record: test issue, `agent-auto-trigger` run URL, `agent-implement.yml` run URL.

**Path B — design PR merged (un-draft sub-issues):**
1. Create a design PR that has sub-issues labeled `draft`.
2. Merge the design PR (or simulate the un-draft step).
3. Confirm `agent-design.yml` removes `draft` from sub-issues (sender = developer-agent bot).
4. Confirm `auto-developer-undraft` job fires for each sub-issue and applies `agent:developer`.
5. Confirm `agent-implement.yml` runs for each sub-issue.
6. Record: design PR, sub-issue numbers, `agent-auto-trigger` run URLs.

---

### Test case 5 — `review = true` ⏳ PENDING OPERATOR ACTION

**Gate state required:** `AUTO_TRIGGER_AGENTS = {"groom":false,"design":false,"developer":false,"review":true}`

**Objective:** Confirm that when a PR is opened on an `agent/` or `design/` branch, `agent:review`
is auto-applied and `agent-review.yml` runs.

**Operator steps:**
1. Set `review = true` and run `terraform apply`.
2. Have the developer agent open a PR on an `agent/issue-N` branch (or open one manually).
3. Confirm `auto-review` job fires.
4. Confirm `agent:review` is applied to the PR.
5. Confirm `agent-review.yml` runs.
6. Record: PR number, `agent-auto-trigger` run URL, `agent-review.yml` run URL.

---

### Test case 6 — Loop safety spot check ⏳ PENDING OPERATOR ACTION

**Gate state required:** `AUTO_TRIGGER_AGENTS = {"groom":true,"design":true,"developer":true,"review":true}`

**Objective:** Run the full pipeline end-to-end on a single seed issue and confirm it terminates at
"PR under review" without any workflow re-firing spuriously.

**Operator steps:**
1. Set all four gates to `true` and run `terraform apply`.
2. Open a fresh `do`-type seed issue (title: `[E2E-156 test-6] full pipeline loop safety`).
3. Observe: `auto-groom` → `agent:groom` applied → `agent-groom.yml` runs → `do` label applied →
   `auto-developer-do` → `agent:developer` applied → `agent-implement.yml` runs → PR on `agent/` branch
   opened → `auto-review` → `agent:review` applied → `agent-review.yml` runs.
4. Confirm no spurious re-triggers occur (e.g., `auto-groom` does not re-fire after `agent:groom` is
   removed on success, `agent:developer` does not re-fire after the PR closes).
5. Confirm the pipeline terminates cleanly at "PR under review."
6. Record: seed issue number, all workflow run URLs in sequence.

---

## Blocker note

Test cases 2–6 require setting `AUTO_TRIGGER_AGENTS` gates to `true` via Terraform. The developer-agent
GitHub App token used during this agent run does not have the `administration` permission needed to write
repository Actions variables directly (HTTP 403 on the variables API). The operator must apply the
Terraform changes and then run through cases 2–6 manually, recording the outcomes as comments on issue
[#156](https://github.com/mfrancza/agentic-development-workflow/issues/156).

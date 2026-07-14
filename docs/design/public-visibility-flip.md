# Design: Flip Repository to Public — Terraform Visibility + Settings Hardening

**Issue:** [#177](https://github.com/mfrancza/agentic-development-workflow/issues/177)
**Parent epic:** [#171 — Prepare repository for public visibility (demonstration mode)](https://github.com/mfrancza/agentic-development-workflow/issues/171)

## Summary

The last step of the public-readiness epic: flip `visibility` from private to
public and turn on the security settings that only make sense (or are only
free) on a public repo. Every prep sibling in #171 is closed except the
interaction-limits mechanism (#176), whose sign-off decided "reminder-issue,
no admin token in Actions" — so the actual `gh api PUT interaction-limits`
call is a manual step run by the maintainer at flip time, not automated.

The flip itself is irreversible for demonstration purposes: once the git
history is exposed it is cached and cannot be un-exposed. This design keeps
the actual state transition inside a single human-run `terraform apply`
session, staged from a merged Terraform config so that `terraform plan` is
the review surface.

## Requirements (from issue #177 grooming Q&A)

Restating the scope from the issue body:

1. **Visibility flip.** `terraform/main.tf` sets `visibility = "public"` and
   `terraform apply` is run to enact it.
2. **Secret scanning + push protection.** Both are free on public repos.
   Enable via the `github` provider's `security_and_analysis` block if the
   installed version (`~> 6.2`, currently 6.12.1) supports it — it does; no
   provider upgrade required.
3. **Fork-PR approval policy.** Require approval for **all outside
   collaborators** (the strictest of GitHub's three options). Matters for any
   future CI-style workflow that fires on fork PRs; today's agent workflows
   already exclude fork heads at the job-level `if:`, but the repo-wide
   Actions setting is defence in depth.
4. **`allowed_actions` tightening.** From `all` to a narrower policy. Every
   third-party action used across `.github/workflows/` is `actions/*`
   (GitHub-owned) — see the audit below — so `selected` with
   `github_owned_allowed = true` is a strict fit with zero pattern list.
5. **Interaction limit.** `collaborators_only` applied via `PUT
   /repos/{owner}/{repo}/interaction-limits`, run manually by the maintainer
   per the #176 sign-off (no admin-scoped identity in Actions).
6. **Post-flip verification.** Three checks: label-triggered workflows still
   run, no workflow fires from a test fork PR, interaction limit rejects a
   non-collaborator action.

### Ambiguity resolutions

- **"Optionally tighten `allowed_actions`"** — grooming asked to confirm with
  the owner. Resolving in-favour-of-tightening because the audit shows every
  workflow already relies only on `actions/*` (all GitHub-owned) — the
  strictest policy has zero configured-pattern surface and no workflow to
  break. If the owner wants to keep `all`, the implementer removes just that
  resource from the prep PR; the rest of the design stands.
- **"Terraform `security_and_analysis` if supported by the provider
  version"** — provider `~> 6.2` supports it. The design uses Terraform for
  this and does not carry a manual-settings fallback.
- **"CI workflow from the issue #33 design"** — issue #33 is now
  "Refactor GitHub Actions", not a CI workflow doc. The scope note in #177
  is stale; the fork-PR approval policy is still worth setting as a defence-
  in-depth measure regardless of whether a `CI` workflow exists yet.

## Third-party-action audit

Every non-local `uses:` reference in `.github/workflows/`:

| Action | Owner |
|--------|-------|
| `actions/checkout` | GitHub-owned |
| `actions/upload-artifact` | GitHub-owned |
| `actions/create-github-app-token` | GitHub-owned |
| `./.github/actions/agent-token` | Local (not counted) |

No `anthropics/*`, no `docker/*`, no `dorny/*`, no other non-GitHub action.
`allowed_actions = "selected"` with `github_owned_allowed = true` and empty
`patterns_allowed` covers everything. If a future workflow adds a non-GitHub
action, the workflow author must also extend `patterns_allowed` in
`terraform/main.tf` — this is the intended coupling, not a bug.

## Design

### Decision 1: Stage the flip as a single Terraform config PR, applied in a human session

**Options considered.**

- **(a) One prep PR, single apply** *(chosen)* — modify `terraform/main.tf`
  in one PR that includes `visibility = "public"`, `security_and_analysis`,
  and `github_actions_repository_permissions`. Merge only when the maintainer
  is ready to flip; then `terraform plan` (review) → `terraform apply` in one
  session; then the manual `gh api PUT interaction-limits` call.
- **(b) Multiple staged PRs merged over time** — each concern (visibility,
  security_and_analysis, actions restrictions) in its own PR, cumulative on
  `main`. Rejected: puts the repo in a broken intermediate state if any
  non-flip `terraform apply` runs between merges (public repo with default
  Actions settings). No apply cadence exists to protect against that.
- **(c) Guard the flip behind a Terraform variable** (`var.public = false`
  default; flip PR flips it to `true`) — separates "PR merges cleanly" from
  "state changes." Rejected as unnecessary given the maintainer-only apply
  cadence: the same guarantee comes from not merging the prep PR until the
  flip window.

Option (a) keeps the review surface concentrated (one PR, one `terraform
plan` diff) and the state transition atomic (single `apply`). The trade-off —
"the prep PR sits open until flip day" — is small: the design PR (this
document) is what merges first; the implementation PR is prepared and
reviewed but held for the flip day. This matches the "irreversible; needs
human sign-off" property of the issue itself.

### Decision 2: `security_and_analysis` block on `github_repository.this`

Provider `integrations/github ~> 6.2` accepts a `security_and_analysis`
block. The block only supports enabling secret scanning on public repos or
private repos with GHAS — this repo has neither today, which is why the
block is added *together with* the visibility flip in the same PR. Concrete
shape:

```hcl
security_and_analysis {
  secret_scanning {
    status = "enabled"
  }
  secret_scanning_push_protection {
    status = "enabled"
  }
}
```

`advanced_security` is org-scoped GHAS and stays off (out of scope; see
below).

Both `secret_scanning` and `secret_scanning_push_protection` are free on
public repos. Push protection blocks pushes containing detected secret
patterns at the git server; secret scanning does history-wide detection and
posts alerts. Together they complement the existing `secret-scan.yml`
gitleaks workflow, which stays in place (different detection engine, useful
overlap).

### Decision 3: `github_actions_repository_permissions` with `allowed_actions = "selected"`, GitHub-owned only

```hcl
resource "github_actions_repository_permissions" "this" {
  repository      = github_repository.this.name
  enabled         = true
  allowed_actions = "selected"

  allowed_actions_config {
    github_owned_allowed = true
    verified_allowed     = false
    patterns_allowed     = []
  }
}
```

`verified_allowed = false` is deliberate: "verified creators" is a broad
GitHub-managed list and admitting the whole set weakens the policy for no
current benefit — every action the workflows use is `actions/*`, which
`github_owned_allowed` already covers. If a future workflow adds a non-
GitHub action, the workflow author must extend `patterns_allowed` here (with
a full-SHA pin, matching the AGENTS.md convention). Reviews will catch a
workflow that omits the pattern update — the workflow will fail with a
"not allowed" error, which is loud and easily traced.

### Decision 4: Fork-PR approval policy — Terraform if the provider exposes it, else runbook

The Terraform `github` provider's coverage of the fork-PR approval policy
(`PUT /repos/{owner}/{repo}/actions/permissions/fork-pr-approval`, exposed
in the GitHub API in 2024) may or may not be in `~> 6.2` — the implementer
verifies at the point of writing HCL. Two branches:

- **(a) Provider supports it** — add the setting to
  `github_actions_repository_permissions` (or the sibling resource,
  whichever the provider exposes). Set the policy to require approval for
  **all outside collaborators** (strictest of the three GitHub options).
- **(b) Provider does not support it** — add the manual step to the flip
  runbook (Settings → Actions → General → "Fork pull request workflows from
  outside collaborators" → "Require approval for all outside collaborators")
  and document it in `AGENTS.md` alongside the other manual-at-flip steps.

Both branches meet the issue's requirement; the choice is a mechanical one
based on provider capability. The implementer records which branch was taken
in the flip runbook so future reviewers can find it.

### Decision 5: Interaction limit stays a manual `gh api PUT` at flip time

Per the sign-off in issue #176, no identity holds `administration:write` in
Actions, and the renewal is a documented manual procedure supported by a
reminder-issue workflow. The flip runbook lists the exact command:

```
gh api -X PUT repos/mfrancza/agentic-development-workflow/interaction-limits \
  -f limit=collaborators_only \
  -f expiry=six_months
```

The maintainer runs this from their own shell (with their own admin
credentials) immediately after `terraform apply` succeeds. The
interaction-limits API only accepts writes on a public repo, so this
sequencing is mandatory, not stylistic.

### Decision 6: Post-flip verification is a checklist owned by the flip issue

Verification is not agent-automatable end-to-end (fork-PR testing requires a
second GitHub account or a collaborator's fork; interaction-limit rejection
requires a non-collaborator). The design turns it into a three-item
checklist attached to the flip-execution sub-issue, which the maintainer
completes and comments on before closing #177:

- [ ] Label-triggered agent workflow runs — apply `agent:groom` (or any
      `agent:*` label) to a real issue post-flip and confirm the workflow
      dispatches and reaches the container.
- [ ] Test fork PR does not fire agent workflows — open a PR from a fork
      (or ask a collaborator to), confirm no `agent-*` workflow starts
      (the existing job-level `if:` gates and the fork-PR approval policy
      both contribute).
- [ ] Interaction limit rejects a non-collaborator — ask a non-collaborator
      GitHub account to try opening an issue or PR; confirm GitHub rejects
      it with the interaction-limits message.

If any check fails, the maintainer reopens the relevant task; the flip does
not need to be reverted (and cannot be) — the limits and settings are all
adjustable post-flip.

## Flip-day runbook

The implementation sub-issues produce the artefacts; the maintainer follows
this order on flip day:

1. Confirm all sibling sub-issues of #171 are closed (already true for
   #172–#175; #176 must be closed with the reminder workflow live).
2. Merge the Terraform prep PR (Task 1 below).
3. Merge any docs PR (Task 3 below) — order does not matter relative to (2).
4. From a shell with maintainer admin credentials:
   `terraform -chdir=terraform plan` → review the diff.
5. `terraform -chdir=terraform apply` → repo becomes public;
   `security_and_analysis` activates; `allowed_actions` narrows.
6. If Decision 4 branch (b) applies: set the fork-PR approval policy in the
   GitHub UI (Settings → Actions → General).
7. Run the manual `gh api PUT interaction-limits` command from Decision 5.
8. Work through the verification checklist (Decision 6). Comment the results
   on the flip-execution sub-issue.
9. Close #177.

## Out of scope

- **Reverting to private.** Not possible for demonstration purposes once the
  history has been public; not designed for.
- **GitHub Advanced Security (GHAS).** Org-scoped, paid, and unnecessary for
  the free public-repo baseline this design targets. `advanced_security`
  stays absent from `security_and_analysis`.
- **Automating the interaction-limit renewal.** Decided in #176 (reminder-
  issue workflow only). This design consumes that mechanism; it does not
  change it.
- **Automating the flip apply in CI.** The grooming notes explicitly forbid
  auto-apply. Terraform is invoked manually by the maintainer, same as
  today.
- **A `CI` workflow for the repo.** The reference in the issue body to
  "issue #33 design" is stale (#33 is now a refactor issue). The fork-PR
  approval policy is set anyway.
- **Redesigning branch protection** or agent identity permissions. Both are
  already public-safe (see the AGENTS.md security defaults).
- **Retroactive rewriting of git history.** The full-history secret scan in
  #174 verified history hygiene; no rewrite is planned.

## Task breakdown and dependencies

| Issue | Task | Depends on |
|-------|------|-----------|
| [#183](https://github.com/mfrancza/agentic-development-workflow/issues/183) | Terraform: `visibility = "public"` + `security_and_analysis` block (secret scanning + push protection) in `terraform/main.tf` | — |
| [#184](https://github.com/mfrancza/agentic-development-workflow/issues/184) | Terraform: `github_actions_repository_permissions` with `allowed_actions = "selected"` and `github_owned_allowed = true` | — |
| [#185](https://github.com/mfrancza/agentic-development-workflow/issues/185) | Fork-PR approval policy: check provider support; if supported, add to Terraform; else document as a manual step in the flip runbook | — |
| [#186](https://github.com/mfrancza/agentic-development-workflow/issues/186) | Docs: `README.md` + `AGENTS.md` — flip runbook, security defaults now in effect, manual `gh api PUT interaction-limits` step, cross-reference to #176 reminder workflow | — |
| [#187](https://github.com/mfrancza/agentic-development-workflow/issues/187) | Flip execution + verification checklist (human-run session): merge prep PRs, `terraform plan` + `apply`, manual interaction-limit call, three-item post-flip verification | Issue #183, Issue #184, Issue #185, Issue #186 |

Tasks Issue #183, Issue #184, Issue #185, and Issue #186 are independent and can proceed in parallel — this
document is the contract between them (all four merge onto `main` before
the flip session). Issue #187 is the human-run flip session that gates the
epic close.

Dependencies are recorded natively as GitHub blocked-by relationships on the
issues.

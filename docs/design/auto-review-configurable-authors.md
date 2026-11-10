# Design: Auto-review enrollment by configurable author list

**Issue:** #884 — Auto-review: enroll PRs by configurable author list instead of branch-name prefixes

**Related designs:**
- [Auto-trigger agents](auto-trigger-agents.md) — transition 5 and its branch-based enrollment decision are superseded here; other transitions and authorization boundaries are unchanged.
- [Auto-review marker race](auto-review-marker-race.md) — the developer entrypoint's draft → authoritative marker → ready-for-review publication contract remains authoritative.
- [Reusable workflow helper resolution](reusable-workflow-helper-resolution.md) — helper pinning and trusted checkout boundaries remain unchanged.

## Requirements as understood

Issue #884 requests an intentional, accepted pre-1.0 breaking change: auto-review enrollment must follow an installation-configured list of PR authors, not branch prefixes. There are no grooming comments or clarifying answers. The issue explicitly authorizes the empty default and this repository's initial author list; neither is an unresolved policy decision.

- Add Terraform `auto_review_authors`, a `list(string)` defaulting to `[]`, and export it as JSON in the repository Actions variable `AUTO_REVIEW_AUTHORS`.
- Set this repository's value to `["mfrancza-developer-agent[bot]", "mfrancza-s-claude-code[bot]"]` in `terraform/terraform.tfvars`.
- Require a same-repository head, membership of the **PR author** (not the event sender), and `AUTO_TRIGGER_AGENTS.review == true`.
- Remove branch-prefix enrollment and the developer-login enrollment bypass. Preserve the developer identity only for publication timing.
- The configured developer bot never enrolls on `opened`; it enrolls on `ready_for_review` only after the authoritative marker exists. Other listed authors, including bots, enroll on non-draft `opened` or `ready_for_review` without needing that marker.
- Preserve manual `agent:review` opt-in and the existing downstream review authorization. Humans are not automatically included in this installation's initial list.
- Document the breaking reusable-input changes, the empty-list behavior, the migration, and the release-body text. Cover the route with executable contract tests and validate three author classes through the deployed workflow after apply.

### Runtime evidence, not a linter-driven replacement

The observed enrollment failure is PR #878, `docs: require checking the pinned agent CLI when adding a model`, opened on November 10, 2026 at 00:57:48 UTC from `docs/issue-877-add-model-cli-check` by `mfrancza-s-claude-code[bot]`.
Its [auto-trigger run 42732262573](https://github.com/mfrancza/agentic-development-workflow/actions/runs/42732262573) completed the route but skipped authorization and auto-review.
The run's resolved inputs show `event-action: opened`, `pr-is-draft: false`, the Claude Code bot identity, and the non-agent branch; the PR event timeline records `agent:review` applied separately at 01:01:06 UTC by that app.
This is a functional enrollment miss despite the workflow run being green, not a claim that the existing expression has invalid syntax.
The issue's stated requirement changes the enrollment policy; the successful behavior for existing developer PRs must remain intact.

### Ambiguities resolved

- **Teams:** support explicit logins only in this change. The existing `check-agent-allowlist` resolver runs in `authorize`, after routing, and intentionally skips the sender gate for auto-review. Reusing it for author enrollment would require moving membership resolution before the route or splitting authorization, rather than a clean reuse. Do not add credentials or network lookups for this setting.
- **Developer identity:** retain required reusable input `developer-bot-login`, with its installation-specific value in the caller. Its role changes from an enrollment fallback to a timing guard only. The author must still appear in `AUTO_REVIEW_AUTHORS`; listing it is never inferred from this input.
- **Marker on other authors:** remove the marker requirement for other listed authors on `ready_for_review`. An external app or human does not use this entrypoint and cannot be required to produce its authoritative marker. Keep that requirement for the developer identity on every auto-enrollment path available to it.

## Decisions

### 1. Terraform owns a login-only, opt-in list

Add `auto_review_authors` to both root and `agent-vars` module variables, each with default `[]`, and pass it through `terraform/main.tf`.
Add a module `github_actions_variable.auto_review_authors` resource with `variable_name = "AUTO_REVIEW_AUTHORS"` and `value = jsonencode(var.auto_review_authors)`.
This is a new resource, not a state move or replacement of `AGENT_ALLOWLIST`.

Validate at both root and direct-module boundaries: entries must be non-empty, have no surrounding whitespace, use a GitHub-login form with optional literal `[bot]` suffix, contain no `/`, and be unique ignoring case.
Permit hyphenated login names and the literal bot suffix; reject wildcards, team references, and display-name forms such as `app/<slug>`.
Describe the accepted form and migration in both variable descriptions and the module README.

**Alternatives:** derive authors from `AGENT_ALLOWLIST`, retain branch fallbacks, or add team resolution.
Those options respectively conflate who can trigger agents with whose PRs should be reviewed, preserve the reported misclassification, or introduce an avoidable resolver dependency.
The explicit empty default is settled by issue #884, not reconsidered here.

### 2. Keep the reusable's route as the single predicate owner

Keep native Actions expressions in the existing route job; do not introduce an API-based author resolver, production expression parser, or PR checkout.
Read `vars.AUTO_REVIEW_AUTHORS` directly from the calling installation, as existing route gates read `vars.AUTO_TRIGGER_AGENTS`.
Use exact array-element membership, case-insensitive like other native Actions string comparisons; do not search a raw JSON string or accept login substrings.

The auto-review clause is logically:

```text
event is pull_request
AND head repository equals the caller repository
AND AUTO_TRIGGER_AGENTS.review is true
AND PR author is a non-empty member of AUTO_REVIEW_AUTHORS
AND (
  (event action is opened AND PR is not draft AND author is not developer-bot-login)
  OR
  (event action is ready_for_review AND PR is not draft
   AND (author is not developer-bot-login OR body contains '<!-- authored-by-model:'))
)
```

Use `fromJSON(vars.AUTO_REVIEW_AUTHORS || '[]')` for absent or empty variables.
Before `contains(parsedAuthors, inputs.pr-author-login)`, require an array shape, for example `startsWith(toJSON(parsedAuthors), '[')` using the same parsed expression in place of this explanatory alias.
This prevents a manually set JSON string from turning membership into substring matching; non-array JSON cannot enroll anyone.
Malformed JSON fails the route visibly without applying labels; Terraform-managed values are always JSON arrays of validated strings.
An absent or empty list skips enrollment, never falling back to branches or the developer login.

**Alternatives:** retain the blanket bot gate, require markers from every author, or move all routing into a new activity.
The first two block the requested external-app behavior; the third is unnecessary for a bounded predicate update and complicates trusted helper bootstrap.
The existing `AUTO_TRIGGER_AGENTS` parsing contract is unchanged.

### 3. Narrow, do not replace, the marker-race protection

The event matrix below assumes listed authors, same-repo heads, and the review switch enabled:

| Author | Event | Draft? | Marker? | Enroll? |
|--------|-------|--------|---------|---------|
| Developer identity | `opened` | Either | Either | No |
| Developer identity | `ready_for_review` | No | Present | Yes |
| Developer identity | `ready_for_review` | No | Missing | No |
| Other listed bot or human | `opened` | No | Either | Yes |
| Other listed bot or human | `opened` | Yes | Either | No |
| Other listed bot or human | `ready_for_review` | No | Either | Yes |
| Any author | `ready_for_review` | Yes | Either | No |

Unlisted authors, fork PRs, and a disabled review switch never auto-enroll, regardless of branch name or marker.
The draft check on `ready_for_review` is defensive; genuine ready events describe a non-draft PR.
Developer-authored non-draft openings remain skipped even if they already contain a marker: do not reopen the race by treating the model's initial body as authoritative.
There is no new polling or automatic recovery when an early ready event lacks a marker; the entrypoint contract and manual labeling remain the recovery boundaries from the marker-race design.

**Alternatives:** exempt all bots from `opened`, exempt every listed bot from the marker guard, or infer the developer identity from list position.
These respectively retain the bug, reopen the developer race, or make an unordered enrollment list carry an implicit identity contract.

### 4. Make the reusable contract break explicit

| Input | Change |
|-------|--------|
| `pr-head-ref` | Remove from reusable declaration and every caller/example; it no longer affects enrollment. |
| `pr-author-is-bot` | Remove from reusable declaration and every caller/example; use login equality for timing. |
| `developer-bot-login` | Retain as required; describe it as the installation's marker-timing identity, not an automatic enrollment entry. |
| `pr-author-login`, `pr-is-draft`, `pr-body`, `pr-head-repository` | Retain and forward from the original PR event. |
| `AUTO_REVIEW_AUTHORS` | New repository Actions variable, not a reusable input; configure through Terraform. |

Keep caller subscriptions to `pull_request: [opened, ready_for_review]` and existing issue events unchanged.
Update the repository caller and the complete adopting-guide stub together with the reusable so removed inputs cannot cause workflow-call validation failures.
The adopting guide must show the retained developer identity and both events, even where its old example already lags the current caller.

Update the `review` row in `AGENTS.md`, `terraform/modules/agent-vars/README.md` settings/input tables and examples, applicable root/module variable descriptions, and operator setup guidance in `README.md` and `docs/adopting.md`.
Add a short supersession reference to transition 5 in `docs/design/auto-trigger-agents.md`; do not rewrite unrelated historical decisions.
Do not duplicate the full predicate into `AGENTS.md`: describe the enrollment policy and point to the workflow source.

**Alternatives:** accept retired inputs as ignored compatibility shims, or introduce a new identity Actions variable.
Issue #884 accepts an explicit contract break; shims obscure migration without preserving old enrollment behavior.
Keeping the existing identity input avoids expanding configuration merely to rename its narrowed purpose.

### 5. Preserve existing security and authorization boundaries

The same-repo guard remains mandatory and independent of membership.
No changes to App permissions, secrets, branch protection, or agent identities are needed or authorized.
The label-writing `auto-review` job retains its no-checkout structure, pinned token action, and `needs: [route, authorize]` dependency.
Keep the existing auto-review sender-allowlist exception: the PR author's membership controls enrollment, not who emitted `ready_for_review`.
Other transitions keep their sender checks; downstream `agent-review` still enforces its current allowlist when the developer App applies the label.
Operators must keep that App in `AGENT_ALLOWLIST`; adding an author to `AUTO_REVIEW_AUTHORS` neither grants that author trigger permissions nor changes review approval policy.

**Alternative:** require the event sender to be a listed author or reuse the sender allowlist as a second author gate.
That would block normal promotions by a maintainer or the entrypoint and confuse two distinct policy boundaries.

## Compatibility and rollout

This is not identical to the old branch policy: after migration, an unlisted author on `agent/…` intentionally stops enrolling.
Before upgrading the reusable, set `auto_review_authors` to the developer App's `<slug>[bot]` login plus every other intended author, retain `auto_trigger_agents.review = true`, and have the operator apply the reviewed Terraform plan.
Update the caller inputs and reusable pin together.
For this repository the prescribed two-login value is the starting configuration.
Existing open PRs are not retroactively enrolled; apply `agent:review` manually when needed.
To disable future enrollment, set the list to `[]` or turn off the existing review switch; this does not remove labels or cancel reviews already started.

### Ready-to-paste release text

Include this subsection in the implementing routing PR's description for the maintainer to copy into the next GitHub Release body's upgrade section, following v0.5.0's release-body convention. Do not create a changelog file or publish a release as part of implementation.

> ### Breaking: auto-review enrollment
>
> Automatic review now enrolls same-repository PRs by author login, not by `agent/` or `design/` branch prefixes. Configure the new Terraform `auto_review_authors` list, exported as the JSON Actions variable `AUTO_REVIEW_AUTHORS`. Its default is `[]`: upgrading without configuring it disables automatic enrollment, even if `auto_trigger_agents.review` is already `true`.
>
> **Migration:** before upgrading, set `auto_review_authors = ["<developer-agent-app-slug>[bot]"]` in your Terraform values, append any other authors whose PRs should auto-enroll, keep `auto_trigger_agents.review = true`, and apply Terraform. This preserves automatic reviews for your developer agent; list any additional authors whose branch-based enrollment you want to retain. Team references are not supported.
>
> Update your `agent-auto-trigger-reusable.yml` caller at the same time: remove `pr-head-ref` and `pr-author-is-bot`; retain required `developer-bot-login` for the developer-only marker-timing guard, and continue forwarding `pr-author-login`, `pr-is-draft`, `pr-body`, and `pr-head-repository`. Subscribe to both `opened` and `ready_for_review`, as shown in the updated adopting guide. Other listed authors enroll on non-draft `opened` or `ready_for_review`; the developer bot still waits for `ready_for_review` with its marker. Fork PRs remain excluded. Manual `agent:review` labeling remains available.

## Validation and acceptance

### Automated contracts

- Extend `.github/scripts/test/auto-trigger-routing.test.ts` with table-driven evaluation of the **actual extracted route expression**, not a separately handwritten enrollment function. Use GitHub's `@actions/expressions` evaluator as a locked dev dependency if needed; keep it out of production execution.
- Cover every event-matrix row, unlisted authors on both retired prefixes, a listed author on `docs/…`, fork heads, missing head/author values, case-insensitive exact membership, substring non-matches, a non-author event sender, disabled/missing review configuration, and absent/empty author configuration.
- Cover malformed JSON (visible failure), non-array JSON (no enrollment), and the developer identity listed versus omitted. A marker alone must never enroll an unlisted author.
- Assert caller/reusable input agreement, removed input absence, unchanged issue routes and sender authorization, developer-only marker timing, and the no-checkout label-write boundary. Extend adopting-guide contract coverage for the changed stub.
- Check root/module defaults and JSON resource wiring, and validate rejection of whitespace-only values, surrounding whitespace, duplicate case variants, wildcards, and team references. Check the exact two-login repository value.
- For implementation changes under `.github/`, run `cd .github/scripts && npm ci && npm run typecheck && npm test`. Run workflow lint and `terraform fmt -check -recursive`; inspect a Terraform validation/plan through the existing CI without exposing credentials.

GitHub's expression semantics and the test evaluator are documented in the official [expression reference](https://docs.github.com/en/actions/reference/workflows-and-actions/expressions) and [Actions language-services repository](https://github.com/actions/languageservices).

### End-to-end validation after apply

The final task depends on all implementation and documentation tasks. An authorized operator applies the reviewed Terraform plan and supplies any app-authored test PRs; this design does not authorize the agent to change credentials or impersonate another author.

Record PR numbers, actual author logins, draft transitions, run URLs, route outcomes, and the resulting label/review effects:

- A developer-agent PR starts draft with no automatic review on `opened`; the entrypoint writes its authoritative marker, promotes it, and `ready_for_review` applies `agent:review`. Confirm the first review reads the authoritative model marker.
- A Claude Code app PR on a non-structural branch such as `docs/…` opens non-draft with no marker and receives `agent:review` through `opened` without manual labeling. Also exercise its draft → ready path without a marker.
- An unlisted author's same-repo PR on `agent/…` receives no automatic label; show that manual opt-in still works through existing authorization. Cover a fork case in an operator-approved fixture or retain it as a clearly identified automated-only guard if no live fork fixture is available.
- Confirm the applied variable contains the two prescribed identities and the review switch is enabled. A green run alone is insufficient: inspect resolved inputs and actual label application, and distinguish any later manual labels from automatic ones.

Post a validation report on the final sub-issue. If apply or an author fixture requires human action, report that requirement and leave live acceptance open rather than claiming a static test proves it.

## Out of scope

- Structural `agent/issue-{N}` and `design/issue-{N}` naming, the implement skip-if-PR-exists check, `find-newly-unblocked.ts`, and design-branch parsing for undrafting sub-issues.
- Team expansion, wildcard authors, provider/model-based enrollment, or inferring authors from branch names or labels.
- Changes to entrypoint publication, marker generation, model pairing, reviewer selection, or review re-request loops.
- Changes to workflow trigger subscriptions, other auto-trigger transitions, downstream manual-review policy, permissions, identities, branch protection, or deployment credentials.
- Backfilling existing PRs, publishing a release, applying Terraform during the design task, or running billable author-agent fixtures without the operator's normal authorization.

## Task breakdown

Tasks A and B can proceed independently. Each includes focused regression tests; task C integrates their final contracts and release guidance. Task D depends on **all** preceding tasks.

| Issue | Task description | Dependencies |
|-------|------------------|--------------|
| Issue #885 (A) | Add validated Terraform author configuration and JSON Actions variable | None; parallel with Issue #886 |
| Issue #886 (B) | Replace enrollment predicate and caller inputs; add executable route contracts | None; parallel with Issue #885 |
| Issue #887 (C) | Update operator/adopter docs and implementing-PR release guidance | Issues #885 and #886 |
| Issue #888 (D) | Validate deployed author enrollment end to end and record evidence | Issues #885, #886, and #887; operator apply required |

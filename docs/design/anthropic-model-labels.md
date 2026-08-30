# Design: All Anthropic models via `model:*` labels

**Issue:** [#202](https://github.com/mfrancza/agentic-development-workflow/issues/202)

## Summary

Extend the `model:*` label convention to cover every Anthropic model
available through the API — including both generic series tags that always
resolve to the latest snapshot of a family and pinned snapshot IDs for
reproducible runs — without expanding the entrypoint's explicit allowlist
into an unmaintainable per-snapshot list.

## Requirements (from issue #202 grooming Q&A)

1. **Scope** — every publicly available Anthropic model on the API.
2. **Naming** — model name plus optional pinned version; an unqualified name
   is treated as the latest of the series (backwards compatible with the
   existing `model:sonnet`/`model:opus`/`model:haiku` labels).
3. **Resolution mechanism** — hardcoded in the developer/reviewer
   entrypoints, not a dynamic API lookup.
4. **Integration** — labels, dispatch logic, grooming criteria,
   documentation, and CI configuration all updated together.

## Design

### Decision 1: three-tier label taxonomy for Anthropic

`model:*` labels for Anthropic split into three flavors, all mutually
exclusive (at most one `model:*` label per issue or PR — the existing
fail-loud check in `.github/scripts/src/resolve-model.ts` covers all three):

1. **Tier aliases** — `model:sonnet`, `model:opus`, `model:haiku`. These
   are unqualified names that the Claude Code CLI resolves to the latest
   snapshot of each series. They are the labels the grooming agent applies
   based on issue complexity (mechanical → haiku, typical → sonnet,
   design-heavy → opus) and the ones humans reach for most often.
2. **Generic series tags** — `model:claude-<family>-<major>-<minor>`
   (e.g. `model:claude-sonnet-4-5`, `model:claude-3-5-haiku-latest`,
   `model:claude-3-opus-latest`). These pin to a named series but still
   float across snapshots within it. Useful when a project standardizes on
   a specific Claude release train without wanting a snapshot dependency.
3. **Pinned snapshot IDs** — `model:claude-<family>-<major>-<minor>-YYYYMMDD`
   (e.g. `model:claude-sonnet-4-5-20250929`,
   `model:claude-opus-4-1-20250805`). Fully reproducible: the same label
   drives the same weights forever.

The grooming agent picks only from group (1) — the tier aliases carry the
complexity semantics the grooming criteria file describes. Groups (2) and
(3) are for human overrides and for automation that has a policy reason to
pin (e.g. reviewer runs during a model-version comparison).

### Decision 2: pattern-based provider routing for `claude-*`

`resolve_provider()` in `docker/scripts/entrypoint.sh` and
`docker/reviewer/entrypoint.sh` routes a model to Anthropic when the
model name is one of the three tier aliases OR begins with `claude-`.
This is a deliberate inversion of the "explicit allowlist" decision from
`docs/design/multi-provider-models.md` decision 2, and the trade-off warrants
being called out.

**Why we're inverting.** The original decision picked an explicit allowlist
because there were only three model names in play, and pattern inference
(`gpt-*` → openai, else anthropic) would silently accept typos. Neither
premise holds anymore: (a) Anthropic ships new snapshots every quarter, and
maintaining a per-snapshot case statement in two shell files becomes a
second-class hardcoded registry that drifts against reality; (b) the
`claude-` prefix is a stable, namespace-scoped guard — every Anthropic
model ID Anthropic has ever shipped starts with `claude-` (including the
legacy `claude-2.0` and `claude-instant-1.x` families), and no other
provider ships a model that starts with `claude-`. Typos of a Claude model
ID still fail loudly — the Anthropic API returns "model not found" for
invalid IDs, with the exact model name in the message, so the failure mode
is preserved, just moved one hop later.

OpenAI and xAI stay on explicit allowlists. Their model IDs do not share a
stable prefix (`gpt-5`, `o3`, `grok-3`, `grok-code-fast-1`), so a pattern
would be too broad or would need multiple prefixes; the current lists are
short enough that per-model gating is not painful.

### Decision 3: Terraform pre-provisions the common labels; ad-hoc pinned labels still route

`terraform/main.tf` pre-creates GitHub labels for the tier aliases, for the
currently active generic series tags, and for the currently active pinned
snapshot IDs — the ones a maintainer would want in the GitHub label picker
on issue creation. An ad-hoc pinned label that a user creates manually
(e.g. `model:claude-sonnet-4-5-20260601` for a future snapshot) is not
pre-provisioned but still routes correctly at runtime because
`resolve_provider()` accepts any `claude-*` name.

This keeps the picker curated without turning the entrypoint into a
gatekeeper against future Anthropic releases. If the maintainer wants a
new pinned label to appear in the picker, they add it to `terraform/main.tf`
and `terraform apply`; if they don't, the ad-hoc label still works.

### Decision 4: the grooming agent stays on tier aliases only

The grooming criteria file (`agents/grooming/label-criteria.json`) still
lists only the three tier aliases (`model:haiku`, `model:sonnet`,
`model:opus`) — the grooming agent never selects a generic series tag or
a pinned snapshot. Rationale: the criteria are complexity-tier semantics
(mechanical → haiku, typical → sonnet, design-heavy → opus), and mapping
tiers to snapshot IDs would either (a) hardcode a snapshot into the
grooming rules (which then goes stale) or (b) require the grooming agent
to know which snapshot is "current," a decision that belongs to repo
policy, not per-issue reasoning.

The pre-existing "leave any `model:*` label alone if one is already
present" rule extends unchanged to generic series tags and pinned
snapshots: a human who applies `model:claude-sonnet-4-5-20250929` before
grooming runs gets exactly that snapshot, and the groomer does not
overwrite it.

### Decision 5: no CI / workflow changes required

The workflow layer already treats the `model:*` label as opaque — the
`resolve-model` composite action (`.github/actions/resolve-model/`) strips
the `model:` prefix and passes the tail to the container via `AGENT_MODEL`,
and the container passes `AGENT_MODEL` to `claude --model` verbatim. Both
generic series tags and pinned snapshot IDs are already valid
`claude --model` inputs, so no workflow, action, or TypeScript activity
needs to change. The one-label-max fail-loud check in
`.github/scripts/src/resolve-model.ts` covers all three label flavors by
prefix match (`name.startsWith("model:")`), which was already correct.

## Out of scope

- **Dynamic model discovery** — decision 3 in the issue Q&A ruled this
  out. If Anthropic's public model list changes, the maintainer updates
  `terraform/main.tf` (labels) and `AGENTS.md` (docs) in one PR.
- **Per-model complexity criteria for grooming** — the grooming agent
  stays on the three tier aliases; extending its taxonomy to reason about
  specific snapshots would require issue-level policy the current criteria
  do not model.
- **Extending the same three-tier structure to OpenAI / xAI** — those
  providers' naming conventions do not fit the pattern-based Anthropic
  approach cleanly. Revisit if either provider's model list grows.

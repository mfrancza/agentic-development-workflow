terraform {
  required_providers {
    github = {
      source  = "integrations/github"
      version = "~> 6.2"
    }
  }
}

# Labels consumed by the agent workflows. Codifying them here means the label
# picker in the GitHub UI is pre-populated on a fresh repo — users don't have
# to remember exact spellings for the trigger and model-override labels, and
# the grooming agent doesn't need to `gh label create` on demand.
#
# Six groups:
#  - agent:* trigger labels (the workflows in .github/workflows/ gate on
#    these; applying one routes the issue or PR to that agent). Note that
#    `agent:developer`, `agent:groom`, and `agent:design` are applied to
#    issues, while `agent:review` is applied to PRs to request a review from
#    the code review agent (triggers agent-review.yml).
#  - model:<name> overrides (agent-implement / agent-groom /
#    agent-fix-deployment prefer these over the GitHub Actions repository
#    variable `vars.DEFAULT_MODEL` (not a Terraform variable); apply
#    at most one per issue). Covers Anthropic (Claude), OpenAI, and xAI
#    (Grok) models. For Anthropic, the labels split into three tiers:
#    (1) tier aliases (`model:sonnet`/`model:opus`/`model:haiku`) — the
#    grooming agent applies these based on complexity, and each resolves to
#    the latest snapshot of its series; (2) generic series tags (e.g.
#    `model:claude-sonnet-4-5`, `model:claude-3-5-haiku-latest`) — pin to a
#    named series while still floating across snapshots; (3) pinned snapshot
#    IDs (e.g. `model:claude-sonnet-4-5-20250929`) — fully reproducible.
#    The entrypoint accepts any `claude-*` model ID, so ad-hoc pinned labels
#    that are not pre-provisioned here still route correctly at runtime.
#  - model:<agent-type>:<name> per-agent overrides (take precedence over
#    generic model:<name> labels for issue-driven workflows). Pre-provisioned
#    agent types: developer, groom, design, review. Resolution waterfall for
#    issue-driven workflows: (1) model:<agent-type>:* label on the issue;
#    (2) generic model:<name> label; (3) vars.DEFAULT_MODEL. Fail loudly if
#    more than one label matches at either tier.
#  - grooming labels (the grooming agent applies these based on issue
#    content — see agents/grooming/label-criteria.json).
#  - workflow labels (`human-required` signals that an agent has escalated to
#    a human and the issue/PR should be assigned to a human actor;
#    `conflicts-escalated` marks PRs where the resolve-conflicts agent has
#    already tried and escalated, so subsequent pushes to main skip re-attempting).
#  - lifecycle labels (`draft` is applied by the designer agent to sub-issues
#    it creates; means the issue is scoped by an unmerged design and is not
#    yet ready for implementation; `blocked` is applied by the auto-trigger
#    when open blockers prevent immediate `agent:developer` dispatch, and is
#    also usable as a manual "hold for later" marker).
#
# Note on pre-existing labels: `bug`, `enhancement`, and `question` ship as
# GitHub defaults on new repos. If `terraform apply` errors with 422
# "already_exists" on those, import them first:
#   terraform import 'module.labels.github_issue_label.automation["bug"]' <repo_name>:bug
locals {
  automation_labels = {
    "agent:developer" = {
      color       = "6f42c1"
      description = "Route this issue to the developer agent for implementation."
    }
    "agent:groom" = {
      color       = "6f42c1"
      description = "Route this issue to the grooming agent to add labels and notes."
    }
    "agent:review" = {
      color       = "6f42c1"
      description = "Request a review of this PR from the code review agent."
    }
    "agent:design" = {
      color       = "6f42c1"
      description = "Route this issue to the designer agent to write a design doc and create draft sub-issues."
    }

    # Anthropic — top-level tier aliases (Claude Code CLI resolves each to the
    # latest snapshot of its series). These are the labels the grooming agent
    # applies based on issue complexity.
    "model:sonnet" = {
      color       = "1d76db"
      description = "Run agents on this issue with the latest Claude Sonnet (overrides DEFAULT_MODEL)."
    }
    "model:opus" = {
      color       = "1d76db"
      description = "Run agents on this issue with the latest Claude Opus (overrides DEFAULT_MODEL)."
    }
    "model:haiku" = {
      color       = "1d76db"
      description = "Run agents on this issue with the latest Claude Haiku (overrides DEFAULT_MODEL)."
    }

    # Anthropic — generic series aliases. Each resolves to the latest snapshot
    # of that named series (backwards-compatible with unqualified names per
    # issue #202). Prefer these when a run must stay on a specific series but
    # can float across snapshots within it.
    "model:claude-opus-4-5" = {
      color       = "1d76db"
      description = "Run agents with the latest Claude Opus 4.5 snapshot (overrides DEFAULT_MODEL)."
    }
    "model:claude-opus-4-1" = {
      color       = "1d76db"
      description = "Run agents with the latest Claude Opus 4.1 snapshot (overrides DEFAULT_MODEL)."
    }
    "model:claude-opus-4" = {
      color       = "1d76db"
      description = "Run agents with the latest Claude Opus 4 snapshot (overrides DEFAULT_MODEL)."
    }
    "model:claude-sonnet-4-5" = {
      color       = "1d76db"
      description = "Run agents with the latest Claude Sonnet 4.5 snapshot (overrides DEFAULT_MODEL)."
    }
    "model:claude-sonnet-4" = {
      color       = "1d76db"
      description = "Run agents with the latest Claude Sonnet 4 snapshot (overrides DEFAULT_MODEL)."
    }
    "model:claude-haiku-4-5" = {
      color       = "1d76db"
      description = "Run agents with the latest Claude Haiku 4.5 snapshot (overrides DEFAULT_MODEL)."
    }
    "model:claude-3-7-sonnet-latest" = {
      color       = "1d76db"
      description = "Run agents with the latest Claude 3.7 Sonnet snapshot (overrides DEFAULT_MODEL)."
    }
    "model:claude-3-5-sonnet-latest" = {
      color       = "1d76db"
      description = "Run agents with the latest Claude 3.5 Sonnet snapshot (overrides DEFAULT_MODEL)."
    }
    "model:claude-3-5-haiku-latest" = {
      color       = "1d76db"
      description = "Run agents with the latest Claude 3.5 Haiku snapshot (overrides DEFAULT_MODEL)."
    }
    "model:claude-3-opus-latest" = {
      color       = "1d76db"
      description = "Run agents with the latest Claude 3 Opus snapshot (overrides DEFAULT_MODEL)."
    }

    # Anthropic — pinned snapshot IDs. Prefer these when a run must be
    # reproducible against a specific Anthropic snapshot. Additional pinned
    # snapshots can be applied ad hoc by name — the developer/reviewer
    # entrypoint accepts any `claude-*` model ID; only the labels that appear
    # here are pre-populated in the GitHub label picker.
    "model:claude-opus-4-1-20250805" = {
      color       = "1d76db"
      description = "Run agents pinned to Claude Opus 4.1 snapshot 2025-08-05 (overrides DEFAULT_MODEL)."
    }
    "model:claude-opus-4-20250514" = {
      color       = "1d76db"
      description = "Run agents pinned to Claude Opus 4 snapshot 2025-05-14 (overrides DEFAULT_MODEL)."
    }
    "model:claude-sonnet-4-5-20250929" = {
      color       = "1d76db"
      description = "Run agents pinned to Claude Sonnet 4.5 snapshot 2025-09-29 (overrides DEFAULT_MODEL)."
    }
    "model:claude-sonnet-4-20250514" = {
      color       = "1d76db"
      description = "Run agents pinned to Claude Sonnet 4 snapshot 2025-05-14 (overrides DEFAULT_MODEL)."
    }
    "model:claude-haiku-4-5-20251001" = {
      color       = "1d76db"
      description = "Run agents pinned to Claude Haiku 4.5 snapshot 2025-10-01 (overrides DEFAULT_MODEL)."
    }
    "model:claude-3-7-sonnet-20250219" = {
      color       = "1d76db"
      description = "Run agents pinned to Claude 3.7 Sonnet snapshot 2025-02-19 (overrides DEFAULT_MODEL)."
    }
    "model:claude-3-5-sonnet-20241022" = {
      color       = "1d76db"
      description = "Run agents pinned to Claude 3.5 Sonnet snapshot 2024-10-22 (overrides DEFAULT_MODEL)."
    }
    "model:claude-3-5-haiku-20241022" = {
      color       = "1d76db"
      description = "Run agents pinned to Claude 3.5 Haiku snapshot 2024-10-22 (overrides DEFAULT_MODEL)."
    }
    "model:claude-3-opus-20240229" = {
      color       = "1d76db"
      description = "Run agents pinned to Claude 3 Opus snapshot 2024-02-29 (overrides DEFAULT_MODEL)."
    }
    "model:claude-3-haiku-20240307" = {
      color       = "1d76db"
      description = "Run agents pinned to Claude 3 Haiku snapshot 2024-03-07 (overrides DEFAULT_MODEL)."
    }

    # OpenAI models — flat allowlist kept in one-to-one sync with the openai)
    # case-arm in resolve_provider() in both entrypoints per
    # docs/design/multi-provider-models.md. Add new models to all three in the
    # same PR. Sourced from https://platform.openai.com/docs/models at
    # implementation time (September 2026); focus on models useful for software
    # tasks per docs/design/multi-provider-models.md requirement 4.
    "model:gpt-6-astra" = {
      color       = "1d76db"
      description = "Run agents on this issue with OpenAI gpt-6-astra (overrides DEFAULT_MODEL)."
    }
    "model:gpt-5.6-sol" = {
      color       = "1d76db"
      description = "Run agents on this issue with OpenAI gpt-5.6-sol (overrides DEFAULT_MODEL)."
    }
    "model:gpt-5.6-terra" = {
      color       = "1d76db"
      description = "Run agents on this issue with OpenAI gpt-5.6-terra (overrides DEFAULT_MODEL)."
    }
    "model:gpt-5.6-luna" = {
      color       = "1d76db"
      description = "Run agents on this issue with OpenAI gpt-5.6-luna (overrides DEFAULT_MODEL)."
    }

    # xAI Grok models — sourced from `grok models` at Grok Build CLI v1.0.13
    # (the pinned version in both Dockerfiles). Image/video models are excluded;
    # only text/coding-capable models are listed. Kept in one-to-one sync with
    # the xai) case-arm in resolve_provider() in both entrypoints per
    # docs/design/grok-build-cli.md Decision 5.
    "model:grok-4.20-0309-non-reasoning" = {
      color       = "1d76db"
      description = "Run agents with xAI grok-4.20-0309-non-reasoning (overrides DEFAULT_MODEL)."
    }
    "model:grok-4.20-0309-reasoning" = {
      color       = "1d76db"
      description = "Run agents with xAI grok-4.20-0309-reasoning (overrides DEFAULT_MODEL)."
    }
    "model:grok-4.20-multi-agent-0309" = {
      color       = "1d76db"
      description = "Run agents with xAI grok-4.20-multi-agent-0309 (overrides DEFAULT_MODEL)."
    }
    "model:grok-4.3" = {
      color       = "1d76db"
      description = "Run agents on this issue with xAI grok-4.3 via Grok Build CLI (overrides DEFAULT_MODEL)."
    }
    "model:grok-4.5" = {
      color       = "1d76db"
      description = "Run agents on this issue with xAI grok-4.5 via Grok Build CLI (overrides DEFAULT_MODEL)."
    }
    "model:grok-4.6" = {
      color       = "1d76db"
      description = "Run agents on this issue with xAI grok-4.6 via Grok Build CLI (overrides DEFAULT_MODEL)."
    }
    "model:grok-build-0.1" = {
      color       = "1d76db"
      description = "Run agents on this issue with xAI grok-build-0.1 via Grok Build CLI (overrides DEFAULT_MODEL)."
    }

    # Per-agent model overrides. Each label targets a single agent type and
    # takes precedence over any generic model:<name> label on the same issue.
    # Resolution waterfall: (1) model:<agent-type>:* on the issue; (2) generic
    # model:<name> on the issue; (3) vars.DEFAULT_MODEL. Fail loudly if more
    # than one label matches at either tier.
    # The model:review:* labels are pre-provisioned for future workflow
    # support; current PR-based workflows use single-tier model:* resolution.
    "model:groom:haiku" = {
      color       = "1d76db"
      description = "Groom agent only: use latest Claude Haiku (overrides generic model:* labels)."
    }
    "model:groom:sonnet" = {
      color       = "1d76db"
      description = "Groom agent only: use latest Claude Sonnet (overrides generic model:* labels)."
    }
    "model:groom:opus" = {
      color       = "1d76db"
      description = "Groom agent only: use latest Claude Opus (overrides generic model:* labels)."
    }
    "model:design:haiku" = {
      color       = "1d76db"
      description = "Design agent only: use latest Claude Haiku (overrides generic model:* labels)."
    }
    "model:design:sonnet" = {
      color       = "1d76db"
      description = "Design agent only: use latest Claude Sonnet (overrides generic model:* labels)."
    }
    "model:design:opus" = {
      color       = "1d76db"
      description = "Design agent only: use latest Claude Opus (overrides generic model:* labels)."
    }
    "model:developer:haiku" = {
      color       = "1d76db"
      description = "Developer agent only: use latest Claude Haiku (overrides generic model:* labels)."
    }
    "model:developer:sonnet" = {
      color       = "1d76db"
      description = "Developer agent only: use latest Claude Sonnet (overrides generic model:* labels)."
    }
    "model:developer:opus" = {
      color       = "1d76db"
      description = "Developer agent only: use latest Claude Opus (overrides generic model:* labels)."
    }
    "model:review:haiku" = {
      color       = "1d76db"
      description = "Pre-provisioned for future use; PR-based workflows still use single-tier model:* resolution."
    }
    "model:review:sonnet" = {
      color       = "1d76db"
      description = "Pre-provisioned for future use; PR-based workflows still use single-tier model:* resolution."
    }
    "model:review:opus" = {
      color       = "1d76db"
      description = "Pre-provisioned for future use; PR-based workflows still use single-tier model:* resolution."
    }

    "question" = {
      color       = "d876e3"
      description = "Issue lacks sufficient detail; clarifying questions posted."
    }
    "bug" = {
      color       = "d73a4a"
      description = "Reports incorrect or unexpected behavior in an existing feature."
    }
    "enhancement" = {
      color       = "a2eeef"
      description = "Requests new functionality or an improvement to existing behavior."
    }
    "dependency upgrade" = {
      color       = "0366d6"
      description = "Requests upgrading a library, package, tool version, or other dependency."
    }
    "do" = {
      color       = "0e8a16"
      description = "Simple, well-defined task; implementable in a single easy-to-review commit."
    }
    "plan" = {
      color       = "fbca04"
      description = "Complex enough to require design or planning before implementation."
    }
    "human-required" = {
      color       = "b60205"
      description = "A human is needed in the loop — agent should also assign the issue/PR to a human actor."
    }
    "conflicts-escalated" = {
      color       = "b60205"
      description = "The resolve-conflicts agent already tried this PR and escalated; remove to re-attempt."
    }

    "blocked" = {
      color       = "d1d5da"
      description = "Deferred pending blocker closure; also usable as a manual 'hold for later' marker."
    }

    "draft" = {
      color       = "d1d5da"
      description = "Scoped by an unmerged design; do not implement yet."
    }
  }
}

resource "github_issue_label" "automation" {
  for_each = local.automation_labels

  repository  = var.repository
  name        = each.key
  color       = each.value.color
  description = each.value.description
}

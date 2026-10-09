terraform {
  required_providers {
    github = {
      source  = "integrations/github"
      version = "~> 6.2"
    }
  }
}

# Restrict which Actions can run in this repository. Every third-party action
# used across .github/workflows/ is actions/* (GitHub-owned) — see the audit
# in docs/design/public-visibility-flip.md. Setting allowed_actions = "selected"
# with github_owned_allowed = true and an empty patterns_allowed covers all
# current workflows with zero configured-pattern surface.
#
# verified_allowed = false is deliberate: the "verified creators" list is a
# broad GitHub-managed set; admitting it would widen the policy for no current
# benefit (Decision 3 in the design doc). If a future workflow adds a non-GitHub
# action, the workflow author must (1) add an owner/repo@<sha> entry to
# var.patterns_allowed here and (2) pin the action to the same full SHA in the
# workflow YAML (per AGENTS.md convention) — the workflow will fail with a "not
# allowed" error if the pattern is missing, which is loud and easily traced.
# GitHub matches the full uses: string including the ref, so a bare owner/repo
# entry matches nothing. External consumers must additionally allow-list this
# repository's reusable workflows in the OWNER/REPO/.github/workflows/FILE@REF
# form (see README.md) — same-repository calls like ours are exempt.
resource "github_actions_repository_permissions" "this" {
  repository      = var.repository
  enabled         = true
  allowed_actions = "selected"

  allowed_actions_config {
    github_owned_allowed = var.github_owned_allowed
    verified_allowed     = var.verified_allowed
    patterns_allowed     = var.patterns_allowed
  }
}

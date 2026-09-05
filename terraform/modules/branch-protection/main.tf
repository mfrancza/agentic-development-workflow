terraform {
  required_providers {
    github = {
      source  = "integrations/github"
      version = "~> 6.2"
    }
  }
}

# Protection for the default branch via a repository ruleset (the modern
# primitive — supports granular bypass actors, unlike the legacy
# github_branch_protection resource).
#
# Repository admins can bypass review on PR merges but NOT push directly to
# the default branch; this stops the legacy "delete protection → merge →
# reapply" dance for the repo owner's own PRs while keeping push protection
# intact.
resource "github_repository_ruleset" "main" {
  name        = "main-protection"
  repository  = var.repository
  target      = "branch"
  enforcement = "active"

  conditions {
    ref_name {
      include = ["~DEFAULT_BRANCH"]
      exclude = []
    }
  }

  bypass_actors {
    actor_id    = 5 # Repository Admin role
    actor_type  = "RepositoryRole"
    bypass_mode = "pull_request"
  }

  rules {
    deletion                = true
    non_fast_forward        = true
    required_linear_history = true

    pull_request {
      required_approving_review_count   = var.required_approving_review_count
      dismiss_stale_reviews_on_push     = true
      require_code_owner_review         = false
      require_last_push_approval        = false
      required_review_thread_resolution = false
    }
  }
}

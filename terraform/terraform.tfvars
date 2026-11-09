repo_owner = "mfrancza"
repo_name  = "agentic-development-workflow"

# Include the agent bot identities so they can apply agent:* labels to route
# work to one another (e.g. the developer agent applying agent:review on its
# own PR). The [bot] suffix matches github.event.sender.login for GitHub App
# events.
agent_allowlist = [
  "mfrancza",
  "mfrancza-s-claude-code[bot]",
  "mfrancza-developer-agent[bot]",
]

default_model        = "gpt-6.1-terra"
design_default_model = "gpt-6.1-sol"
# Haiku is cheap for the bounded grooming pass. The groomer runs on Anthropic
# Haiku, but the vendor anchors (GROOM_IMPL_ANCHOR_MODEL = DEFAULT_MODEL,
# GROOM_DESIGN_ANCHOR_MODEL = DESIGN_DEFAULT_MODEL) are now OpenAI; the groomer
# emits OpenAI model labels for tasks whose class differs from the anchor.
groom_default_model = "claude-haiku-5-5"

# Humans to assign to issues and PRs when the agent applies the human-required
# label (e.g. escalations requiring security, billing, or permission decisions).
# Stored as ADMIN_ASSIGNEES Actions variable; workflows parse it with fromJSON().
admin_assignees = [
  "mfrancza",
]

# Humans to request as PR reviewers when the agent opens a PR and wants human
# code review. Stored as CODE_REVIEWERS Actions variable; workflows parse it
# with fromJSON().
code_reviewers = [
  "mfrancza",
]

# Raw Checks API check-run names that may trigger the fix-checks agent.
# Keep this existing CI check enabled as universal allowlist delivery rolls out.
fix_checks_allow = ["ci / Typecheck and test"]

# Auto-trigger configuration. Each key controls whether the corresponding
# agent:* label is applied automatically at the natural upstream signal,
# advancing the SDLC pipeline without manual labeling.
# See docs/design/auto-trigger-agents.md for full behavior and security notes.
auto_trigger_agents = {
  groom     = false
  design    = false
  developer = true
  review    = true
}

# Reviewer selection via explicit pairing: each Anthropic authoring model is
# reviewed by its same-class OpenAI equivalent (see the Cross-Vendor Class
# Table in docs/model-guidance.md). reviewer_models must stay empty — a
# non-empty REVIEWER_MODELS list takes precedence over pairing.
reviewer_models = []

review_model_pairing = {
  enabled           = true
  policy            = "explicit-map"
  preferred_vendors = ["openai", "xai", "anthropic"]
  explicit_map = {
    "haiku"             = "gpt-5.6-luna"
    "sonnet"            = "gpt-5.6-terra"
    "opus"              = "gpt-5.6-sol"
    "claude-haiku-5-5"  = "gpt-5.6-luna"
    "claude-sonnet-5-5" = "gpt-5.6-terra"
    "claude-opus-5-5"   = "gpt-5.6-sol"
    "gpt-6.1-sol"       = "claude-opus-5-5"
    "gpt-6.1-terra"     = "claude-sonnet-5-5"
  }
  fallback_chain = ["different-vendor-same-class", "same-vendor-different-model", "default-model"]
}

# Pre-commit checks backstop: shell command run inside PRE_COMMIT_SCRIPTS_DIR
# (.github/scripts by default) when the agent pushes a diff that touches
# .github/.  Responsible for both setup and the actual checks.
pre_commit_check_cmd = "npm ci && npm run typecheck && npm test"

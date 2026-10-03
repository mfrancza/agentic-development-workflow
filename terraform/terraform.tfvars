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

default_model = "sonnet"

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

# Auto-trigger configuration. Each key controls whether the corresponding
# agent:* label is applied automatically at the natural upstream signal,
# advancing the SDLC pipeline without manual labeling.
# See docs/design/auto-trigger-agents.md for full behavior and security notes.
auto_trigger_agents = {
  groom     = false
  design    = true
  developer = true
  review    = true
}

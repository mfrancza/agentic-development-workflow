# Design philosophy

This document explains *why* the agentic-development-workflow is shaped the
way it is. [`requirements.md`](../requirements.md) says what the system must
do, [`AGENTS.md`](../AGENTS.md) says how to work in it, and the documents under
[`docs/design/`](design/) record individual decisions. This document holds
the ideas those decisions come from.

## What this is

Agentic development uses coding agents to do software development by having
them take on the roles in a standard, issue-based development lifecycle:
groomer, designer, developer, reviewer. They work the way a human in that role
would. They pick up issues, push to branches, open pull requests, respond to
review comments and fix failing checks.

This is different from two other common approaches:

- **Vibe coding.** You give one agent a broad goal and let it run with little
  oversight. You interact with the product, not the code.
- **AI-assisted development.** An agent handles sub-tasks of work that is
  still assigned to a human engineer, as a pair programmer or a research
  assistant.

Both approaches work, but they scale poorly. Vibe coding rests on a single
sampled path through a large space of possible outputs. A bad choice made
early carries through the whole project, and you end up with little insight
into how the code works or where problems came from. Pair programming is
reliable, but with one human and one agent per task, the productivity gain has
a hard ceiling.

## How the models behave

The design starts from how current models actually behave, not from how we
would like tools to behave. These observations come from working with the
models from early 2026 onward, and other engineers have reported the same:

- **The best mental model is an enthusiastic, smart, overconfident
  entry-level engineer.** The "power tool" model gets it wrong in both
  directions. It underestimates how much ambiguity the models can handle, and
  it overestimates how consistent they are.
- **They tolerate ambiguity well, sometimes too well.** Models readily make
  assumptions and fill in missing details with reasonable guesses. When they
  fail, the cause is usually shallow understanding, not missing
  specification.
- **Output is a distribution, not a value.** Token sampling is stochastic, so
  the same model given the same task produces a range of results. Small
  changes to the input widen that range further. Quality on equivalent tasks
  will vary.
- **Confidence is not calibrated.** Models express the same high confidence
  whether they are right or wrong, so their own reports cannot be the
  quality gate.
- **Quality depends on examples.** Models extend existing patterns much more
  reliably than they invent new ones, even when they have thorough
  documentation. They draw on patterns from both their training and their
  context, and they apply the training patterns better.
- **They have no medium-term memory.** An agent does not learn from doing a
  task over and over. Notes in Markdown files help, but agents often forget or
  ignore what is written there.

## Our response: reuse the process we already have

None of these problems is new. Software organizations already have a full set
of tools for managing capable but inexperienced engineers whose work varies in
quality: issues with acceptance criteria, design review, branch protection,
independent code review, CI checks, least-privilege access, and escalation to
someone more senior. **This project applies that existing toolbox to agents.**

That choice has three consequences:

- **Agents work more effectively** because they operate inside guardrails
  that were designed for exactly their failure modes.
- **The process is decoupled from the agent platform.** The workflow talks to
  containers, GitHub identities and labels, not to any one vendor's agent
  runtime. Anthropic, OpenAI and xAI models all run through the same entrypoint
  (see [`multi-provider-models.md`](design/multi-provider-models.md)).
- **The process is decoupled from whether a human or an agent does the
  work.** Every role can be filled by either. A human can review an agent's
  PR, an agent can review a human's PR, and the developer agent can be
  skipped by hand-writing the change.

## Principles

### Start with human-like roles

LLMs are trained on human writing and produce human-like work, so the most
natural interface between people and agents is the one people already use
with each other. Each agent has a role with a narrow job (groom, design,
implement, review, fix checks, respond to review, resolve conflicts, fix
deployments). It gets one system prompt per action under
[`docker/scripts/prompts/`](../docker/scripts/prompts/), and it receives
work through the same issue-and-PR artifacts a human would. Because humans and
models expect the same things from those artifacts, we do not have to invent
or teach a new protocol.

### All interaction happens in GitHub

Agents talk to humans, and to each other, only through issue comments, PR
reviews and labels. This makes every handoff visible, auditable and open to
intervention. A human can read any conversation, step into it, or take over a
role at any point. It also gives the system a durable memory outside the
agent: the issue thread *is* the context, so no session has to remember
anything.

### Process control, not prompt perfection

Since output is a distribution, building software with LLMs is a
**process-control** problem. The question is not "how do I get the model to
produce a good answer" but "how do I make sure the output we keep comes from
the good part of the distribution". That breaks down into the usual
process-engineering questions:

- Where do inspections go?
- What kind of test runs at each stage?
- How do we trade off time, capacity and defect rate?
- Which steps are best done by hand and which automated?

In this repo the inspections are concrete. The groomer classifies and
clarifies before work starts. `plan`-class issues get a design document
reviewed as a PR before any implementation. Every PR runs CI and goes to an
independent reviewer agent. Failing checks and review feedback each loop back
to the developer automatically. Branch protection makes human approval the
final gate.

### Make the inner loops explicit

The alternative to a factory is a single high-level agent that recursively
manages its own subagents. That hides the inner loops, and each subagent has
to re-establish the context and goal on every run. This system does the
opposite: every loop is its own workflow with its own trigger, its own logs
and its own artifact. Grooming, design, implementation, CI fixes, review
response, conflict resolution and deployment fixes are each separate.

That transparency is what makes the system improvable. You can measure the
overall output, see which stage is producing defects, and swap out just that
component, whether it is a prompt, a model tier or a check. You cannot find
those problems by looking only at the final output of a high-level agent.
Container logs and session transcripts are uploaded for every run (see
[`agent-container-logs.md`](design/agent-container-logs.md)) for this reason.

### Humans only where they add value

The target is a **factory**: a defined process that is mostly automated, with
humans at the key decision points. Humans belong where judgment or
accountability is needed:

- inspecting a sample of the output for quality,
- giving independent approval for high-risk changes,
- performing actions that need elevated access, and
- working out why the automation is not behaving as expected.

The `human-required` label and assignment rules exist so that agents can say
"this needs a person" explicitly, instead of guessing. Auto-trigger gates
([`auto-trigger-agents.md`](design/auto-trigger-agents.md)) let an operator
remove manual handoffs one stage at a time as confidence grows.

### Agents are cheap, so spend them on feedback

Agents cost far less than human time. That makes some things worth doing
that would never be worth a person's attention:

- **Redundancy.** Several reviewers, or several alternative implementations
  of the same task.
- **Processing unstructured text at volume.** Sorting through review
  comments, CI logs and session transcripts that no one would read by hand.

Both create more feedback loops at lower cost. The right question is not
"is this worth an agent's time?" but "is this worth the tokens?"

### Containers are the trust boundary

Every agent runs in its own container and can act freely inside it. This
moves authorization out of the agent platform and into the execution
environment, where we can use the well-understood techniques for isolating
tenants in multitenant systems instead of trusting each vendor's in-process
sandbox (see [`inner-sandbox-posture.md`](design/inner-sandbox-posture.md)).

Isolation has two benefits:

- **A limited blast radius.** Agents are allowed to make mistakes and iterate,
  because a mistake cannot reach past the container and its scoped token.
- **No vendor lock-in.** The agent platform is decoupled from the rest of the
  environment, so changing CLIs or providers is a change to the image, not to
  the process.

### Separate identities, least privilege

Each agent role has its own GitHub App identity, separate from the user's,
with only the permissions that role needs. The developer agent can push
branches but cannot merge or push to `main`. The reviewer agent cannot write
contents at all, and this is enforced by the image as well as by its token.
Separate identities make it clear in every PR who did what. Branch protection
requires independent approval, so no agent can approve its own work, and
neither can a lone admin. Agents never see the user's credentials. They get
short-lived installation tokens minted for each run.

### Prefer examples to instructions

Because models extend existing patterns better than they follow written
rules, the repo is kept consistent on purpose. There is one way to write an
activity, one shape for a workflow, and one convention per concern, all
written down in `AGENTS.md`. Volatile facts live in exactly one authoritative
source and are not copied around. Good existing code steers an agent better
than a longer prompt does, so a new competing convention costs more here than
it would in a human-only codebase.

### Self-mutating

The workflows, prompts, Terraform and containers all live in the same repo
that the agents work on. They were largely built *with* the system itself, so
the pipeline can change itself as the project changes. A fork can reshape the
process to fit a different project by filing issues against its own copy.

### Self-improving, within limits

Cheap processing of unstructured data plus a self-mutating pipeline makes
fully automated improvement loops possible. For example, agent logs and
review comments can be mined for recurring failures, and those findings can
become fixes to prompts or documentation. These loops mostly push the system
toward *local* optima. They polish the process but will not redesign it.
Still, a system that keeps polishing itself takes much less effort to
maintain and change, and humans stay responsible for the larger structural
changes.

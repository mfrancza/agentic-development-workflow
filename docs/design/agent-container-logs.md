# Design: Agent container logs for debugging

**Issue:** [#32](https://github.com/mfrancza/agentic-development-workflow/issues/32)

## Summary

Capture two log streams from every agent container run — the process's merged
stdout/stderr and the Claude Code session transcript — and expose them as
GitHub Actions artifacts on every workflow run (success or failure). This is a
new capability: today, container stdout lives in the workflow log while the
Claude Code session JSONL is written inside the container's ephemeral
filesystem and disappears with `docker run --rm`.

The design uses off-the-shelf pieces already in the repo's stack
(`actions/upload-artifact`, a bind-mount, a trap-EXIT in the entrypoint) and
adds no external services, credentials, or per-runner storage. Local runs get
the same artifacts by bind-mounting a host directory.

## Requirements (from issue #32 grooming Q&A)

1. **What to log** — stdout/stderr of the process running the model **and** the
   model session logs (the Claude Code JSONL transcript that records every
   turn, tool call, and response).
2. **Scope** — every agent container used by the workflow. That is the
   developer image (six actions: `implement`, `groom`, `design`, `fix-checks`,
   `respond-review`, `fix-deployment`) and the reviewer image. Not the
   `undraft-sub-issues` job in `agent-design.yml` or other non-container jobs —
   their output already lives in the workflow log.
3. **How to surface them** — evaluated in this design, biased toward
   off-the-shelf integrations with minimal new dependencies.
4. **New capability** — no pre-existing mechanism is broken; there is nothing
   to preserve or migrate.
5. **Motivating scenario** — understanding agent behavior and debugging
   unexpected container exits. Both require the logs to survive the container,
   including the case where the entrypoint aborts (`set -e` failure, Claude
   crash, OOM) before its normal exit path. **Limitation:** an OOM kill is
   delivered as SIGKILL, which bypasses bash EXIT traps entirely — the trap
   body (session harvest and redaction) will not run and whatever `tee` has
   already written to the bind-mount is the only artifact that survives. This
   is acknowledged as an inherent constraint of the trap-based approach; the
   partially-written `container.log` still covers the up-to-OOM output, which
   is the most useful part for diagnosing the failure.

## Design

### Decision 1: capture two streams — merged stdout/stderr, and the Claude session JSONL

Neither stream alone is sufficient:

- **stdout/stderr** — every `log()` line the entrypoint emits, every message
  from `gh`/`git`/`docker`, and the final `claude --print` response text. This
  is what today's workflow log already contains; capturing it as a file lets
  us bundle it with the session transcript in a single artifact instead of
  telling debuggers to jump between the workflow-run UI and the artifact.
- **Claude Code session JSONL** — one file per session at
  `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl` (confirmed against
  Claude Code v2.1.150, the version pinned in `docker/Dockerfile`; the #128
  validation task must re-verify this path after any Claude Code version
  bump, since a silent path change would produce an empty `session/`
  directory with no other error). Records
  each turn, tool invocation, tool result, and model response with
  timestamps. Persists by default in `--print` mode (no flag needed). This is
  what the Q&A calls "model session logs" — the turn-by-turn record needed to
  understand *why* the agent did what it did. In `--print` mode only the final
  text is echoed to stdout, so without the JSONL this information is
  irrecoverable.

Alternatives considered:

- **Just stdout, no session JSONL.** Misses the tool-call reasoning that is
  the primary debugging artifact. Fails Q&A item 1.
- **Just the session JSONL, no stdout.** Misses everything the entrypoint
  emits before/after Claude runs — clone failures, verification failures,
  push errors — which are exactly the "unexpected container exit" cases in
  Q&A item 5.
- **Structured JSON via `--output-format stream-json` piped to a file.**
  Gives a superset of the JSONL, but only for the Claude segment; still need
  the entrypoint's own output; and the JSONL on disk is already the format
  Claude Code itself produces natively — capturing what already exists is
  cheaper than re-plumbing the invocation.

### Decision 2: store logs as GitHub Actions artifacts via `actions/upload-artifact`

The Q&A biases toward integrating with off-the-shelf apps and minimizing
dependencies. Every workflow already runs on GitHub Actions, already builds
the image on demand, and already uses pinned third-party actions. Artifacts
solve the "logs must outlive the container" problem with no new service, no
new credential, and a UI (`gh run download`, the workflow-run page) that
matches how workflow logs are already accessed.

- Retention is configurable per upload (`retention-days`) and defaults to the
  repo/org setting. We set an explicit `retention-days: 30` on the upload —
  long enough for post-mortem debugging, short enough to keep storage costs
  bounded without needing a separate policy.
- Failure runs still upload: `if: always()` on the upload step ensures logs
  survive an aborting container.
- **Artifact access scope:** On a *private* repository, artifacts are scoped
  to the workflow run and require the same repository read access as the
  workflow log. On a *public* repository, workflow run artifacts are
  downloadable by anyone (unauthenticated `gh run download` or the Actions
  UI) — there is no access gate beyond the repo being public. The redaction
  strategy in Decision 4 is therefore the primary security control regardless
  of repository visibility; it must not be treated as a defence-in-depth
  measure subordinate to access control.

Alternatives considered and rejected:

- **External log aggregation** (Grafana Cloud Loki, Datadog, ELK, an
  in-repo Vector sidecar). Adds an account, a secret, a network egress path,
  and a moving part per run. Explicitly against the Q&A's "minimize
  dependencies" bias for a debugging use case that surfaces once every few
  runs.
- **Commit logs to a branch or a separate repo.** Pollutes git history,
  provides no automatic retention or purge, and requires push credentials
  from the reviewer image which today has none (would break the reviewer's
  structural no-write guarantee — see `reviewer-container.md` decision 3).
- **Post logs as a PR/issue comment.** Comment size limits (~64 KB) truncate
  real session transcripts, formats poorly, and pollutes the human-facing
  conversation on every run.
- **Emit via `$GITHUB_STEP_SUMMARY`.** Markdown-only, 1 MB per step, tied to
  the run UI with no download path — inferior to artifacts for this use
  case.

### Decision 3: bind-mount `/home/agent/logs` → host tempdir; entrypoint trap-EXIT copies session files

Contract between the container and the workflow:

- **Container path:** `/home/agent/logs/` — writable by the container's
  `agent` user. The entrypoint creates two things inside it before it exits:
  - `container.log` — the merged stdout/stderr of the run (see below).
  - `session/` — a copy of `~/.claude/projects/` for the session(s) this
    run produced.
- **Host path:** `${{ runner.temp }}/agent-logs/` (workflow-controlled;
  pre-created with `chmod 0777` because the container's `agent` UID differs
  from the runner's `runner` UID and the mount must be writable).
- **Wiring:** `docker run --rm -v "$HOST_LOGS:/home/agent/logs" …` in every
  workflow that runs an agent image.

Two mechanisms feed `container.log`:

- **Inside the container:** the entrypoint runs
  `exec > >(tee -a /home/agent/logs/container.log) 2>&1` at the top of
  `main` (after env validation but before any other output) so all subsequent
  output goes to both the container's stdout (still visible in the workflow
  log, unchanged) and the log file. Because `tee` writes as the container
  runs, a mid-run abort still leaves everything up to the abort point on
  disk.
- **Session file harvest:** a `trap` on `EXIT` (installed after the tee is
  set up so trap output is also captured) copies `~/.claude/projects/.` to
  `/home/agent/logs/session/`. Runs on every exit path — normal, `set -e`
  abort, SIGTERM from workflow cancellation.

**Implementation constraint — tee flush before redaction (required in #125):**
`exec > >(tee -a …)` creates a background subprocess connected to bash's
stdout via a kernel pipe. When the EXIT trap fires, that subprocess is still
running — it continues draining whatever is in the pipe buffer. If the
trap's redaction pass runs while tee still has unwritten data buffered, tee
subsequently flushes that data to `container.log` *after* redaction, leaving
the final kilobytes of output (most recent `gh`/`git` commands, final Claude
response) unredacted in the file.

Before installing the tee redirect, the entrypoint **must** save the
original stderr so it can be restored during the flush sequence:

```bash
exec 3>&2                                          # save original stderr → fd 3
exec > >(tee -a /home/agent/logs/container.log) 2>&1
```

The trap body **must** follow this sequence to close the race:

1. Emit any final log lines that should appear in `container.log` (these
   must come *before* closing the fds).
2. Close both fds that write into the tee pipe:
   - `exec >&-` — close bash's stdout fd, signalling EOF on that pipe end.
   - `exec 2>&3` — restore bash's stderr to the saved original (fd 3),
     removing it from the tee pipe. Then `exec 3>&-` to close the saved fd.
   Both fds must be removed from the pipe before calling `wait`; closing only
   stdout leaves stderr as an open pipe writer and tee will never see EOF,
   causing `wait` to hang.
3. `wait` — block until the tee subprocess exits. After `wait` returns,
   `container.log` is fully written.
4. Copy `~/.claude/projects/` to `/home/agent/logs/session/`.
5. Run the `sed -i` redaction pass over the entire `/home/agent/logs/` tree
   (including the just-copied session files).

Any trap messages that should appear in `container.log` must be emitted
before step 2 (before the fds are closed). After step 2, stdout (fd 1) is
closed; stderr (fd 2) is restored to the original workflow-log stream by
`exec 2>&3` and is still writable but will **not** appear in
`container.log`. fd 3 is closed and cannot be written to after
`exec 3>&-`. Messages intended for `container.log` must therefore use
`echo "…" >> /home/agent/logs/container.log` directly. #125 must implement
this sequence.

Why bind-mount rather than `docker cp` from a named volume: `--rm` is
retained across all workflows for cleanup hygiene, and `docker cp` before
`--rm` requires reordering the run/cleanup sequence in every workflow.
Bind-mount is one added `-v` flag.

The reviewer image gets the same treatment: its entrypoint already has a
`log()` helper and the same `run_claude()` shape, so the added block is
mechanically identical. The mount does not weaken the reviewer's no-write
guarantee — it exposes a *log directory*, not the repo working tree, and the
reviewer token remains Contents:read.

### Decision 4: redact known secret values inside the container before upload

Neither Claude Code nor the entrypoint intentionally prints `GH_TOKEN` or
`ANTHROPIC_API_KEY`, but tool-call responses could echo them accidentally
(a `gh` verbose flag, a `git` transport error dumping the URL, a Claude prompt
that requests them). Workflow logs benefit from GitHub Actions' automatic
secret masking; **artifact contents are uploaded verbatim** and bypass that
masking. So the entrypoint's trap-EXIT runs a redaction pass over
`/home/agent/logs/` that replaces the literal values of `GH_TOKEN` and
`ANTHROPIC_API_KEY` with `***REDACTED-GH_TOKEN***` /
`***REDACTED-ANTHROPIC_API_KEY***` before the workflow reads the mount.

Doing this inside the container keeps the token value out of any workflow-side
shell command (no risk of it appearing in a `set -x` trace) and keeps the
workflow step body identical across all seven workflows.

Alternative rejected: redacting in the workflow after `docker run`. Would
require adding the token to another shell context and duplicating the sed
block into every workflow.

### Decision 5: one upload step per workflow, artifact name encodes run identity

Each workflow adds two steps:

1. **Pre-run** — `mkdir -p "${RUNNER_TEMP}/agent-logs" && chmod 0777 "${RUNNER_TEMP}/agent-logs"`.
2. **Post-run** — `actions/upload-artifact` with `if: always()`, a name that
   embeds the workflow context (e.g.
   `agent-logs-implement-issue-${{ github.event.issue.number }}-run-${{ github.run_id }}-${{ github.run_attempt }}`),
   `path: ${{ runner.temp }}/agent-logs`, and `retention-days: 30`.

The name pattern serves three needs: it disambiguates re-runs of the same
event (`run_attempt`), lets a human find the artifact for a specific issue/PR
without opening every workflow run, and stays under GitHub's 128-char artifact
name limit for reasonable issue/PR numbers.

`actions/upload-artifact` is pinned to a full 40-char commit SHA with an
inline version comment, per the repo's third-party action pinning convention
(AGENTS.md → Repo-specific security defaults).

### Decision 6: local-run path — same mount, documented in the README

For `docker run` invocations from a developer laptop (README's "Build the
developer agent container" section), documentation gains one line:
`-v "$PWD/logs:/home/agent/logs"`. The container-side path is identical, so
local behavior matches CI behavior — the JSONL and `container.log` land in
`./logs/` on the host. No image change beyond what CI already needs.

### Decision 7: no change to what the entrypoint logs, just where it lands

The `log()` helpers, `set -euo pipefail`, and the per-action log lines
already in the entrypoints are the debugging vocabulary the team is used to.
This design captures them faithfully; it does not add structured logging,
JSON log lines, or new log levels. That is a separable improvement (would
need a design of its own) and is deliberately not bundled.

## Out of scope

- **Real-time streaming to an external service.** The workflow log already
  streams during a run; artifacts are for post-run analysis. If real-time
  external streaming is later needed, it's an additive change (a sidecar or
  a Vector `docker run`) built on top of this design's captured file set.
- **Structured / JSON log lines from the entrypoint itself.** The current
  `[agent] ISO8601 message` format is preserved. Restructuring is a separate
  concern.
- **Retention policies beyond the 30-day artifact default.** If longer
  retention is needed for specific incidents, download and archive
  externally.
- **Log capture for non-container jobs** (the `undraft-sub-issues` job in
  `agent-design.yml`, the model-resolver preflight steps). Their output is
  already in the workflow log; artifacting the workflow log is out of scope
  and would duplicate GitHub's own retention.
- **Sanitizing PR/issue content that Claude quotes back into logs.**
  Requirements only cover secret material; issue and PR bodies are already
  public in the workflow log.
- **Log aggregation UI / cross-run search.** Downloading the artifact for a
  specific run is the intended access pattern; multi-run analysis is out of
  scope.

## Task breakdown and dependencies

| Issue | Task | Depends on |
|-------|------|-----------|
| [#125](https://github.com/mfrancza/agentic-development-workflow/issues/125) | Add log-capture block to the developer image entrypoint (`docker/scripts/entrypoint.sh`): install the `tee` redirect, install the trap-EXIT that copies `~/.claude/projects/` to `/home/agent/logs/session/` and runs the secret-redaction pass, ensure `/home/agent/logs` exists and is writable. Same block, copied, into the reviewer entrypoint (`docker/reviewer/entrypoint.sh`). No behavior change to the actions themselves. | — |
| [#126](https://github.com/mfrancza/agentic-development-workflow/issues/126) | Update all six developer-image workflow container-run steps (`agent-implement.yml`, `agent-groom.yml`, `agent-design.yml` design job, `agent-fix-checks.yml`, `agent-fix-deployment.yml`, `agent-respond-review.yml`) and the reviewer workflow (`agent-review.yml`): pre-create `${RUNNER_TEMP}/agent-logs` with 0777, add `-v` bind-mount to `docker run`, add pinned `actions/upload-artifact` step with `if: always()`, run-specific artifact name, and `retention-days: 30`. | — |
| [#127](https://github.com/mfrancza/agentic-development-workflow/issues/127) | Documentation: update `AGENTS.md` (where logs land, what's in them, the 30-day retention, the redaction pass) and `README.md` (add the `-v "$PWD/logs:/home/agent/logs"` mount to the local `docker run` example, note the artifact download flow for CI runs). | — |
| [#128](https://github.com/mfrancza/agentic-development-workflow/issues/128) | End-to-end validation: trigger one developer workflow (`implement` or `groom` on a throwaway issue) and one reviewer workflow on a real PR; download the artifacts via `gh run download`; verify `container.log` contains the entrypoint's log lines and the final Claude output; verify `session/**/*.jsonl` exists and is non-empty; verify a synthetic token in the logs is redacted (temporarily set a fake `GH_TOKEN` value and confirm it does not appear in the uploaded artifact); force an intentional failure (e.g. bad env var) and confirm the artifact still uploads. **Additionally: after any bump to the Claude Code version pinned in `docker/Dockerfile`, explicitly confirm that `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl` (the path confirmed against v2.1.150) still exists and is non-empty — a silent path change would produce an empty `session/` directory with no other error.** | #125, #126 |

Issues #125 and #126 can proceed in parallel — this document is the contract
between them: the container writes everything to `/home/agent/logs/` before
exit; the workflow bind-mounts that path at `${RUNNER_TEMP}/agent-logs` and
uploads it after the run. Issue #127 is documentation and can start
immediately. Issue #128 validates the full loop and picks up any small fixes.

Dependencies are recorded natively as GitHub blocked-by relationships on the
issues.

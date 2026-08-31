# Design: Inner-sandbox posture for agent containers

**Issue:** [#396](https://github.com/mfrancza/agentic-development-workflow/issues/396)

**Related designs:**
- [`grok-build-cli.md`](grok-build-cli.md) (Issue [#353](https://github.com/mfrancza/agentic-development-workflow/issues/353)) — established the current `run_xai()` runner with `--sandbox workspace` on the developer image and no sandbox on the reviewer image.
- [`multi-provider-openai-runner.md`](multi-provider-openai-runner.md) (Issue [#81](https://github.com/mfrancza/agentic-development-workflow/issues/81)) — established the current `run_openai()` runner with `--sandbox workspace-write` on both images.
- [`grok-developer-image-entrypoint.md`](grok-developer-image-entrypoint.md) (Issue [#279](https://github.com/mfrancza/agentic-development-workflow/issues/279)) — first version of the developer-image `run_xai()`; receives an amendment note in this design.
- [`multi-provider-models.md`](multi-provider-models.md) (Issue [#75](https://github.com/mfrancza/agentic-development-workflow/issues/75)) — parent multi-provider architecture; unchanged by this design.

## Summary

Ratify **Option 2** from Issue [#396](https://github.com/mfrancza/agentic-development-workflow/issues/396):
treat the outer container as the trust boundary and stop asking the in-container CLIs
(Grok Build CLI, OpenAI Codex CLI) to run their own sandboxes on top. Both sandboxes
rely on kernel-level user-namespace creation (grok delegates to `bwrap`; Codex uses
libc `clone(CLONE_NEWUSER)`/`unshare`), which the outer `docker run` seccomp default
blocks; every provider run therefore fails closed before doing any work.

Concretely, in the developer image:
- Drop `--sandbox workspace` from `run_xai()` in `docker/scripts/entrypoint.sh` (matches the reviewer-image `run_xai()` which already omits it).
- Change `--sandbox workspace-write` to `--sandbox danger-full-access` in `run_openai()` (Codex's explicit no-sandbox mode; equivalent posture to the grok change).
- Remove the now-unused `bubblewrap` apt package and the `bwrap --version` build-time check from `docker/Dockerfile`.

The reviewer image's `run_xai()` already omits `--sandbox` (no change); its
`run_openai()` receives the same `--sandbox workspace-write → danger-full-access`
change to keep the two images consistent and to pre-empt the same failure mode.

`AGENTS.md` receives one bullet under **Key Design Constraints** codifying the
posture ("the outer container is the trust boundary; in-container CLI sandboxes
are not relied on for confinement"), and the two affected prior designs
(`grok-developer-image-entrypoint.md`, `multi-provider-openai-runner.md`) each
receive a top-of-file amendment note pointing here.

## Requirements as understood

From the issue body and grooming Q&A on Issue [#396](https://github.com/mfrancza/agentic-development-workflow/issues/396):

1. **Diagnose the failure class.** The outer `docker run` invocation used by
   `.github/actions/run-agent/action.yml` runs with Docker's default seccomp
   profile, which denies unprivileged `clone(CLONE_NEWUSER)` /
   `unshare(CLONE_NEWUSER)`. Any in-container process that wants its own
   user-namespace-backed sandbox therefore fails at startup. This affects:
   - **Grok:** `run_xai()` passes `--sandbox workspace`, which delegates to
     `bwrap`; bwrap fails with the observed error
     `bwrap: No permissions to create new namespace…`.
   - **Codex:** `run_openai()` passes `--sandbox workspace-write`, which Codex
     enforces via its own seccomp/landlock+namespace machinery. Per
     Issue [#396](https://github.com/mfrancza/agentic-development-workflow/issues/396)'s reference to
     Issue [#236](https://github.com/mfrancza/agentic-development-workflow/issues/236) and its cited
     run 33346672574, Codex requested user-namespace support to execute shell
     commands — the same class of failure.

2. **Decide the posture.** Issue [#396](https://github.com/mfrancza/agentic-development-workflow/issues/396)
   presents two coherent, mutually exclusive resolutions:
   - **Option 1: grant the capability.** Add `--security-opt seccomp=unconfined`
     (or an equivalently permissive custom seccomp profile) to the outer
     `docker run` in `.github/actions/run-agent/action.yml`, so the inner
     sandboxes can create user namespaces. Weakens the outer container
     boundary for every agent run to enable an inner boundary.
   - **Option 2: drop the inner sandboxes.** Remove `--sandbox workspace` /
     switch Codex to no-sandbox mode, treat container isolation as the sole
     security boundary. Loses in-container defense-in-depth for the affected
     runners.

   This design ratifies **Option 2**. The issue author, the reviewer image's
   pre-existing posture, and `AGENTS.md`'s stated constraint ("Agent containers
   must be isolated from user credentials — the entrypoint sets
   `GIT_ASKPASS`/`GIT_TERMINAL_PROMPT=0` and only sees the injected `GH_TOKEN`")
   all lean this way. Justified in **Decision 1** below.

3. **Apply the decision consistently.** Issue [#396](https://github.com/mfrancza/agentic-development-workflow/issues/396)
   explicitly asks for a class-wide decision rather than an incidental fix for
   grok alone. Codex on the developer image sits behind the same seccomp
   default and hits the same failure; treating it identically is the coherent
   answer.

4. **Preserve fail-loud posture.** Removing the sandbox flags must not
   introduce silent behavioural drift: the container's overall exit codes,
   log lines, and error messages continue to work as documented in
   `docs/design/agent-container-logs.md` and `docs/design/multi-provider-*.md`.

5. **Unblock the pipeline.** Issue [#357](https://github.com/mfrancza/agentic-development-workflow/issues/357)
   pipeline validation path 2 (Grok developer-image e2e) currently cannot
   pass; this design's implementation must bring path 2 to green.
   Issue [#236](https://github.com/mfrancza/agentic-development-workflow/issues/236)'s residual
   Codex sandbox blocker on the developer image is unblocked in the same change.

### Ambiguities and how they were resolved

- **Does "drop the sandbox" mean omit the flag or explicitly pass a no-op
  mode?** The two CLIs have different defaults, so the answer must be
  per-CLI:
  - **Grok Build CLI v1.0.13** — omitting `--sandbox` leaves the CLI in its
    default no-sandbox posture (verified by the reviewer image's `run_xai()`,
    which already omits the flag and runs end-to-end). Omit the flag.
  - **Codex CLI v0.146.0** — the `--sandbox` flag accepts `read-only`,
    `workspace-write`, and `danger-full-access`. Omitting it does not
    disable the sandbox; the CLI falls back to a policy-dependent default
    that still exercises the same namespace-creation code path. To match
    the grok posture (no in-container sandbox at all), the runner passes
    `--sandbox danger-full-access` explicitly. The name is deliberately
    alarming so a future maintainer sees it and understands the trade-off
    is intentional. See **Decision 4**.

- **Does the change apply to the reviewer image too?**
  - Reviewer `run_xai()` already omits `--sandbox`; nothing to change.
  - Reviewer `run_openai()` still passes `--sandbox workspace-write` — same
    latent failure as the developer image. The reviewer image's Codex path
    has not been shown to fail in the current pipeline (path 6 exercised
    xAI on the reviewer, not OpenAI), but the failure is guaranteed by the
    same seccomp default. The reviewer image gets the same Codex change
    for coherence and to pre-empt the failure. The reviewer's
    structural no-write guarantee is preserved by the token layer
    (Contents:read reviewer App token) and the image's lack of
    `git-askpass.sh` / push credentials — the sandbox flag was defence in
    depth, not the primary guarantee. See **Decision 3**.

- **Should the developer image keep `bubblewrap` installed as a hedge?**
  No. The package was added by Issue [#390](https://github.com/mfrancza/agentic-development-workflow/issues/390)
  solely because `run_xai()` passed `--sandbox workspace`; once that flag
  is dropped, the package is dead weight and the build-time `bwrap --version`
  check becomes misleading (it would succeed while the runtime path no
  longer uses `bwrap`). Remove both. If a future change needs to re-enable
  the inner sandbox, it will need a full posture-reversal design that also
  addresses the outer seccomp constraint — a Dockerfile install line is
  the cheapest part of that.

## Decisions

### Decision 1 — Adopt Option 2: the outer container is the trust boundary; do not rely on in-container CLI sandboxes for confinement

**Decision.** Ratify Option 2 from Issue [#396](https://github.com/mfrancza/agentic-development-workflow/issues/396).
The agent container's isolation — ephemeral lifetime, non-root `agent` user,
short-lived installation token scoped per action, no user credentials, no
outbound access to secrets stores — is the security boundary this repo
relies on. Inner CLI sandboxes (`bwrap`, Codex's namespace-backed sandbox)
are removed from the code path rather than enabled by weakening the outer
boundary.

**Why this option wins.**

- **Precedent inside the repo.** The reviewer image's `run_xai()` already
  omits `--sandbox` and passed end-to-end validation on
  Issue [#357](https://github.com/mfrancza/agentic-development-workflow/issues/357) pipeline path 6.
  The developer image mirroring that posture is a small delta, not an
  architectural pivot.
- **Alignment with the documented model.** `AGENTS.md` **Key Design Constraints**
  already treats the container as the isolation unit ("Agent containers
  must be isolated from user credentials"). `README.md`'s "Least-privilege,
  per-event isolation" bullet says the same. The single-boundary posture
  is what the rest of the system was designed around; adding an inner
  boundary was an incidental hedge from the Grok and OpenAI runner
  designs, not a load-bearing part of the trust model.
- **Cost asymmetry.** Option 1 weakens the outer boundary for **every**
  agent run (Anthropic, OpenAI, xAI — the outer seccomp change is
  provider-agnostic) to enable an inner boundary that only two of the
  three providers use, and only in some sandbox modes. Option 2 loses
  in-container defense-in-depth only on the two affected provider paths
  and only in the developer image; the reviewer image's structural
  no-write guarantee is unaffected.
- **Blast-radius argument.** The agent container's outbound reach is
  already scoped: the installation token has action-specific scopes, the
  workspace lives in an ephemeral filesystem torn down at container exit,
  and there are no user credentials to steal. A misbehaving CLI writing
  outside `/home/agent/work` inside the container can, at worst, corrupt
  its own working tree — the workspace is thrown away on exit and no
  persistent state escapes.
- **Explicit-decision requirement.** The issue asks for a ratified
  posture rather than an ad-hoc fix. A one-time architectural decision
  captured in a design doc (this one) plus an `AGENTS.md` bullet is what
  meets that bar; a silent `--sandbox` removal in an implementation PR
  would not.

**Alternatives considered.**

- **Option 1: grant `CLONE_NEWUSER` via `--security-opt seccomp=unconfined`
  or a custom permissive seccomp profile on the outer `docker run`.**
  Rejected. `seccomp=unconfined` is the sledgehammer form (drops the
  entire seccomp filter, not just the namespace-creation syscalls) and
  applies to every agent workflow that goes through the `run-agent`
  composite action. A narrow custom profile can be scoped to just
  `clone`/`unshare` bits, but still needs a Terraform-committed JSON file
  and a per-workflow security review, and it enables the inner sandbox
  for the two provider paths that need it while paying an outer-boundary
  audit cost for all providers. If a future need arises (e.g. running
  distinct untrusted agents inside one container, or executing arbitrary
  fetched code that the outer boundary would not catch), this design
  can be revisited with a targeted seccomp allowlist and the
  cost/benefit re-argued.
- **Hybrid: keep grok's `--sandbox workspace` in an "attempt then fall
  back" wrapper that catches the bwrap error and re-runs without the
  flag.** Rejected. Introduces silent-fallback behaviour that
  `AGENTS.md`'s **Fail-loud on ambiguous input** rule explicitly forbids;
  hides the underlying seccomp constraint from operators; masks
  regressions in the CLI's error reporting; and duplicates the run
  cost on every invocation.
- **Only fix grok now; punt Codex to a follow-up.** Rejected on the
  issue's own framing — the two failures are the same class and deserve
  the same decision, and leaving Codex broken re-litigates the same
  question a few days later.
- **Move the developer agent to a rootless-Docker or podman host to
  gain user-namespace support in the outer runner.** Rejected as
  out-of-scope; would require infrastructure changes to the GitHub
  Actions runner image, not to this repo.

### Decision 2 — Drop `--sandbox workspace` from the developer image's `run_xai()`; grok defaults to no-sandbox

**Decision.** In `docker/scripts/entrypoint.sh`, `run_xai()` changes from:

```bash
grok -p "$combined" \
    --model "$AGENT_MODEL" \
    --sandbox workspace \
    --always-approve \
    --max-turns "$AGENT_MAX_TURNS" \
    --no-auto-update
```

to:

```bash
grok -p "$combined" \
    --model "$AGENT_MODEL" \
    --always-approve \
    --max-turns "$AGENT_MAX_TURNS" \
    --no-auto-update
```

with a comment block that:
- Records why `--sandbox workspace` is intentionally omitted (namespace
  creation blocked by the outer seccomp default; posture ratified by
  Decision 1 of this document).
- Points at this design and at Decision 1's rationale so a future
  maintainer who wonders "should I add `--sandbox workspace` back?"
  finds the reasoning without having to git-blame their way there.
- Notes that the reviewer image's `run_xai()` already applies the same
  policy.

**Why omit the flag rather than pass an explicit no-op.** Grok Build CLI
v1.0.13's `--sandbox` accepts `workspace` and (per `grok --help`) has no
`none`/`off`/`danger-full-access`-style opt-out; omitting the flag is
the documented no-sandbox path. This matches the reviewer image
verbatim.

**Alternatives considered.**

- **Pass `--sandbox` with a "none" value.** Rejected — grok
  v1.0.13's flag surface does not expose such a value. If a future
  release adds one, updating the flag to be explicit is a one-line
  change captured in that release's rollout.

### Decision 3 — Apply the same posture to `run_openai()` on both images; use Codex's `--sandbox danger-full-access`

**Decision.** In both `docker/scripts/entrypoint.sh` and
`docker/reviewer/entrypoint.sh`, `run_openai()` changes from:

```bash
codex exec \
    --model "$AGENT_MODEL" \
    --sandbox workspace-write \
    -
```

to:

```bash
codex exec \
    --model "$AGENT_MODEL" \
    --sandbox danger-full-access \
    -
```

with a comment block explaining that the mode name reflects the
posture (no in-container sandbox), that the outer container is the
trust boundary per Decision 1 of this document, and — for the
reviewer image — that the structural no-write guarantee is still
enforced by the token layer (Contents:read reviewer App token) and
the image's lack of `git-askpass.sh` / push credentials.

**Why change both images together.** The developer image is the one
Issue [#396](https://github.com/mfrancza/agentic-development-workflow/issues/396)
directly names, and the one Issue [#236](https://github.com/mfrancza/agentic-development-workflow/issues/236)
observed the Codex failure on. The reviewer image's `run_openai()`
runs under the same seccomp default and is guaranteed to hit the
same failure on the next OpenAI-model review. Fixing both in one
PR keeps `docker/scripts/entrypoint.sh` and `docker/reviewer/entrypoint.sh`
in the "same shape" posture the multi-provider designs require, and
avoids leaving a known latent bug in the codebase.

**Why `danger-full-access` and not just omit `--sandbox`.** Codex
v0.146.0's default when `--sandbox` is omitted is not "no sandbox";
the CLI still exercises its namespace-creation code path with a
policy-dependent default. Passing the explicit
`danger-full-access` mode is Codex's documented "no in-container
sandbox" opt-out. The alarming name is a feature: a future maintainer
who sees it will search for why, find this design, and understand
the trade-off. Omitting the flag would produce silent behaviour that
depended on the pinned Codex version's defaults.

**Reviewer image's no-write guarantee is unaffected.** The reviewer
image never had `--sandbox workspace-write` as its primary write
guard; that role belongs to (a) the Contents:read scope on the
reviewer App token — Codex cannot push commits because the token
cannot — and (b) the image's structural omission of
`git-askpass.sh` and any `git commit`/`git push` code paths
(`docs/design/reviewer-container.md` Decision 3). The sandbox
flag was defence in depth on top of both. Removing it does not
touch either of the primary guards.

**Alternatives considered.**

- **Keep `--sandbox workspace-write` on the reviewer image because
  the reviewer Codex path has not been observed to fail.** Rejected.
  The same seccomp default applies; the failure is a matter of when,
  not whether. Fixing it once in the same PR as the developer change
  is cheaper than debugging the same failure on a fresh Codex-model
  review a few weeks from now, and keeps the developer/reviewer
  entrypoints in the "same shape" posture the multi-provider
  designs require.
- **Change only the developer image, leave the reviewer image for a
  follow-up issue.** Rejected on the same grounds as
  Decision 1's "only fix grok now, punt Codex" alternative.

### Decision 4 — Remove `bubblewrap` from `docker/Dockerfile` and the build-time `bwrap --version` check

**Decision.** In `docker/Dockerfile`:

- Remove `bubblewrap` from the `apt-get install` package list.
- Remove the `RUN bwrap --version` build-time smoke check.

`docker/reviewer/Dockerfile` does not install bubblewrap today and does
not need changes here.

**Why.** Both were added by Issue [#390](https://github.com/mfrancza/agentic-development-workflow/issues/390)
solely to support `run_xai()`'s `--sandbox workspace` flag. Once that
flag is removed (Decision 2), the package is dead weight and the
`bwrap --version` build-time check becomes actively misleading: it
verifies a runtime dependency the runtime no longer uses, so a future
image-build failure in that step would send maintainers on a wrong
diagnostic path.

**Alternatives considered.**

- **Keep the `bubblewrap` install as a hedge in case a future change
  re-enables `--sandbox workspace`.** Rejected. Re-enabling the inner
  sandbox is a posture-reversal that would require its own design
  (weighing the outer seccomp change against the reinstated inner
  boundary); at that point re-adding a Dockerfile line is the trivial
  part. Dead dependencies in images cause supply-chain surface expansion
  and reviewer confusion for no current benefit.
- **Keep the `bwrap --version` build-time check but remove the apt
  install (so the check fails loudly if a future PR accidentally adds
  `--sandbox workspace` back without also reinstalling bubblewrap).**
  Rejected. The failure would surface at image build time, but the
  correct diagnostic is "the posture decision was reversed without a
  design change" — a `bwrap --version` failure does not communicate that.
  A better guard, if wanted, is a comment in `run_xai()` (Decision 2)
  linking to this design.

### Decision 5 — Codify the posture in `AGENTS.md`; add amendment notes to the two affected prior designs

**Decision.**

- **`AGENTS.md` **Key Design Constraints** bullet.** Add exactly one new
  bullet, phrased to merge cleanly per the doc's "merge-friendly
  documentation" rules:

  > *The outer agent container is the trust boundary. In-container CLI
  > sandboxes (`bwrap`, Codex's namespace-backed sandbox) are not
  > relied on for confinement; the developer and reviewer entrypoints
  > deliberately do not enable them. See
  > [`docs/design/inner-sandbox-posture.md`](docs/design/inner-sandbox-posture.md)
  > (Issue [#396](https://github.com/mfrancza/agentic-development-workflow/issues/396))
  > for the ratified decision.*

  Placement: appended to the existing **Key Design Constraints** list,
  after the last bullet, so the list remains stable for concurrent
  editors.

- **`docs/design/grok-developer-image-entrypoint.md`** — add a top-of-file
  amendment note in the same style the doc already uses for its
  [#353](https://github.com/mfrancza/agentic-development-workflow/issues/353) amendment:

  > *Amended (Issue [#396](https://github.com/mfrancza/agentic-development-workflow/issues/396)):*
  > *the developer image's `run_xai()` no longer passes `--sandbox workspace`.*
  > *See [`inner-sandbox-posture.md`](inner-sandbox-posture.md) for the*
  > *ratified inner-sandbox posture.*

- **`docs/design/multi-provider-openai-runner.md`** — same treatment:

  > *Amended (Issue [#396](https://github.com/mfrancza/agentic-development-workflow/issues/396)):*
  > *`run_openai()` passes `--sandbox danger-full-access` instead of*
  > *`--sandbox workspace-write` on both images. See*
  > *[`inner-sandbox-posture.md`](inner-sandbox-posture.md) for the ratified*
  > *inner-sandbox posture.*

- **`docs/design/grok-build-cli.md`** does not need an amendment note —
  its Decision 3 already documents the reviewer image's no-`--sandbox`
  posture, which this design does not change. The developer-image
  Decision 3 does describe the `--sandbox workspace` flag, but that
  design is already superseded for other reasons and its amendment
  chain already points readers at newer docs.

**Why one central design doc plus amendment notes rather than editing
the original designs.** The two prior designs are the historical
record of decisions made at their time; editing them in place would
obscure the design history. The amendment-note pattern is what the
repo already uses (`grok-models.md`, `grok-developer-image-entrypoint.md`,
and others carry the same style of note), and a reader who lands on an
old design gets pointed at the current one without the old doc losing
its provenance.

### Decision 6 — Do not change `.github/actions/run-agent/action.yml`

**Decision.** No changes to the outer `docker run` invocation. In
particular, this design does **not** add `--security-opt seccomp=unconfined`,
a custom seccomp profile, `--cap-add`, or `--privileged`.

**Why call this out explicitly.** The issue framed Option 1 as an
`.github/actions/run-agent/action.yml` change. Making it visible in the
design that the file is deliberately untouched — and that any future PR
that adds security-loosening flags to it would be a posture-reversal
requiring a fresh design — prevents an "incidental fix" from silently
inverting Decision 1 later.

## Out of scope

- **Any change to the outer `docker run` seccomp / capability posture.**
  Explicitly (Decision 6). Any future proposal to grant user-namespace
  creation to the container is a posture reversal and needs its own
  design.
- **Alternative in-container sandboxing mechanisms** — running CLIs under
  `firejail`, `nsjail`, `landlock-restrict`, chroots, or per-CLI seccomp
  policies. None of these solve the observed failure without
  weakening the outer boundary, and adding any of them is a
  posture reversal (see above).
- **Rootless-Docker or podman migration** on the GitHub Actions runner
  side to gain user-namespace support in the outer runtime. Repo-level
  change; not addressable by this design.
- **The reviewer image's Codex sandbox observability** — whether the
  reviewer's `run_openai()` has ever fired in production is not
  audited here; Decision 3 pre-empts the failure regardless.
- **Anthropic runner (`run_anthropic()`) changes.** Claude Code's
  `--dangerously-skip-permissions` is orthogonal to `bwrap`/Codex
  sandboxes and does not exercise the failing code path. No change.
- **Prompt-level guardrails** to compensate for the lost defence-in-depth
  (e.g. instructing the agent not to write outside the workspace).
  Explicitly not the plan — the trust boundary is the container, not
  the model's cooperation. Prompt tweaks live in their own change
  stream if wanted.
- **Terraform / branch-protection / label surface.** Untouched.
- **Reviewer image's `Dockerfile`.** No changes; the reviewer image
  does not install bubblewrap today, and its `run_xai()` is already at
  the target posture.
- **Any documentation change in generated regions of `AGENTS.md`/`README.md`.**
  Decision 5's edit lands in the free-prose **Key Design Constraints**
  section, not inside a `<!-- generated:*:start -->` region, and no
  source file for a generated section changes, so
  `scripts/generate-docs.sh` does not need to run.
- **End-to-end validation of Anthropic and reviewer-image paths beyond
  a regression smoke test.** The validation sub-issue exercises the
  affected paths (developer grok, developer Codex, reviewer Codex) plus
  a regression check on the developer Anthropic path; broader
  cross-provider regression sweeps stay in scope of
  Issue [#357](https://github.com/mfrancza/agentic-development-workflow/issues/357).

## Task breakdown

Two sub-issues. Task A is a single atomic PR touching the developer entrypoint,
the reviewer entrypoint (Codex arm only), the developer Dockerfile, and the
three documentation call-sites. Task B is the end-to-end validation that
Issue [#357](https://github.com/mfrancza/agentic-development-workflow/issues/357)
path 2 requires; it depends on task A landing.

| Issue | Task | Depends on |
|-------|------|------------|
| Issue [#404](https://github.com/mfrancza/agentic-development-workflow/issues/404) | Implement inner-sandbox-drop across entrypoints, Dockerfile, and docs. `docker/scripts/entrypoint.sh`: remove `--sandbox workspace` from `run_xai()` and add the comment block per Decision 2; switch `run_openai()`'s `--sandbox workspace-write` to `--sandbox danger-full-access` and add the comment block per Decision 3. `docker/reviewer/entrypoint.sh`: apply the same `run_openai()` `--sandbox danger-full-access` change per Decision 3 (reviewer `run_xai()` is already at target posture — no change). `docker/Dockerfile`: remove `bubblewrap` from the apt package list and remove the `RUN bwrap --version` build-time check per Decision 4. `AGENTS.md`: append the new **Key Design Constraints** bullet per Decision 5. `docs/design/grok-developer-image-entrypoint.md` and `docs/design/multi-provider-openai-runner.md`: add top-of-file amendment notes per Decision 5. Verify locally that `docker build` succeeds for the developer image without bubblewrap and that `grok --help` / `codex --help` still resolve inside the built image; record the verified invocations in the PR description. | — |
| Issue [#406](https://github.com/mfrancza/agentic-development-workflow/issues/406) | End-to-end validation via `docker run`. With `XAI_API_KEY`, `OPENAI_API_KEY`, and `ANTHROPIC_API_KEY` provisioned out of band: (1) developer container, `AGENT_MODEL=<grok-name>`, on a fixture issue — the `groom` action completes end-to-end via the Grok Build CLI path and the container log shows a `grok -p` call with **no** `--sandbox` flag and no `bwrap: No permissions…` error; (2) developer container, `AGENT_MODEL=<openai-name>`, same fixture issue — completes end-to-end via the Codex path and the container log shows `--sandbox danger-full-access` and no user-namespace / seccomp errors; (3) developer container, `AGENT_MODEL=sonnet`, same fixture issue — routes to `run_anthropic` unchanged (regression check); (4) reviewer container, `AGENT_MODEL=<openai-name>` on a live PR — completes end-to-end via the Codex path with the new `--sandbox danger-full-access` and posts a review; (5) `docker build` for both images completes without a bubblewrap dependency. Record each invocation + relevant log excerpt in the PR description. Close out Issue [#357](https://github.com/mfrancza/agentic-development-workflow/issues/357) pipeline path 2 in the PR body once the grok e2e is green. | Issue [#404](https://github.com/mfrancza/agentic-development-workflow/issues/404) |

Dependencies are recorded natively as GitHub blocked-by relationships on the issues.

## Notes for the reviewer of this design

- The `human-required` label on Issue [#396](https://github.com/mfrancza/agentic-development-workflow/issues/396)
  is set because this is a security-posture decision that should not be made
  unilaterally by an agent. This design ratifies Option 2 with a full rationale
  so the human reviewer can accept or override it; the PR that carries this
  design should also carry the `human-required` label until the posture is
  explicitly acknowledged by a human review of the design PR.
- Sub-issues stay labeled `draft` until this design PR merges — the standard
  designer-agent flow. `agent-design.yml`'s `undraft-sub-issues` job will
  remove the label on merge.

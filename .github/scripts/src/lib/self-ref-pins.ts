/**
 * Shared self-referencing workflow pin regex.
 *
 * Two consumers keep this in one place so the rewriter and the verifier
 * cannot drift from each other (Decision 2 in docs/design/release-self-pin-worker.md):
 *
 *   - test/pinned-worker-contracts.test.ts  validates that every pinned self-ref
 *     matches the declared contract at the pinned tag.
 *   - src/rewrite-self-ref-pins.ts  rewrites @<ref> to @<target-version>
 *     at release time.
 *
 * Pattern matches the following on a non-comment YAML line:
 *   uses: mfrancza/agentic-development-workflow/.github/workflows/<file>@<ref>
 *
 * Capture group 1: worker filename (e.g. "agent-review-worker-reusable.yml")
 * Capture group 2: ref (e.g. "v0.3.0")
 */
export const PINNED_SELF_REF_RE =
  /uses:\s+mfrancza\/agentic-development-workflow\/\.github\/workflows\/([\w.-]+\.ya?ml)@(\S+)/;

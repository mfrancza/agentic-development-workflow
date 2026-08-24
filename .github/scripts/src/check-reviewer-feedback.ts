import * as core from "@actions/core";
import { getOctokit } from "./lib/octokit.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Inputs that drive the skip/proceed decision. */
export interface FeedbackCheckInput {
  /** Value of `github.event.review.state` (e.g. "approved", "changes_requested"). */
  state: string;
  /** Value of `github.event.review.body` — may be empty string. */
  body: string;
  /** Numeric review ID from the event payload. */
  reviewId: number;
  /** PR number the review was submitted on. */
  prNumber: number;
  /** Repository owner login. */
  owner: string;
  /** Repository name. */
  repo: string;
}

/**
 * Injected API callbacks used by the pure logic function.
 * Each callback throws on error so the caller can apply the correct
 * fail-open / fall-through policy.
 */
export interface FeedbackCheckDeps {
  /** Returns the total number of unresolved PR review threads. Throws on error. */
  countUnresolvedThreads(): Promise<number>;
  /**
   * Returns the number of inline comments on the specific review. Throws on
   * error so the caller can fail open (proceed) rather than silently suppress.
   */
  countInlineComments(): Promise<number>;
}

/** Decision result from {@link checkReviewerFeedback}. */
export interface FeedbackCheckResult {
  /** Whether the workflow should proceed (true) or skip (false). */
  proceed: boolean;
  /** Human-readable explanation of the decision for workflow logs. */
  reason: string;
}

// ---------------------------------------------------------------------------
// Pure logic
// ---------------------------------------------------------------------------

/**
 * Determines whether the `agent-respond-review` workflow should proceed or
 * skip, replicating the ~85-line inline shell script in agent-respond-review.yml.
 *
 * Decision flow:
 *  1. Non-approval reviews always proceed (changes_requested, commented, …).
 *  2. Approved review — primary check: count unresolved PR review threads via
 *     GraphQL. Zero threads → skip; non-zero → proceed. On error, fall through.
 *  3. Approved review — bare-approval fallback (only reached when step 2 errored):
 *       - No body text AND inline comment count is zero and confirmed → skip.
 *       - Body present, inline count > 0, or inline count unknown → proceed.
 *     Inline-comment API errors fail open (proceed) to avoid silently suppressing
 *     a response.
 */
export async function checkReviewerFeedback(
  input: FeedbackCheckInput,
  deps: FeedbackCheckDeps,
): Promise<FeedbackCheckResult> {
  const { state, body } = input;

  // --- Step 1: non-approval states always proceed ---
  if (state.toLowerCase() !== "approved") {
    return {
      proceed: true,
      reason: `Review state is '${state}'; proceeding.`,
    };
  }

  // --- Step 2: primary check — unresolved thread count via GraphQL ---
  let unresolvedCount: number | undefined;
  try {
    unresolvedCount = await deps.countUnresolvedThreads();
  } catch (err) {
    core.warning(
      `Failed to fetch unresolved thread count: ${err instanceof Error ? err.message : String(err)}`,
    );
    // Fall through to the bare-approval fallback below.
  }

  if (unresolvedCount !== undefined) {
    if (unresolvedCount === 0) {
      return {
        proceed: false,
        reason:
          "Approval with zero unresolved threads; skipping respond-review.",
      };
    }
    return {
      proceed: true,
      reason: `Approval with ${unresolvedCount} unresolved thread(s); proceeding.`,
    };
  }

  core.info(
    "Unresolved thread count is non-numeric or unavailable; falling through to bare-approval check.",
  );

  // --- Step 3: bare-approval fallback ---

  // Check whether the review body carries any non-whitespace content.
  const hasBody = body.replace(/\s/g, "").length > 0;

  // Fetch inline comment count; fail open on any error.
  let inlineCount: number | undefined;
  try {
    inlineCount = await deps.countInlineComments();
  } catch (err) {
    core.warning(
      `Failed to fetch inline comments; treating inline count as unknown: ${err instanceof Error ? err.message : String(err)}`,
    );
    // inlineCount stays undefined — fail open below.
  }

  const hasInline = inlineCount !== undefined && inlineCount > 0;

  // Bare approval: provably nothing to respond to — skip.
  if (!hasBody && !hasInline && inlineCount !== undefined) {
    return {
      proceed: false,
      reason:
        "Approval with no body and no inline comments; skipping respond-review.",
    };
  }

  // Proceed — determine which condition triggered it for the log message.
  let reason: string;
  if (hasBody) {
    reason =
      "Approval carries a non-empty review body; thread count unavailable; proceeding.";
  } else if (hasInline) {
    reason = `Approval carries ${inlineCount} inline comment(s); thread count unavailable; proceeding.`;
  } else {
    // inlineCount is undefined (API error) — fail open.
    reason =
      "Approval with unknown inline count and unavailable thread count; proceeding.";
  }
  return { proceed: true, reason };
}

// ---------------------------------------------------------------------------
// API helpers (wired up in the entry point; injectable in tests)
// ---------------------------------------------------------------------------

interface ReviewThreadsPage {
  repository: {
    pullRequest: {
      reviewThreads: {
        nodes: Array<{ isResolved: boolean }>;
        pageInfo: {
          hasNextPage: boolean;
          endCursor: string | null;
        };
      };
    };
  };
}

type OctokitClient = ReturnType<typeof getOctokit>;

/**
 * Returns a callback that paginates the GraphQL `reviewThreads` connection and
 * sums the unresolved count across all pages.
 */
export function makeUnresolvedThreadCounter(
  octokit: OctokitClient,
  owner: string,
  repo: string,
  prNumber: number,
): () => Promise<number> {
  return async () => {
    let unresolvedCount = 0;
    let endCursor: string | null = null;
    let hasNextPage = true;

    while (hasNextPage) {
      // eslint-disable-next-line no-await-in-loop
      const result: ReviewThreadsPage = await octokit.graphql<ReviewThreadsPage>(
        `
          query($owner: String!, $name: String!, $number: Int!, $endCursor: String) {
            repository(owner: $owner, name: $name) {
              pullRequest(number: $number) {
                reviewThreads(first: 100, after: $endCursor) {
                  nodes { isResolved }
                  pageInfo { hasNextPage endCursor }
                }
              }
            }
          }
        `,
        { owner, name: repo, number: prNumber, endCursor },
      );

      const threads: ReviewThreadsPage["repository"]["pullRequest"]["reviewThreads"] =
        result.repository.pullRequest.reviewThreads;
      unresolvedCount += threads.nodes.filter(
        (n: { isResolved: boolean }) => !n.isResolved,
      ).length;
      hasNextPage = threads.pageInfo.hasNextPage;
      endCursor = threads.pageInfo.endCursor;
    }

    return unresolvedCount;
  };
}

/**
 * Returns a callback that paginates the REST review-comments endpoint and
 * returns the total inline comment count for the given review.
 */
export function makeInlineCommentCounter(
  octokit: OctokitClient,
  owner: string,
  repo: string,
  prNumber: number,
  reviewId: number,
): () => Promise<number> {
  return async () => {
    const comments = await octokit.paginate(
      octokit.rest.pulls.listCommentsForReview,
      {
        owner,
        repo,
        pull_number: prNumber,
        review_id: reviewId,
        per_page: 100,
      },
    );
    return comments.length;
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  const token = core.getInput("token", { required: true });
  const state = core.getInput("review_state", { required: true });
  const body = core.getInput("review_body");
  const reviewId = parseInt(core.getInput("review_id", { required: true }), 10);
  const prNumber = parseInt(core.getInput("pr_number", { required: true }), 10);
  const owner = core.getInput("repo_owner", { required: true });
  const repo = core.getInput("repo_name", { required: true });

  const octokit = getOctokit(token);

  const result = await checkReviewerFeedback(
    { state, body, reviewId, prNumber, owner, repo },
    {
      countUnresolvedThreads: makeUnresolvedThreadCounter(
        octokit,
        owner,
        repo,
        prNumber,
      ),
      countInlineComments: makeInlineCommentCounter(
        octokit,
        owner,
        repo,
        prNumber,
        reviewId,
      ),
    },
  );

  core.info(result.reason);
  core.setOutput("proceed", String(result.proceed));
}

run().catch((err: unknown) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});

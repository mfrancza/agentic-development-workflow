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
  /** GitHub login of the review author (github.event.review.user.login). */
  reviewAuthor: string;
  /** GitHub login of the PR author (github.event.pull_request.user.login). */
  prAuthor: string;
}

/**
 * Injected API callbacks used by the pure logic function.
 * Each callback throws on error so the caller can apply the correct
 * fail-open / fall-through policy.
 */
export interface FeedbackCheckDeps {
  /**
   * Returns the current PR state string (e.g. "open", "closed"). Throws on
   * error so the caller can apply fail-open policy.
   */
  getPrState(): Promise<string>;
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
 * skip, applying defence-in-depth guards to close the respond-review self-trigger
 * loop at the activity layer.
 *
 * Decision flow:
 *  0. PR is not open (closed or merged) — skip immediately; a review on a
 *     closed/merged PR never needs a response. On API error, fail open and
 *     continue to the feedback checks.
 *  1. Review author equals PR author — skip unconditionally (defence in depth;
 *     the PR author's own reviews require no response regardless of state).
 *  2. Non-approval, non-commented states (changes_requested, dismissed, …) —
 *     always proceed.
 *  3. Commented or approved review — count unresolved PR review threads via
 *     GraphQL. Zero threads → skip; non-zero → proceed. On error:
 *       - commented: fail open (proceed) immediately — no bare-approval fallback.
 *       - approved: fall through to the bare-approval fallback (step 4).
 *  4. Approved review — bare-approval fallback (only reached when step 3 errored):
 *       - No body text AND inline comment count is zero and confirmed → skip.
 *       - Body present, inline count > 0, or inline count unknown → proceed.
 *     Inline-comment API errors fail open (proceed) to avoid silently suppressing
 *     a response.
 */
export async function checkReviewerFeedback(
  input: FeedbackCheckInput,
  deps: FeedbackCheckDeps,
): Promise<FeedbackCheckResult> {
  const { state, body, reviewAuthor, prAuthor } = input;

  // --- Step 0: skip if PR is no longer open (closed or merged) ---
  let prState: string | undefined;
  try {
    prState = await deps.getPrState();
  } catch (err) {
    core.warning(
      `Failed to fetch PR state: ${err instanceof Error ? err.message : String(err)}; proceeding.`,
    );
  }
  if (prState !== undefined && prState !== "open") {
    return {
      proceed: false,
      reason: `PR is '${prState}'; skipping respond-review — a review on a closed or merged PR needs no response.`,
    };
  }

  // --- Step 1: skip if the review was authored by the PR author (defence in depth) ---
  if (reviewAuthor === prAuthor) {
    return {
      proceed: false,
      reason: `Review author '${reviewAuthor}' is the same as PR author '${prAuthor}'; skipping respond-review — self-authored reviews require no response.`,
    };
  }

  const stateLower = state.toLowerCase();

  // --- Step 2: non-approval, non-commented states always proceed ---
  if (stateLower !== "approved" && stateLower !== "commented") {
    return {
      proceed: true,
      reason: `Review state is '${state}'; proceeding.`,
    };
  }

  // --- Step 3: primary check — unresolved thread count via GraphQL ---
  // Applies to both 'approved' and 'commented' reviews.
  let unresolvedCount: number | undefined;
  try {
    unresolvedCount = await deps.countUnresolvedThreads();
  } catch (err) {
    core.warning(
      `Failed to fetch unresolved thread count: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (unresolvedCount !== undefined) {
    if (unresolvedCount === 0) {
      return {
        proceed: false,
        reason:
          stateLower === "commented"
            ? "Commented review with zero unresolved threads; skipping respond-review."
            : "Approval with zero unresolved threads; skipping respond-review.",
      };
    }
    return {
      proceed: true,
      reason:
        stateLower === "commented"
          ? `Commented review with ${unresolvedCount} unresolved thread(s); proceeding.`
          : `Approval with ${unresolvedCount} unresolved thread(s); proceeding.`,
    };
  }

  // Thread count is unavailable (GraphQL error or unexpected undefined).
  if (stateLower === "commented") {
    // Fail open for 'commented' — no bare-approval fallback.
    return {
      proceed: true,
      reason:
        "Commented review; unresolved thread count unavailable; proceeding.",
    };
  }

  // Only reached for 'approved' with an unavailable thread count.
  core.info(
    "Unresolved thread count is non-numeric or unavailable; falling through to bare-approval check.",
  );

  // --- Step 4: bare-approval fallback (approved only) ---

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
 * Returns a callback that fetches the current PR state string (e.g. "open",
 * "closed") from the REST API. GitHub reports merged PRs as `state: "closed"`.
 */
export function makePrStateGetter(
  octokit: OctokitClient,
  owner: string,
  repo: string,
  prNumber: number,
): () => Promise<string> {
  return async () => {
    const { data } = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    });
    return data.state;
  };
}

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
  const reviewAuthor = core.getInput("review_author", { required: true });
  const prAuthor = core.getInput("pr_author", { required: true });

  const octokit = getOctokit(token);

  const result = await checkReviewerFeedback(
    { state, body, reviewId, prNumber, owner, repo, reviewAuthor, prAuthor },
    {
      getPrState: makePrStateGetter(octokit, owner, repo, prNumber),
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

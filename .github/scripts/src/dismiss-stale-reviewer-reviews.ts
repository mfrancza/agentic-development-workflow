import * as core from "@actions/core";
import { getOctokit } from "./lib/octokit.js";

type OctokitType = ReturnType<typeof getOctokit>;

export interface ReviewSummary {
  id: number;
  userLogin: string | null;
  state: string;
}

export interface DismissResult {
  dismissed: number[];
  failed: number[];
}

/**
 * Fetches the login of the authenticated user (the reviewer bot) by issuing a
 * viewer.login GraphQL query with the reviewer-app token.
 *
 * Returns null and logs a warning if the query fails — the caller should treat
 * null as "skip all dismissals" (fail-open per Decision 5 of
 * docs/design/reviewer-supersede-stale-verdict.md).
 */
export async function fetchBotLogin(
  octokit: OctokitType
): Promise<string | null> {
  try {
    const result = await octokit.graphql<{ viewer: { login: string } }>(
      `query { viewer { login } }`
    );
    return result.viewer.login;
  } catch (err) {
    core.warning(
      `Could not determine reviewer bot login via viewer.login: ${
        err instanceof Error ? err.message : String(err)
      }. Skipping stale-review dismissal.`
    );
    return null;
  }
}

/**
 * Paginates through all reviews on the PR using page-based REST pagination
 * (100 reviews per page) and returns a minimal summary of each.
 *
 * Returns an empty array and logs a warning if the API call fails, mirroring
 * the fail-open pattern of fetchBotLogin.
 */
export async function fetchAllReviews(
  octokit: OctokitType,
  owner: string,
  repo: string,
  prNumber: number
): Promise<ReviewSummary[]> {
  const all: ReviewSummary[] = [];
  let page = 1;
  const perPage = 100;

  try {
    while (true) {
      const { data } = await octokit.rest.pulls.listReviews({
        owner,
        repo,
        pull_number: prNumber,
        per_page: perPage,
        page,
      });

      for (const r of data) {
        all.push({
          id: r.id,
          userLogin: r.user?.login ?? null,
          state: r.state,
        });
      }

      // Fewer than a full page means this was the last page.
      if (data.length < perPage) break;
      page++;
    }
  } catch (err) {
    core.warning(
      `Could not fetch reviews for PR #${prNumber}: ${
        err instanceof Error ? err.message : String(err)
      }. Skipping stale-review dismissal.`
    );
    return [];
  }

  return all;
}

/**
 * Pure filter: returns only reviews authored by the reviewer bot that have
 * state CHANGES_REQUESTED.
 *
 * DISMISSED reviews are already in the target state and are intentionally
 * skipped. APPROVED and COMMENTED reviews carry no blocking verdict.
 */
export function filterStaleReviews(
  reviews: ReviewSummary[],
  botLogin: string
): ReviewSummary[] {
  return reviews.filter(
    (r) => r.userLogin === botLogin && r.state === "CHANGES_REQUESTED"
  );
}

/**
 * Dismisses each stale review by calling the GitHub REST dismissal endpoint.
 * Fail-open: an error on one dismissal is logged as a warning and the
 * remaining reviews are still attempted. The DismissResult accumulates the
 * IDs of dismissed and failed reviews for the caller's log summary.
 */
export async function dismissReviews(
  octokit: OctokitType,
  owner: string,
  repo: string,
  prNumber: number,
  reviews: ReviewSummary[]
): Promise<DismissResult> {
  const result: DismissResult = { dismissed: [], failed: [] };

  for (const review of reviews) {
    try {
      await octokit.rest.pulls.dismissReview({
        owner,
        repo,
        pull_number: prNumber,
        review_id: review.id,
        message: "Superseded by re-review from this bot.",
      });
      console.log(
        `Dismissed review ${review.id} (CHANGES_REQUESTED by ${review.userLogin}).`
      );
      result.dismissed.push(review.id);
    } catch (err) {
      core.warning(
        `Failed to dismiss review ${review.id}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      result.failed.push(review.id);
    }
  }

  return result;
}

async function run(): Promise<void> {
  const token = core.getInput("token", { required: true });
  // The composite action declares the input as "pr-number" (hyphen) and
  // bridges it to the env var INPUT_PR_NUMBER (underscore) explicitly.
  // @actions/core maps getInput(name) to process.env["INPUT_" + name with
  // spaces→underscores]; hyphens are NOT converted, so getInput("pr-number")
  // would look for INPUT_PR-NUMBER and miss the env var. Using "pr_number"
  // here matches the explicit INPUT_PR_NUMBER env var set by the action.
  const prNumberStr = core.getInput("pr_number", { required: true });
  const repo = core.getInput("repo", { required: true });

  const prNumber = parseInt(prNumberStr, 10);
  if (isNaN(prNumber)) {
    core.warning(
      `dismiss-stale-reviewer-reviews: pr_number "${prNumberStr}" is not a valid integer. Skipping stale-review dismissal.`
    );
    return;
  }
  const [owner, repoName] = repo.split("/");
  const octokit = getOctokit(token);

  const botLogin = await fetchBotLogin(octokit);
  if (botLogin === null) {
    // fetchBotLogin already emitted a warning; skip all dismissals.
    return;
  }

  const allReviews = await fetchAllReviews(octokit, owner, repoName, prNumber);
  const stale = filterStaleReviews(allReviews, botLogin);

  if (stale.length === 0) {
    console.log("No stale CHANGES_REQUESTED reviews to dismiss.");
    return;
  }

  const result = await dismissReviews(
    octokit,
    owner,
    repoName,
    prNumber,
    stale
  );
  console.log(
    `Dismissed ${result.dismissed.length} stale review(s); ${result.failed.length} failed (fail-open).`
  );
}

// Top-level fail-open: unexpected errors from run() are warnings rather than
// step failures. The dismissal step is defence-in-depth; skipping it never
// breaks the review pass (Decision 2 of reviewer-supersede-stale-verdict.md).
run().catch((err: unknown) => {
  core.warning(
    `dismiss-stale-reviewer-reviews: unexpected error: ${
      err instanceof Error ? err.message : String(err)
    }`
  );
});

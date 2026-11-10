import * as core from "@actions/core";
import { checkReviewerFeedback, makePrStateGetter, makeUnresolvedThreadCounter, makeInlineCommentCounter } from "./lib/check-reviewer-feedback.js";
import { getOctokit } from "./lib/octokit.js";

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
  const headSha = core.getInput("head_sha");
  const reviewCommitId = core.getInput("review_commit_id");

  const octokit = getOctokit(token);

  const result = await checkReviewerFeedback(
    { state, body, reviewId, prNumber, owner, repo, reviewAuthor, prAuthor, headSha, reviewCommitId },
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

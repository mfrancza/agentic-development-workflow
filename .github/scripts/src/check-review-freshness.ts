import * as core from "@actions/core";
import { fileURLToPath } from "node:url";
import { getOctokit } from "./lib/octokit.js";

export async function checkReviewFreshness(
  input: { prNumber: number; reviewId: number; author: string; reviewCommitId: string },
  getHead: () => Promise<string | undefined>,
): Promise<{ proceed: boolean; reason: string }> {
  if (input.author.toLowerCase() !== "mfrancza-reviewer-agent[bot]") {
    return { proceed: true, reason: `Review by ${input.author} is outside the bot freshness check; proceeding.` };
  }
  const reviewed = input.reviewCommitId.trim();
  if (!reviewed) {
    core.warning("Review commit ID is blank; freshness cannot be established; proceeding.");
    return { proceed: true, reason: "Missing reviewed SHA; proceeding." };
  }
  let head: string | undefined;
  try {
    head = (await getHead())?.trim();
  } catch (error) {
    core.warning(`Failed to fetch live PR head: ${String(error)}; proceeding.`);
    return { proceed: true, reason: "Live head lookup failed; proceeding." };
  }
  if (!head) {
    core.warning("Live PR head is blank; freshness cannot be established; proceeding.");
    return { proceed: true, reason: "Missing live head SHA; proceeding." };
  }
  if (reviewed !== head) {
    return { proceed: false, reason: `Stale bot review skipped after lock acquisition: PR #${input.prNumber}, review ${input.reviewId}, author ${input.author}, reviewed SHA ${reviewed}, live SHA ${head}.` };
  }
  return { proceed: true, reason: `Bot review ${input.reviewId} matches live PR head; proceeding.` };
}

async function run(): Promise<void> {
  const token = core.getInput("token", { required: true });
  const owner = core.getInput("repo_owner", { required: true });
  const repo = core.getInput("repo_name", { required: true });
  const prNumber = Number(core.getInput("pr_number", { required: true }));
  const reviewId = Number(core.getInput("review_id", { required: true }));
  const author = core.getInput("review_author", { required: true });
  const reviewCommitId = core.getInput("review_commit_id");
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0 || !Number.isSafeInteger(reviewId) || reviewId <= 0) throw new Error("PR number and review ID must be positive safe integers");
  const octokit = getOctokit(token);
  const result = await checkReviewFreshness({ prNumber, reviewId, author, reviewCommitId }, async () => (await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber })).data.head?.sha);
  core.info(result.reason);
  core.setOutput("proceed", String(result.proceed));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  run().catch((error: unknown) => core.setFailed(error instanceof Error ? error.message : String(error)));
}

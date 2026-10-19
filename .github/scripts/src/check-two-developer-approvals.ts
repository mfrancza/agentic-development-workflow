import * as core from "@actions/core";
import * as github from "@actions/github";

const CHECK_NAME = "require-two-developer-approvals / check";
const OPINIONATED_STATES = new Set([
  "APPROVED",
  "CHANGES_REQUESTED",
  "DISMISSED",
]);

type Octokit = ReturnType<typeof github.getOctokit>;

export interface Review {
  userLogin: string | null;
  state: string;
}

export interface ApprovalResult {
  conclusion: "success" | "failure";
  summary: string;
}

/**
 * Applies GitHub's latest-opinionated-review semantics and counts approvals
 * from reviewers other than the pull request author.
 */
export function evaluateApprovals(
  reviews: Review[],
  prAuthor: string,
  requiredApprovals: number = 2
): ApprovalResult {
  const latestByReviewer = new Map<string, string>();

  for (const review of reviews) {
    if (review.userLogin !== null && OPINIONATED_STATES.has(review.state)) {
      latestByReviewer.set(review.userLogin, review.state);
    }
  }

  const approvals = [...latestByReviewer].filter(
    ([reviewer, state]) => reviewer !== prAuthor && state === "APPROVED"
  ).length;
  const conclusion = approvals >= requiredApprovals ? "success" : "failure";

  return {
    conclusion,
    summary:
      conclusion === "success"
        ? `Pull request has ${approvals} qualifying approval(s); ${requiredApprovals} required.`
        : `Pull request has ${approvals} qualifying approval(s); ${requiredApprovals} required before it can merge.`,
  };
}

/** Fetch every review, preserving the API's chronological order. */
export async function fetchReviews(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number
): Promise<Review[]> {
  const reviews: Review[] = [];
  let page = 1;

  while (true) {
    const { data } = await octokit.rest.pulls.listReviews({
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
      page,
    });

    reviews.push(
      ...data.map((review) => ({
        userLogin: review.user?.login ?? null,
        state: review.state,
      }))
    );

    if (data.length < 100) return reviews;
    page += 1;
  }
}

function splitRepository(repository: string): [string, string] {
  const [owner, repo, ...rest] = repository.split("/");
  if (!owner || !repo || rest.length > 0) {
    throw new Error(`Invalid repo format: "${repository}". Expected "owner/name".`);
  }
  return [owner, repo];
}

async function publishResult(
  octokit: Octokit,
  owner: string,
  repo: string,
  headSha: string,
  result: ApprovalResult
): Promise<void> {
  await octokit.rest.checks.create({
    owner,
    repo,
    name: CHECK_NAME,
    head_sha: headSha,
    status: "completed",
    conclusion: result.conclusion,
    output: {
      title: CHECK_NAME,
      summary: result.summary,
    },
  });
}

export async function run(): Promise<void> {
  // Composite-action inputs with hyphens are bridged to underscore-named
  // INPUT_* variables; see the activity-input-plumbing CI check.
  const developerBotLogin = core.getInput("developer_bot_login").trim();
  const enabled = core.getInput("require_two_developer_approvals").trim() === "true";
  const prNumber = Number.parseInt(core.getInput("pr_number", { required: true }), 10);
  const prAuthor = core.getInput("pr_author", { required: true });
  const headSha = core.getInput("head_sha", { required: true });
  const [owner, repo] = splitRepository(core.getInput("repo", { required: true }));
  const token = process.env.GITHUB_TOKEN;

  if (!token) {
    throw new Error("GITHUB_TOKEN is required to list reviews and publish the check run.");
  }
  if (!Number.isSafeInteger(prNumber) || prNumber < 1) {
    throw new Error("pr-number must be a positive integer.");
  }

  const octokit = github.getOctokit(token);
  let result: ApprovalResult;

  if (!enabled) {
    result = {
      conclusion: "success",
      summary: "Two-developer-approvals requirement is disabled.",
    };
  } else if (!developerBotLogin) {
    const message = "developer-bot-login must be configured when require-two-developer-approvals is true.";
    core.error(message);
    result = { conclusion: "failure", summary: message };
  } else if (prAuthor !== developerBotLogin) {
    result = {
      conclusion: "success",
      summary: `Pull request author ${prAuthor} is not the configured developer bot; approval requirement does not apply.`,
    };
  } else {
    const reviews = await fetchReviews(octokit, owner, repo, prNumber);
    result = evaluateApprovals(reviews, prAuthor);
  }

  await publishResult(octokit, owner, repo, headSha, result);
}

run().catch(core.setFailed);

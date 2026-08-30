import * as core from "@actions/core";
import type * as github from "@actions/github";
import { getOctokit } from "./lib/octokit.js";

/**
 * Given a just-closed issue, returns the set of downstream issues that are
 * now eligible for `agent:developer` application. Used by the auto-trigger
 * unblock cascade.
 *
 * Inputs (via composite action env vars → core.getInput):
 *   token               – GitHub token with issue and pull-request read access
 *   repo                – Repository in "owner/name" format
 *   closed_issue_number – Issue number of the just-closed issue
 *
 * Outputs:
 *   unblocked – JSON array of integer issue numbers that are now newly unblocked
 */

/** Shape of a single item as returned by the blocking API endpoint. */
interface BlockingIssue {
  number: number;
  state: string;
  labels: Array<{ name: string }>;
}

/** Shape of a single item as returned by the blocked_by API endpoint. */
interface BlockedByItem {
  number: number;
  state: string;
}

/**
 * Fetches the list of issues that `issueNumber` is blocking.
 *
 * Any API error (including 404) is propagated to the caller so that a
 * transient GitHub failure never silently returns an empty list.
 */
export async function getBlockingIssues(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  issueNumber: number
): Promise<BlockingIssue[]> {
  const response = await octokit.request(
    "GET /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocking",
    { owner, repo, issue_number: issueNumber }
  );
  return response.data as BlockingIssue[];
}

/**
 * Returns true if `issueNumber` still has at least one open blocker in its
 * blocked-by list, false otherwise.
 *
 * Any API error is propagated to the caller so that a transient failure never
 * silently marks an issue as unblocked.
 */
export async function hasOpenBlockers(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  issueNumber: number
): Promise<boolean> {
  const response = await octokit.request(
    "GET /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by",
    { owner, repo, issue_number: issueNumber }
  );
  const blockers = response.data as BlockedByItem[];
  return blockers.some((b) => b.state === "open");
}

/**
 * Returns true if an open PR already exists on branch `agent/issue-{issueNumber}`,
 * false otherwise. Uses `owner:branch` server-side filtering consistent with
 * find-existing-pr's approach.
 *
 * Any API error is propagated to the caller.
 */
export async function hasAgentPR(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  issueNumber: number
): Promise<boolean> {
  const branch = `agent/issue-${issueNumber}`;
  const prs = await octokit.paginate(octokit.rest.pulls.list, {
    owner,
    repo,
    head: `${owner}:${branch}`,
    state: "open",
  });
  return prs.length > 0;
}

/**
 * Given a just-closed issue number, returns the numbers of downstream issues
 * that are now eligible for `agent:developer` application.
 *
 * A candidate qualifies only when ALL of the following hold:
 *   1. The issue is open.
 *   2. The issue carries the `blocked` label.
 *   3. The issue does not carry the `agent:developer` label.
 *   4. No open PR exists on branch `agent/issue-{N}`.
 *   5. The issue's own `blocked_by` list contains no open issues.
 *
 * Candidates are sourced from the closed issue's `blocking` dependency list.
 * One API call is made per candidate for checks 4 and 5 — acceptable because
 * cascade candidate sets are bounded.
 */
export async function findNewlyUnblocked(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  closedIssueNumber: number
): Promise<number[]> {
  const candidates = await getBlockingIssues(
    octokit,
    owner,
    repo,
    closedIssueNumber
  );

  const unblocked: number[] = [];

  for (const issue of candidates) {
    // 1. Issue is open
    if (issue.state !== "open") {
      core.info(
        `Skipping issue #${issue.number}: not open (state="${issue.state}").`
      );
      continue;
    }

    // 2. Issue carries the `blocked` label
    const hasBlocked = issue.labels.some((l) => l.name === "blocked");
    if (!hasBlocked) {
      core.info(
        `Skipping issue #${issue.number}: missing "blocked" label.`
      );
      continue;
    }

    // 3. Issue does not carry the `agent:developer` label
    const hasAgentDeveloper = issue.labels.some(
      (l) => l.name === "agent:developer"
    );
    if (hasAgentDeveloper) {
      core.info(
        `Skipping issue #${issue.number}: already has "agent:developer" label.`
      );
      continue;
    }

    // 4. No open PR exists on branch agent/issue-{N}
    const prExists = await hasAgentPR(octokit, owner, repo, issue.number);
    if (prExists) {
      core.info(
        `Skipping issue #${issue.number}: open agent PR already exists on branch agent/issue-${issue.number}.`
      );
      continue;
    }

    // 5. Its own blocked_by list has no remaining open blockers
    const stillBlocked = await hasOpenBlockers(
      octokit,
      owner,
      repo,
      issue.number
    );
    if (stillBlocked) {
      core.info(
        `Skipping issue #${issue.number}: still has open blockers.`
      );
      continue;
    }

    core.info(`Issue #${issue.number} is newly unblocked.`);
    unblocked.push(issue.number);
  }

  return unblocked;
}

export async function run(): Promise<void> {
  const token = core.getInput("token", { required: true });
  const repo = core.getInput("repo", { required: true });
  const closedIssueNumberStr = core.getInput("closed_issue_number", {
    required: true,
  });

  const closedIssueNumber = parseInt(closedIssueNumberStr, 10);
  if (isNaN(closedIssueNumber) || closedIssueNumber <= 0) {
    throw new Error(
      `Invalid closed-issue-number: "${closedIssueNumberStr}". Expected a positive integer.`
    );
  }

  const slashIndex = repo.indexOf("/");
  if (slashIndex === -1) {
    throw new Error(
      `Invalid repo format: "${repo}". Expected "owner/name".`
    );
  }
  const owner = repo.slice(0, slashIndex);
  const repoName = repo.slice(slashIndex + 1);

  const octokit = getOctokit(token);

  const unblocked = await findNewlyUnblocked(
    octokit,
    owner,
    repoName,
    closedIssueNumber
  );

  core.info(
    `Found ${unblocked.length} newly unblocked issue(s): ${JSON.stringify(unblocked)}`
  );
  core.setOutput("unblocked", JSON.stringify(unblocked));
}

run().catch(core.setFailed);

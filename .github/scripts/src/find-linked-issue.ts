import * as core from "@actions/core";
import { getOctokit } from "./lib/octokit.js";
import { parseClosesRef } from "./lib/close-ref.js";

type Octokit = ReturnType<typeof getOctokit>;

export interface FindLinkedIssueResult {
  proceed: boolean;
  issueNumber?: number;
}

/**
 * Reads a PR body and returns the issue number parsed from a `Closes #N`
 * reference.
 *
 * Returns proceed=false (and logs a reason) when the PR body is absent or
 * contains no `Closes #N` reference — the caller should skip in that case.
 *
 * @param octokit   Authenticated Octokit client.
 * @param owner     Repository owner (user or organisation).
 * @param repo      Repository name.
 * @param prNumber  Pull request number to inspect.
 */
export async function findLinkedIssue(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number
): Promise<FindLinkedIssueResult> {
  const prResponse = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });

  const issueNumber = parseClosesRef(prResponse.data.body);
  if (issueNumber === undefined) {
    core.info(
      `PR #${prNumber} body does not contain a 'Closes #N' reference; skipping.`
    );
    return { proceed: false };
  }

  core.info(`PR #${prNumber} closes issue #${issueNumber}.`);
  return { proceed: true, issueNumber };
}

async function run(): Promise<void> {
  const token = core.getInput("token", { required: true });
  const repository = core.getInput("repository", { required: true });
  const prNumberStr = core.getInput("pr_number", { required: true });

  const separatorIndex = repository.indexOf("/");
  if (separatorIndex === -1) {
    core.setFailed(`Invalid repository format: ${repository}`);
    return;
  }
  const owner = repository.slice(0, separatorIndex);
  const repo = repository.slice(separatorIndex + 1);

  const prNumber = parseInt(prNumberStr, 10);
  if (isNaN(prNumber)) {
    core.setFailed(`Invalid pr-number: ${prNumberStr}`);
    return;
  }

  const octokit = getOctokit(token);
  const result = await findLinkedIssue(octokit, owner, repo, prNumber);

  core.setOutput("proceed", result.proceed ? "true" : "false");
  if (result.issueNumber !== undefined) {
    core.setOutput("issue_number", String(result.issueNumber));
  }
}

run().catch(core.setFailed);

import * as core from "@actions/core";
import { getOctokit } from "./lib/octokit.js";

/**
 * Checks whether a GitHub issue carries the "draft" label.  Used as a
 * preflight gate: the developer agent must not run until the design PR
 * merges and the draft label is removed by the undraft-sub-issues job.
 *
 * Inputs (via composite action env vars → core.getInput):
 *   token        – GitHub token with issue read access
 *   repo         – Repository in "owner/name" format
 *   issue-number – Issue number to inspect
 *
 * Outputs:
 *   skip         – "true" if the issue has the "draft" label, "false" otherwise
 */

/**
 * Returns true if any entry in `labels` matches `target`.
 * Handles both plain-string labels and object labels (as returned by the
 * GitHub REST API, where `name` may be a string or null).
 */
export function hasLabel(
  labels: Array<string | { name?: string | null }>,
  target: string
): boolean {
  return labels.some(
    (l) => (typeof l === "string" ? l : l.name) === target
  );
}

export async function run(): Promise<void> {
  const token = core.getInput("token", { required: true });
  const repo = core.getInput("repo", { required: true });
  const issueNumberStr = core.getInput("issue_number", { required: true });

  const issueNumber = parseInt(issueNumberStr, 10);
  if (isNaN(issueNumber)) {
    throw new Error(
      `Invalid issue-number: "${issueNumberStr}". Expected a positive integer.`
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

  const { data: issue } = await octokit.rest.issues.get({
    owner,
    repo: repoName,
    issue_number: issueNumber,
  });

  const isDraft = hasLabel(issue.labels, "draft");

  if (isDraft) {
    core.info(
      `Issue #${issueNumber} is labeled 'draft'; implementation cannot start ` +
        `until the design PR merges and the draft label is removed.`
    );
    core.setOutput("skip", "true");
  } else {
    core.setOutput("skip", "false");
  }
}

run().catch(core.setFailed);

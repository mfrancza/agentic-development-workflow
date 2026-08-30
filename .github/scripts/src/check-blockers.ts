import * as core from "@actions/core";
import type * as github from "@actions/github";
import { getOctokit } from "./lib/octokit.js";

/**
 * Queries the blocked-by list for a GitHub issue and reports whether any
 * blockers are still open. Used as a preflight gate: when any blocker is open
 * the consuming workflow should fail with an error message listing them.
 *
 * Inputs (via composite action env vars → core.getInput):
 *   token        – GitHub token with issue read access
 *   repo         – Repository in "owner/name" format
 *   issue-number – Issue number to inspect
 *
 * Outputs:
 *   blocked      – "true" if at least one blocker is open, "false" otherwise
 *   open-blockers – JSON array of { number, url, title } for each open blocker
 */

/** Shape of each entry emitted in the open-blockers output. */
export interface Blocker {
  number: number;
  url: string;
  title: string;
}

/** Shape of a single item as returned by the blocked-by API endpoint. */
interface BlockerPayload {
  number: number;
  html_url: string;
  title: string;
  state: string;
}

/**
 * Fetches the blocked-by list for `issueNumber` and returns only the entries
 * whose `state` is `"open"`.
 *
 * Any API error (including 404) is propagated to the caller so that a
 * transient GitHub failure never silently marks an issue "not blocked."
 */
export async function getOpenBlockers(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  issueNumber: number
): Promise<Blocker[]> {
  const response = await octokit.request(
    "GET /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by",
    {
      owner,
      repo,
      issue_number: issueNumber,
    }
  );

  const blockers = response.data as BlockerPayload[];

  return blockers
    .filter((b) => b.state === "open")
    .map((b) => ({
      number: b.number,
      url: b.html_url,
      title: b.title,
    }));
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

  const openBlockers = await getOpenBlockers(octokit, owner, repoName, issueNumber);

  const isBlocked = openBlockers.length > 0;
  core.setOutput("blocked", isBlocked ? "true" : "false");
  core.setOutput("open-blockers", JSON.stringify(openBlockers));
}

run().catch(core.setFailed);

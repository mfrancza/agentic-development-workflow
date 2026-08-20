import * as core from "@actions/core";
import { getOctokit } from "./lib/octokit.js";

/**
 * Looks up an open PR by head branch and filters by fork-owner to prevent
 * false positives from forks with identically-named branches.
 *
 * Inputs (via composite action env vars → core.getInput):
 *   token        – GitHub token with pull-request read access
 *   repo         – Repository in "owner/name" format
 *   branch       – Head branch name to search for
 *   owner        – Expected repository owner login
 *
 * Outputs:
 *   skip         – "true" if an existing open PR from the expected owner was
 *                  found, "false" otherwise
 *   pr-number    – Number of the matching PR, or empty string when not found
 */

/**
 * Finds the first PR in `prs` whose head repository is owned by `owner`.
 * Returns the skip/prNumber decision as plain data so callers can act on it
 * without needing to perform any IO.
 */
export function selectMatchingPR(
  prs: Array<{ number: number; head: { repo?: { owner: { login: string } } | null } }>,
  owner: string
): { skip: boolean; prNumber: string } {
  const match = prs.find((pr) => pr.head.repo?.owner.login === owner);
  return match
    ? { skip: true, prNumber: String(match.number) }
    : { skip: false, prNumber: "" };
}

export async function run(): Promise<void> {
  const token = core.getInput("token", { required: true });
  const repo = core.getInput("repo", { required: true });
  const branch = core.getInput("branch", { required: true });
  const owner = core.getInput("owner", { required: true });

  const slashIndex = repo.indexOf("/");
  if (slashIndex === -1) {
    throw new Error(
      `Invalid repo format: "${repo}". Expected "owner/name".`
    );
  }
  const repoOwner = repo.slice(0, slashIndex);
  const repoName = repo.slice(slashIndex + 1);

  const octokit = getOctokit(token);

  // Use the "owner:branch" head filter for server-side narrowing, then verify
  // head.repo.owner.login client-side to guard against any edge-case where the
  // API returns PRs from a different owner (e.g. the base repo has an atypical
  // fork relationship).
  const prs = await octokit.paginate(octokit.rest.pulls.list, {
    owner: repoOwner,
    repo: repoName,
    head: `${owner}:${branch}`,
    state: "open",
  });

  const { skip, prNumber } = selectMatchingPR(prs, owner);

  if (skip) {
    core.info(
      `Found existing open PR #${prNumber} for ${branch} (owner: ${owner}); skipping.`
    );
    core.setOutput("skip", "true");
    core.setOutput("pr-number", prNumber);
  } else {
    core.setOutput("skip", "false");
    core.setOutput("pr-number", "");
  }
}

run().catch(core.setFailed);

import * as core from "@actions/core";
import { parseAllowedChecks } from "./lib/allowed-checks.js";
import { getOctokit } from "./lib/octokit.js";

type Octokit = ReturnType<typeof getOctokit>;

const ACTIONABLE_CONCLUSIONS = new Set([
  "failure",
  "timed_out",
  "action_required",
]);

export interface FailingAgentPr {
  number: number;
  head_sha: string;
}

/**
 * Finds open developer-agent PRs that have at least one allowed actionable
 * check at their current head. The allowlist is an authorization boundary, so
 * an absent, empty, or malformed value deliberately returns no PRs.
 */
export async function findFailingAgentPrs(
  octokit: Octokit,
  owner: string,
  repo: string,
  author: string,
  allowedChecksInput: string
): Promise<FailingAgentPr[]> {
  const allowedChecks = parseAllowedChecks(allowedChecksInput);
  if (!allowedChecks) {
    core.info("FIX_CHECKS_ALLOW is empty or malformed; polling dispatches nothing.");
    return [];
  }

  const selected: FailingAgentPr[] = [];
  for (let page = 1; ; page++) {
    const response = await octokit.rest.pulls.list({
      owner,
      repo,
      state: "open",
      per_page: 100,
      page,
    });

    for (const pr of response.data) {
      if (
        pr.user?.login !== author ||
        pr.labels.some((label) => label.name === "human-required")
      ) {
        continue;
      }

      let allowedFailure = false;
      for (let checkPage = 1; ; checkPage++) {
        const checks = await octokit.rest.checks.listForRef({
          owner,
          repo,
          ref: pr.head.sha,
          per_page: 100,
          page: checkPage,
        });
        allowedFailure = checks.data.check_runs.some(
          (checkRun) =>
            allowedChecks.includes(checkRun.name) &&
            ACTIONABLE_CONCLUSIONS.has(checkRun.conclusion ?? "")
        );
        if (allowedFailure || checks.data.check_runs.length < 100) break;
      }

      if (allowedFailure) {
        core.info(
          `PR #${pr.number} at ${pr.head.sha} has an allowed actionable check.`
        );
        selected.push({ number: pr.number, head_sha: pr.head.sha });
      }
    }

    if (response.data.length < 100) break;
  }

  return selected;
}

async function run(): Promise<void> {
  const token = core.getInput("token", { required: true });
  const repository = core.getInput("repository", { required: true });
  const author = core.getInput("author", { required: true });
  const allowedChecks = core.getInput("allowed_checks", { required: true });
  const separatorIndex = repository.indexOf("/");
  if (separatorIndex === -1) {
    core.setFailed(`Invalid repository format: ${repository}`);
    return;
  }

  const prs = await findFailingAgentPrs(
    getOctokit(token),
    repository.slice(0, separatorIndex),
    repository.slice(separatorIndex + 1),
    author,
    allowedChecks
  );
  core.setOutput("prs", JSON.stringify(prs));
}

run().catch(core.setFailed);

import * as core from "@actions/core";
import { parseAllowedChecks } from "./lib/allowed-checks.js";
import { getOctokit } from "./lib/octokit.js";

type Octokit = ReturnType<typeof getOctokit>;

const ACTIONABLE_CONCLUSIONS = new Set([
  "failure",
  "timed_out",
  "action_required",
]);

export interface ResolveCheckPrResult {
  proceed: boolean;
  prNumber?: number;
  headSha?: string;
}

export { parseAllowedChecks } from "./lib/allowed-checks.js";

/**
 * Resolves a check head SHA to an open pull request and authorises it only
 * when the current Checks API state contains an allowed, actionable check run.
 */
export async function resolveCheckPr(
  octokit: Octokit,
  owner: string,
  repo: string,
  headSha: string,
  allowedChecksInput: string
): Promise<ResolveCheckPrResult> {
  const allowedChecks = parseAllowedChecks(allowedChecksInput);
  if (!allowedChecks) {
    core.info("FIX_CHECKS_ALLOW is empty or malformed; skipping.");
    return { proceed: false };
  }

  if (!headSha) {
    core.info("Trigger has no usable head SHA; skipping.");
    return { proceed: false };
  }

  const response = await octokit.rest.repos.listPullRequestsAssociatedWithCommit({
    owner,
    repo,
    commit_sha: headSha,
  });
  const pr = response.data.find(
    (candidate) => candidate.state === "open" && candidate.head.sha === headSha
  );
  const prNumber = pr?.number;

  if (prNumber === undefined) {
    core.info(`No open PR found for SHA ${headSha}; skipping.`);
    return { proceed: false };
  }

  const checkRuns = await octokit.rest.checks.listForRef({
    owner,
    repo,
    ref: headSha,
  });
  const actionableAllowedCheck = checkRuns.data.check_runs.find(
    (checkRun) =>
      allowedChecks.includes(checkRun.name) &&
      ACTIONABLE_CONCLUSIONS.has(checkRun.conclusion ?? "")
  );

  if (!actionableAllowedCheck) {
    core.info(
      `No allowed actionable check run remains for PR #${prNumber} at ${headSha}; skipping.`
    );
    return { proceed: false, prNumber, headSha };
  }

  core.info(
    `Resolved PR #${prNumber} at ${headSha}; allowed actionable check '${actionableAllowedCheck.name}' found.`
  );
  return { proceed: true, prNumber, headSha };
}

async function run(): Promise<void> {
  const token = core.getInput("token", { required: true });
  const repository = core.getInput("repository", { required: true });
  const headSha = core.getInput("head_sha", { required: true });
  const allowedChecks = core.getInput("allowed_checks", { required: true });
  const separatorIndex = repository.indexOf("/");
  if (separatorIndex === -1) {
    core.setFailed(`Invalid repository format: ${repository}`);
    return;
  }

  const result = await resolveCheckPr(
    getOctokit(token),
    repository.slice(0, separatorIndex),
    repository.slice(separatorIndex + 1),
    headSha,
    allowedChecks
  );
  core.setOutput("proceed", result.proceed ? "true" : "false");
  if (result.prNumber !== undefined) core.setOutput("pr_number", String(result.prNumber));
  if (result.headSha !== undefined) core.setOutput("head_sha", result.headSha);
}

run().catch(core.setFailed);

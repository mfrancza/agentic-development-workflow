import * as core from "@actions/core";
import { getOctokit } from "./lib/octokit.js";

type Octokit = ReturnType<typeof getOctokit>;

export interface ResolveDeploymentResult {
  proceed: boolean;
  runId?: number;
  issueNumber?: number;
}

/**
 * Resolves a failed deployment SHA to a workflow run ID and the originating
 * issue number.
 *
 * Steps:
 *   1. Find the most recent failed workflow run for the given SHA.
 *   2. Find the PR associated with that commit.
 *   3. Parse the "Closes #N" reference from the PR body.
 *
 * Returns proceed=false (and logs a reason) if any step yields no result —
 * better to skip cleanly than to hand the agent incomplete context.
 *
 * @param octokit    Authenticated Octokit client.
 * @param owner      Repository owner (user or organisation).
 * @param repo       Repository name.
 * @param sha        The deployment commit SHA.
 */
export async function resolveDeployment(
  octokit: Octokit,
  owner: string,
  repo: string,
  sha: string
): Promise<ResolveDeploymentResult> {
  // Step 1: find the most recent failed workflow run for this SHA.
  const runsResponse = await octokit.rest.actions.listWorkflowRunsForRepo({
    owner,
    repo,
    head_sha: sha,
    status: "failure",
    per_page: 1,
  });

  const runId = runsResponse.data.workflow_runs[0]?.id;
  if (runId === undefined) {
    core.info(`No failed workflow run found for SHA ${sha}; skipping.`);
    return { proceed: false };
  }

  // Step 2: find the PR associated with the commit.
  const prsResponse =
    await octokit.rest.repos.listPullRequestsAssociatedWithCommit({
      owner,
      repo,
      commit_sha: sha,
    });

  const prNumber = prsResponse.data[0]?.number;
  if (prNumber === undefined) {
    core.info(`No PR found for commit ${sha}; skipping.`);
    return { proceed: false };
  }

  // Step 3: get the PR body and parse "Closes #N".
  const prResponse = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });

  const body = prResponse.data.body ?? "";
  const match = body.match(/closes\s+#(\d+)/i);
  if (!match) {
    core.info(
      `PR #${prNumber} did not reference an issue with 'Closes #N'; skipping.`
    );
    return { proceed: false };
  }

  const issueNumber = parseInt(match[1], 10);
  core.info(
    `Resolved SHA ${sha} → run ${runId}, PR #${prNumber}, issue #${issueNumber}.`
  );
  return { proceed: true, runId, issueNumber };
}

async function run(): Promise<void> {
  const token = core.getInput("token", { required: true });
  const repository = core.getInput("repository", { required: true });
  const sha = core.getInput("sha", { required: true });

  const separatorIndex = repository.indexOf("/");
  if (separatorIndex === -1) {
    core.setFailed(`Invalid repository format: ${repository}`);
    return;
  }
  const owner = repository.slice(0, separatorIndex);
  const repo = repository.slice(separatorIndex + 1);

  const octokit = getOctokit(token);
  const result = await resolveDeployment(octokit, owner, repo, sha);

  core.setOutput("proceed", result.proceed ? "true" : "false");
  if (result.runId !== undefined) {
    core.setOutput("run_id", String(result.runId));
  }
  if (result.issueNumber !== undefined) {
    core.setOutput("issue_number", String(result.issueNumber));
  }
}

run().catch(core.setFailed);

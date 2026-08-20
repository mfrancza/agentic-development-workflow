import * as core from "@actions/core";
import { getOctokit } from "./lib/octokit.js";

type Octokit = ReturnType<typeof getOctokit>;

export interface FilterAgentPrResult {
  proceed: boolean;
}

/**
 * PR-author trust gate: returns proceed=true only when the PR was authored by
 * the expected agent bot login.
 *
 * This is used by agent-fix-checks to ensure the workflow only reacts to CI
 * failures on the developer agent's own PRs, never on PRs from other authors.
 *
 * @param octokit     Authenticated Octokit client.
 * @param owner       Repository owner (user or organisation).
 * @param repo        Repository name.
 * @param prNumber    Pull request number to inspect.
 * @param agentLogin  Expected bot login (e.g. "mfrancza-developer-agent[bot]").
 */
export async function filterAgentPr(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  agentLogin: string
): Promise<FilterAgentPrResult> {
  const prResponse = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });

  const author = prResponse.data.user?.login ?? "";
  if (author === agentLogin) {
    core.info(`PR #${prNumber} is authored by ${author}; proceeding.`);
    return { proceed: true };
  }

  core.info(
    `PR #${prNumber} author '${author}' is not the developer agent; skipping.`
  );
  return { proceed: false };
}

async function run(): Promise<void> {
  const token = core.getInput("token", { required: true });
  const repository = core.getInput("repository", { required: true });
  const prNumberStr = core.getInput("pr-number", { required: true });
  const agentLogin = core.getInput("agent-login", { required: true });

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
  const result = await filterAgentPr(octokit, owner, repo, prNumber, agentLogin);

  core.setOutput("proceed", result.proceed ? "true" : "false");
}

run().catch(core.setFailed);

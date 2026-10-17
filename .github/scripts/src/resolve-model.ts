import * as core from "@actions/core";
import { getOctokit } from "./lib/octokit.js";
import { resolveModel, type SubjectType } from "./lib/resolve-model.js";

/**
 * Entry point — reads action inputs, calls resolveModel, and publishes the
 * resolved model name as the `claude_model` output.
 */
async function run(): Promise<void> {
  const token = core.getInput("token", { required: true });
  const subjectTypeInput = core.getInput("subject_type", { required: true });
  const subjectNumberStr = core.getInput("subject_number", { required: true });
  const repo = core.getInput("repo", { required: true });
  const defaultModel = core.getInput("default_model", { required: true });

  if (subjectTypeInput !== "issue" && subjectTypeInput !== "pr") {
    throw new Error(
      `Invalid subject-type: "${subjectTypeInput}". Must be "issue" or "pr".`,
    );
  }
  const subjectType: SubjectType = subjectTypeInput;

  const subjectNumber = parseInt(subjectNumberStr, 10);
  if (isNaN(subjectNumber) || subjectNumber <= 0) {
    throw new Error(
      `Invalid subject-number: "${subjectNumberStr}". Must be a positive integer.`,
    );
  }

  const slashIndex = repo.indexOf("/");
  if (slashIndex === -1) {
    throw new Error(
      `Invalid repo: "${repo}". Expected "owner/name" format.`,
    );
  }
  const owner = repo.slice(0, slashIndex);
  const repoName = repo.slice(slashIndex + 1);

  const agentTypeInput = core.getInput("agent_type", { required: false });
  const agentType = agentTypeInput.trim() || undefined;

  const octokit = getOctokit(token);
  const claudeModel = await resolveModel(
    octokit,
    subjectType,
    subjectNumber,
    owner,
    repoName,
    defaultModel,
    agentType,
  );

  core.setOutput("claude_model", claudeModel);
  core.info(`Resolved model: ${claudeModel}`);
}

// Skip the entry-point side-effect when the module is imported by the test
// runner (vitest sets VITEST=true). This prevents spurious ::error:: log
// annotations during `npm test` without coupling the logic to a test-only
// variable anywhere except this single guard.
if (!process.env.VITEST) {
  run().catch((err: unknown) =>
    core.setFailed(err instanceof Error ? err.message : String(err)),
  );
}

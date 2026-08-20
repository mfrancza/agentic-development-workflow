import * as core from "@actions/core";
import { getOctokit } from "./lib/octokit.js";

/**
 * The type of GitHub object whose labels are inspected.
 */
export type SubjectType = "issue" | "pr";

/**
 * Resolves a Claude model name from `model:*` labels on a GitHub issue or PR.
 *
 * Rules:
 * - Zero `model:*` labels → returns `defaultModel`.
 * - Exactly one `model:*` label → returns the part after `"model:"`.
 * - More than one `model:*` label → throws an error (fail-loud per AGENTS.md).
 *
 * @param octokit      Pre-authenticated Octokit client.
 * @param subjectType  "issue" or "pr".
 * @param subjectNumber  Issue or PR number.
 * @param owner        Repository owner login.
 * @param repo         Repository name (without owner).
 * @param defaultModel Fallback model when no `model:*` label is present.
 * @returns            Resolved model name (e.g. "sonnet", "opus", "haiku").
 */
export async function resolveModel(
  octokit: ReturnType<typeof getOctokit>,
  subjectType: SubjectType,
  subjectNumber: number,
  owner: string,
  repo: string,
  defaultModel: string,
): Promise<string> {
  let rawLabels: Array<string | { name?: string | null }>;

  if (subjectType === "issue") {
    const { data } = await octokit.rest.issues.get({
      owner,
      repo,
      issue_number: subjectNumber,
    });
    rawLabels = data.labels;
  } else {
    const { data } = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: subjectNumber,
    });
    rawLabels = data.labels;
  }

  const labelNames = rawLabels.map((l) =>
    typeof l === "string" ? l : (l.name ?? ""),
  );
  const modelLabels = labelNames.filter((name) => name.startsWith("model:"));

  if (modelLabels.length > 1) {
    throw new Error(
      `Multiple model:* labels found on ${subjectType} #${subjectNumber}: ${modelLabels.join(", ")}. Remove all but one.`,
    );
  }

  if (modelLabels.length === 1) {
    return modelLabels[0].slice("model:".length);
  }

  return defaultModel;
}

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

  const octokit = getOctokit(token);
  const claudeModel = await resolveModel(
    octokit,
    subjectType,
    subjectNumber,
    owner,
    repoName,
    defaultModel,
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

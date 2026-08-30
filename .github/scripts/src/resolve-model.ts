import * as core from "@actions/core";
import { getOctokit } from "./lib/octokit.js";

/**
 * The type of GitHub object whose labels are inspected.
 */
export type SubjectType = "issue" | "pr";

/**
 * Resolves a Claude model name from `model:*` labels on a GitHub issue or PR.
 *
 * When `agentType` is provided (issue-based workflows), a two-tier waterfall
 * is applied:
 *   1. Per-agent tier — labels matching `model:<agentType>:*`. Exactly one
 *      allowed; more than one is a loud failure.
 *   2. Generic tier — labels matching `^model:[^:]+$` (excludes per-agent
 *      labels that contain a second colon). Exactly one allowed; more than
 *      one is a loud failure.
 *   3. Fallback to `defaultModel`.
 *
 * When `agentType` is omitted (PR-based workflows), the original single-tier
 * behaviour is preserved: all `model:*` labels are considered together, and
 * more than one is a loud failure.
 *
 * @param octokit       Pre-authenticated Octokit client.
 * @param subjectType   "issue" or "pr".
 * @param subjectNumber Issue or PR number.
 * @param owner         Repository owner login.
 * @param repo          Repository name (without owner).
 * @param defaultModel  Fallback model when no `model:*` label is present.
 * @param agentType     Optional agent type (e.g. "developer", "groom",
 *                      "design") enabling per-agent label resolution.
 * @returns             Resolved model name (e.g. "sonnet", "opus", "haiku").
 */
export async function resolveModel(
  octokit: ReturnType<typeof getOctokit>,
  subjectType: SubjectType,
  subjectNumber: number,
  owner: string,
  repo: string,
  defaultModel: string,
  agentType?: string,
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

  if (agentType) {
    // Tier 1: per-agent labels — model:<agentType>:*
    const perAgentPrefix = `model:${agentType}:`;
    const perAgentLabels = labelNames.filter((name) =>
      name.startsWith(perAgentPrefix),
    );

    if (perAgentLabels.length > 1) {
      throw new Error(
        `Multiple ${perAgentPrefix}* labels found on ${subjectType} #${subjectNumber}: ${perAgentLabels.join(", ")}. Remove all but one.`,
      );
    }

    if (perAgentLabels.length === 1) {
      return perAgentLabels[0].slice(perAgentPrefix.length);
    }

    // Tier 2: generic labels — model:* but not model:<x>:<y>
    const genericModelLabels = labelNames.filter((name) =>
      /^model:[^:]+$/.test(name),
    );

    if (genericModelLabels.length > 1) {
      throw new Error(
        `Multiple model:* labels found on ${subjectType} #${subjectNumber}: ${genericModelLabels.join(", ")}. Remove all but one.`,
      );
    }

    if (genericModelLabels.length === 1) {
      return genericModelLabels[0].slice("model:".length);
    }

    return defaultModel;
  }

  // Original single-tier behaviour (PR-based workflows, no agentType).
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

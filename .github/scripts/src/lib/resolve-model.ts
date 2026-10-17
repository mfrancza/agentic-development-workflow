import { getOctokit } from "./octokit.js";

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

import { getOctokit } from "./octokit.js";
import { classTable, modelToClass } from "./model-classes.js";
import {
  selectReviewerModel,
  type PairingConfig,
} from "./model-pair.js";

/**
 * The type of GitHub object whose labels are inspected.
 */
export type SubjectType = "issue" | "pr";

/**
 * Optional pairing configuration forwarded from the composite action's new
 * inputs.  Only consulted when `agentType === "review"`.
 */
export interface PairingOptions {
  /** The parsed `REVIEW_MODEL_PAIRING` JSON object. */
  pairingConfig: PairingConfig;
  /** The authoring model parsed from the `<!-- authored-by-model: ... -->` marker. */
  authoringModel: string;
  /** API providers whose key is available (e.g. ["anthropic","openai"]). */
  availableProviders: readonly string[];
}

/**
 * Resolves a Claude model name from `model:*` labels on a GitHub issue or PR.
 *
 * When `agentType` is provided (issue-based workflows), a three-tier waterfall
 * is applied:
 *   1. Per-agent tier — labels matching `model:<agentType>:*`. Exactly one
 *      allowed; more than one is a loud failure.
 *   2. Generic tier — labels matching `^model:[^:]+$` (excludes per-agent
 *      labels that contain a second colon). Exactly one allowed; more than
 *      one is a loud failure.
 *   3. Pairing tier — only when `agentType === "review"` and `pairingOptions`
 *      is supplied and the configured policy is not "off". Calls
 *      `selectReviewerModel()` to pick a cross-vendor reviewer.
 *   4. Fallback to `defaultModel`.
 *
 * When `agentType` is omitted (PR-based workflows), the original single-tier
 * behaviour is preserved: all `model:*` labels are considered together, and
 * more than one is a loud failure.
 *
 * @param octokit         Pre-authenticated Octokit client.
 * @param subjectType     "issue" or "pr".
 * @param subjectNumber   Issue or PR number.
 * @param owner           Repository owner login.
 * @param repo            Repository name (without owner).
 * @param defaultModel    Fallback model when no `model:*` label is present.
 * @param agentType       Optional agent type (e.g. "developer", "groom",
 *                        "design", "review") enabling per-agent label resolution.
 * @param pairingOptions  Optional pairing configuration; only consulted when
 *                        agentType === "review".
 * @param emitWarning     Optional callback invoked for each warning string.
 *                        The default is a no-op — callers that want to surface
 *                        warnings via `core.warning()` pass that function here.
 * @returns               Resolved model name (e.g. "sonnet", "opus", "haiku").
 */
export async function resolveModel(
  octokit: ReturnType<typeof getOctokit>,
  subjectType: SubjectType,
  subjectNumber: number,
  owner: string,
  repo: string,
  defaultModel: string,
  agentType?: string,
  pairingOptions?: PairingOptions,
  emitWarning: (msg: string) => void = () => { /* no-op */ },
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

    // Tier 3: pairing tier — only for agent-type: review
    if (agentType === "review" && pairingOptions) {
      const { pairingConfig, authoringModel, availableProviders } = pairingOptions;

      if (!authoringModel) {
        emitWarning(
          `Pairing tier skipped: authoring model marker is absent or empty on this PR. ` +
            `Falling through to DEFAULT_MODEL "${defaultModel}".`,
        );
      } else if (pairingConfig.policy !== "off" && pairingConfig.enabled === true) {
        const result = selectReviewerModel(
          authoringModel,
          pairingConfig,
          availableProviders,
          classTable,
          defaultModel,
          modelToClass,
        );

        for (const w of result.warnings) {
          // ERROR-prefixed messages become core.error() calls; all others are
          // core.warning().  The emitWarning callback receives the raw string;
          // the entry point (src/resolve-model.ts) is responsible for
          // distinguishing them and routing to the right core function.
          emitWarning(w);
        }

        if (result.model !== undefined) {
          return result.model;
        }

        // Defensive: with enabled === true and policy !== "off",
        // selectReviewerModel always returns a defined model.  This branch is
        // unreachable in practice but guards against future changes.
        emitWarning(
          `Pairing tier returned no model; falling through to DEFAULT_MODEL "${defaultModel}".`,
        );
      }
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

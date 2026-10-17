import * as core from "@actions/core";
import { getOctokit } from "./lib/octokit.js";
import { resolveModel } from "./resolve-model.js";

export interface ReviewerSetEntry {
  model: string;
}

/**
 * Resolves the reviewer set for a given PR using the following waterfall:
 *
 * 1. **Per-PR label override** — if the PR carries one or more
 *    `model:review:*` labels, the reviewer set is exactly those labels
 *    (multiple allowed; this deliberately relaxes the single-`model:review:*`
 *    fail-loud rule in `resolveModel` for the `review` agent type).
 * 2. **Repo-wide list** — if `reviewerModels` is non-empty, use it verbatim.
 * 3. **Single-reviewer fallback** — resolve one model via the existing
 *    two-tier waterfall on the PR (generic `model:*` label →
 *    `defaultModel`) and return a single-element set. Reuses `resolveModel()`
 *    to avoid forking the fallback logic.
 *
 * @param octokit        Pre-authenticated Octokit client.
 * @param prNumber       Pull request number.
 * @param owner          Repository owner login.
 * @param repo           Repository name (without owner).
 * @param reviewerModels Parsed REVIEWER_MODELS variable (may be empty).
 * @param defaultModel   Fallback model when no label or list is present.
 * @returns              Non-empty array of reviewer-set entries; throws on
 *                       unrecoverable resolution failure.
 */
export async function resolveReviewerSet(
  octokit: ReturnType<typeof getOctokit>,
  prNumber: number,
  owner: string,
  repo: string,
  reviewerModels: string[],
  defaultModel: string,
): Promise<ReviewerSetEntry[]> {
  // Fetch PR labels once for the Tier 1 check.
  const { data: pr } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });

  const labelNames = pr.labels.map((l: string | { name?: string | null }) =>
    typeof l === "string" ? l : (l.name ?? ""),
  );

  // Tier 1: Per-PR model:review:* label override.
  // Multiple labels are allowed and each becomes its own reviewer entry.
  const reviewPrefix = "model:review:";
  const reviewLabels = labelNames.filter((name: string) =>
    name.startsWith(reviewPrefix),
  );
  if (reviewLabels.length > 0) {
    return reviewLabels.map((label: string) => ({
      model: label.slice(reviewPrefix.length),
    }));
  }

  // Tier 2: Repo-wide list from the REVIEWER_MODELS Actions variable.
  if (reviewerModels.length > 0) {
    return reviewerModels.map((model) => ({ model }));
  }

  // Tier 3: Single-reviewer fallback via the existing two-tier waterfall.
  // resolveModel with agentType="review" applies:
  //   model:review:* (none, verified above) → generic model:* → defaultModel.
  // Reusing resolveModel avoids forking the fallback logic.
  const model = await resolveModel(
    octokit,
    "pr",
    prNumber,
    owner,
    repo,
    defaultModel,
    "review",
  );
  return [{ model }];
}

/**
 * Entry point — reads action inputs, calls resolveReviewerSet, and publishes
 * the reviewer set as the `set` output (JSON array of { model } objects shaped
 * for `strategy.matrix.include`).
 *
 * On unrecoverable resolution failure the function throws; the top-level
 * `.catch()` calls `core.setFailed()` with the error message.
 */
async function run(): Promise<void> {
  const token = core.getInput("token", { required: true });
  const prNumberStr = core.getInput("pr_number", { required: true });
  const repo = core.getInput("repo", { required: true });
  const reviewerModelsInput = core.getInput("reviewer_models", {
    required: false,
  });
  const defaultModel = core.getInput("default_model", { required: true });
  // pair_policy: reserved for the future pair-policy tier; not consumed yet.

  const prNumber = parseInt(prNumberStr, 10);
  if (isNaN(prNumber) || prNumber <= 0) {
    throw new Error(
      `Invalid pr-number: "${prNumberStr}". Must be a positive integer.`,
    );
  }

  const slashIndex = repo.indexOf("/");
  if (slashIndex === -1) {
    throw new Error(`Invalid repo: "${repo}". Expected "owner/name" format.`);
  }
  const owner = repo.slice(0, slashIndex);
  const repoName = repo.slice(slashIndex + 1);

  // Parse reviewer_models: empty string → []; otherwise must be a JSON array.
  let reviewerModels: string[] = [];
  const trimmed = reviewerModelsInput.trim();
  if (trimmed !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error(
        `Failed to parse reviewer_models as JSON: "${reviewerModelsInput}"`,
      );
    }
    if (!Array.isArray(parsed)) {
      throw new Error(
        `reviewer_models must be a JSON array, got: "${reviewerModelsInput}"`,
      );
    }
    reviewerModels = parsed as string[];
  }

  const octokit = getOctokit(token);

  const reviewerSet = await resolveReviewerSet(
    octokit,
    prNumber,
    owner,
    repoName,
    reviewerModels,
    defaultModel,
  );

  // Decision 5 soft cost warning: flag when the resolved set is large.
  if (reviewerSet.length > 3) {
    core.warning(
      `Resolved reviewer set has ${reviewerSet.length} reviewers; each push ` +
        `will fan out to ${reviewerSet.length} parallel review passes and ` +
        `spend ~${reviewerSet.length}× review cost.`,
    );
  }

  const setJson = JSON.stringify(reviewerSet);
  core.setOutput("set", setJson);
  core.info(
    `Resolved reviewer set (${reviewerSet.length} reviewer(s)): ${setJson}`,
  );
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

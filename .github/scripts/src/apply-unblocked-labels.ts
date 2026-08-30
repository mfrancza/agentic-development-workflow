import * as core from "@actions/core";
import type * as github from "@actions/github";
import { getOctokit } from "./lib/octokit.js";

/**
 * Applies the `agent:developer` label and removes the `blocked` label from
 * each issue number in the provided list. Used by the auto-trigger unblock
 * cascade.
 *
 * Inputs (via composite action env vars → core.getInput):
 *   token     – GitHub token with issue write access
 *   repo      – Repository in "owner/name" format
 *   unblocked – JSON array of integer issue numbers to process
 */

/**
 * Applies `agent:developer` to a single issue, with re-check logic on failure.
 *
 * Returns normally on success or if the label was already present (warning).
 * Calls `core.setFailed` and returns `false` on a real operational error.
 */
export async function applyAgentDeveloperLabel(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  issueNumber: number
): Promise<boolean> {
  try {
    await octokit.rest.issues.addLabels({
      owner,
      repo,
      issue_number: issueNumber,
      labels: ["agent:developer"],
    });
    return true;
  } catch {
    // Re-check: determine if the label is already present (non-fatal) or
    // truly absent after failure (fatal operational error).
    try {
      const { data: issue } = await octokit.rest.issues.get({
        owner,
        repo,
        issue_number: issueNumber,
      });
      const alreadyPresent = issue.labels.some(
        (l) => (typeof l === "string" ? l : l.name) === "agent:developer"
      );
      if (alreadyPresent) {
        core.warning(
          `agent:developer was already present on issue #${issueNumber} — skipping add (non-fatal).`
        );
        return true;
      } else {
        core.setFailed(
          `Failed to apply agent:developer to issue #${issueNumber} and the label is still absent. Check token permissions and API rate limits.`
        );
        return false;
      }
    } catch {
      core.setFailed(
        `Failed to apply agent:developer to issue #${issueNumber}, and the re-check API call also failed (check token permissions and API rate limits).`
      );
      return false;
    }
  }
}

/**
 * Removes the `blocked` label from a single issue, with re-check logic on failure.
 *
 * Returns normally on success or if the label was already absent (warning).
 * Calls `core.setFailed` and returns `false` on a real operational error.
 */
export async function removeBlockedLabel(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  issueNumber: number
): Promise<boolean> {
  try {
    await octokit.rest.issues.removeLabel({
      owner,
      repo,
      issue_number: issueNumber,
      name: "blocked",
    });
    return true;
  } catch {
    // Re-check: determine if the label is still present (fatal) or already
    // absent (non-fatal, treat as a no-op warning).
    try {
      const { data: issue } = await octokit.rest.issues.get({
        owner,
        repo,
        issue_number: issueNumber,
      });
      const stillPresent = issue.labels.some(
        (l) => (typeof l === "string" ? l : l.name) === "blocked"
      );
      if (stillPresent) {
        core.setFailed(
          `Failed to remove blocked label from issue #${issueNumber} and the label is still present. Check token permissions and API rate limits.`
        );
        return false;
      } else {
        core.warning(
          `blocked label was already absent from issue #${issueNumber} — skipping remove (non-fatal).`
        );
        return true;
      }
    } catch {
      core.setFailed(
        `Failed to remove blocked label from issue #${issueNumber}, and the re-check API call also failed (check token permissions and API rate limits).`
      );
      return false;
    }
  }
}

/**
 * Iterates over the provided issue numbers, applying `agent:developer` and
 * removing `blocked` from each. Returns false if any operation fails fatally.
 */
export async function applyUnblockedLabels(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  issueNumbers: number[]
): Promise<boolean> {
  if (issueNumbers.length === 0) {
    core.info("No newly-unblocked issues found; nothing to do.");
    return true;
  }

  core.info(
    `Found ${issueNumbers.length} newly-unblocked issue(s): ${JSON.stringify(issueNumbers)}`
  );

  for (const issueNumber of issueNumbers) {
    core.info(`Processing issue #${issueNumber}.`);

    const labelApplied = await applyAgentDeveloperLabel(
      octokit,
      owner,
      repo,
      issueNumber
    );
    if (!labelApplied) {
      return false;
    }

    const labelRemoved = await removeBlockedLabel(
      octokit,
      owner,
      repo,
      issueNumber
    );
    if (!labelRemoved) {
      return false;
    }

    core.info(`  Done processing issue #${issueNumber}.`);
  }

  core.info(
    `Cascade complete. Applied agent:developer and removed blocked from ${issueNumbers.length} issue(s).`
  );
  return true;
}

export async function run(): Promise<void> {
  const token = core.getInput("token", { required: true });
  const repo = core.getInput("repo", { required: true });
  const unblockedStr = core.getInput("unblocked", { required: true });

  const slashIndex = repo.indexOf("/");
  if (slashIndex === -1) {
    throw new Error(
      `Invalid repo format: "${repo}". Expected "owner/name".`
    );
  }
  const owner = repo.slice(0, slashIndex);
  const repoName = repo.slice(slashIndex + 1);

  let issueNumbers: number[];
  try {
    const parsed = JSON.parse(unblockedStr);
    if (!Array.isArray(parsed)) {
      throw new Error("Expected a JSON array.");
    }
    issueNumbers = parsed.map((n: unknown) => {
      if (typeof n !== "number" || !Number.isInteger(n)) {
        throw new Error(`Expected integer elements, got: ${JSON.stringify(n)}`);
      }
      return n;
    });
  } catch (err) {
    throw new Error(
      `Invalid unblocked input: "${unblockedStr}". Expected a JSON array of integers. ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const octokit = getOctokit(token);

  const success = await applyUnblockedLabels(octokit, owner, repoName, issueNumbers);
  if (!success) {
    // core.setFailed was already called inside applyUnblockedLabels
    return;
  }
}

run().catch(core.setFailed);

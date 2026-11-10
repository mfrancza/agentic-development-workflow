import * as core from "@actions/core";
import { conflictLabelContext } from "./lib/conflict-label-context.js";
import { clearConflictEscalation } from "./lib/conflict-resolution-labels.js";

async function run(): Promise<void> {
  const { octokit, owner, repo, issueNumber } = conflictLabelContext();
  await clearConflictEscalation(octokit, owner, repo, issueNumber);
}

run().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});

import * as core from "@actions/core";
import { conflictLabelContext } from "./lib/conflict-label-context.js";
import { removeTriggerLabel } from "./lib/conflict-resolution-labels.js";

async function run(): Promise<void> {
  const { octokit, owner, repo, issueNumber } = conflictLabelContext();
  if (!(await removeTriggerLabel(octokit, owner, repo, issueNumber))) {
    core.notice("Trigger label was already removed.");
  }
}

run().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});

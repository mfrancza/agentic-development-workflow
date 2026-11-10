import * as core from "@actions/core";
import { getOctokit } from "./lib/octokit.js";
import { reconcile, ReconciliationError, type Summary } from "./lib/dependabot-alert-issues.js";

function report(summary: Summary): void {
  core.info(`Dependabot issue reconciliation: ${JSON.stringify(summary)}`);
  if (summary.duplicates) core.warning(`Duplicate Dependabot issue identities: ${summary.duplicates}`);
  for (const [key, value] of Object.entries(summary)) core.setOutput(key, typeof value === "object" ? JSON.stringify(value) : String(value));
}

async function run(): Promise<void> {
  const reader = getOctokit(core.getInput("reader_token", { required: true }));
  const writer = getOctokit(core.getInput("writer_token", { required: true }));
  const owner = core.getInput("repo_owner", { required: true });
  const repo = core.getInput("repo_name", { required: true });
  const limit = core.getInput("max_open_prs");
  report(await reconcile({ reader, writer, contentReader: writer, owner, repo, limit }));
}

run().catch((error: unknown) => {
  if (error instanceof ReconciliationError) {
    report(error.summary);
    core.setFailed(`Dependabot issue reconciliation stopped: ${error.reason}`);
  } else {
    core.setFailed("Dependabot issue reconciliation stopped: invalid-input");
  }
});

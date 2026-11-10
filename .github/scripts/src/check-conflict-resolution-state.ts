import * as core from "@actions/core";
import { getOctokit } from "./lib/octokit.js";
import { shouldResolveConflicts } from "./lib/conflict-resolution-state.js";

async function run(): Promise<void> {
  const sender = process.env.SENDER ?? "";
  const prNumber = process.env.PR_NUMBER ?? "";
  const proceed = await shouldResolveConflicts(sender, prNumber, async (number) => {
    const [owner, repo] = (process.env.REPO ?? "").split("/");
    const token = process.env.GH_TOKEN ?? "";
    if (!owner || !repo || !token) throw new Error("Repository and GitHub token are required.");
    const response = await getOctokit(token).rest.pulls.get({ owner, repo, pull_number: number });
    return response.data.state;
  });
  if (!proceed) core.notice(`PR #${prNumber} is not open; skipping resolution.`);
  core.setOutput("proceed", String(proceed));
}

run().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});

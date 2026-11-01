import * as core from "@actions/core";
import * as github from "@actions/github";
import { rerunPublisher } from "./lib/rerun-publisher.js";

/**
 * CLI entry point for the dispatcher workflow.
 *
 * Reads GITHUB_TOKEN, REPO (owner/repo), PR_NUMBER, and
 * PUBLISHER_WORKFLOW_FILE from the environment, then calls the shared
 * rerunPublisher helper to locate the latest pull_request_target run of
 * the publisher workflow for the given PR and trigger a rerun.
 *
 * Exits 0 in all cases (same graceful-degradation posture as the
 * departed-SHA sibling step in check-protected-approval-gate.ts):
 *   - rerun-triggered → core.notice
 *   - no-prior-run    → core.warning (scheduled sweep will reconcile)
 *   - api-error       → core.warning (scheduled sweep will reconcile)
 */
export async function run(): Promise<void> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is required.");

  const rawRepo = process.env.REPO ?? "";
  const [owner, repo, ...rest] = rawRepo.split("/");
  if (!owner || !repo || rest.length > 0) throw new Error(`Invalid REPO format: "${rawRepo}". Expected "owner/name".`);

  const rawPrNumber = process.env.PR_NUMBER ?? "";
  const prNumber = Number(rawPrNumber);
  if (!Number.isSafeInteger(prNumber) || prNumber < 1) throw new Error(`Invalid PR_NUMBER: "${rawPrNumber}". Must be a positive integer.`);

  const workflowFile = process.env.PUBLISHER_WORKFLOW_FILE ?? "";
  if (!workflowFile) throw new Error("PUBLISHER_WORKFLOW_FILE is required.");

  const octokit = github.getOctokit(token);
  const result = await rerunPublisher(octokit, owner, repo, prNumber, workflowFile);

  if (result.status === "rerun-triggered") {
    core.notice(`Triggered publisher rerun (run ${result.runId}) for PR #${prNumber}.`);
  } else if (result.status === "no-prior-run") {
    core.warning(`No prior pull_request_target publisher run found for PR #${prNumber}. The scheduled reconcile sweep will reconcile it.`);
  } else {
    core.warning(`Rerun API error for PR #${prNumber}: ${result.message}. The scheduled reconcile sweep will reconcile it.`);
  }
}

run().catch(core.setFailed);

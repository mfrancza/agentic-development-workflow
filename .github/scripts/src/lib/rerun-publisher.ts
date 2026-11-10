import * as core from "@actions/core";
import type { getOctokit } from "./octokit.js";

type Octokit = ReturnType<typeof getOctokit>;

export type RerunResult =
  | { status: "rerun-triggered"; runId: number }
  | { status: "no-prior-run" }
  | { status: "api-error"; message: string };

/** Rerun the newest evaluated publisher for this PR's live head, or its newest run as a fallback. */
export async function rerunPublisher(
  octokit: Octokit, owner: string, repo: string, prNumber: number, workflowFile: string,
): Promise<RerunResult> {
  try {
    const getHead = async () => {
      const { data } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
      if (!data.head.sha) throw new Error(`Missing head SHA for PR #${prNumber}`);
      return data.head.sha;
    };
    const head = await getHead();
    // Gather all pages before sorting: equal timestamps can straddle page boundaries.
    const candidates: { id: number; created_at: string }[] = [];
    for (let page = 1; ; page++) {
      const { data } = await octokit.rest.actions.listWorkflowRuns({
        owner, repo, workflow_id: workflowFile, event: "pull_request_target", per_page: 100, page,
      });
      for (const run of data.workflow_runs) {
        if (run.head_sha === head && (run.pull_requests ?? []).some(pr => pr.number === prNumber)) {
          candidates.push(run);
        }
      }
      if (data.workflow_runs.length < 100) break;
    }
    candidates.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id);
    if (!candidates.length) return { status: "no-prior-run" };

    let selected: typeof candidates[number] | undefined;
    for (const candidate of candidates) {
      for (let page = 1; ; page++) {
        const { data } = await octokit.rest.actions.listJobsForWorkflowRun({
          owner, repo, run_id: candidate.id, filter: "all", per_page: 100, page,
        });
        if (data.jobs.some(job =>
          (job.name === "protected-approval-gate" || job.name === "protected-approval-gate (preview)") &&
          job.status === "completed" && (job.conclusion === "success" || job.conclusion === "failure"))) {
          selected = candidate;
          break;
        }
        if (data.jobs.length < 100) break;
      }
      if (selected) break;
    }
    const preferred = !!selected;
    selected ??= candidates[0];
    core.info(`Selected publisher run ${selected.id} for PR #${prNumber} on ${head}: ${preferred ? "evaluated gate job" : "fallback (no evaluated gate job found)"}.`);
    const currentHead = await getHead();
    if (currentHead !== head) throw new Error(`PR #${prNumber} head changed from ${head} to ${currentHead} during publisher selection`);
    await octokit.rest.actions.reRunWorkflow({ owner, repo, run_id: selected.id });
    return { status: "rerun-triggered", runId: selected.id };
  } catch (error) {
    return { status: "api-error", message: error instanceof Error ? error.message : String(error) };
  }
}

import type { getOctokit } from "./octokit.js";

type Octokit = ReturnType<typeof getOctokit>;

/** Structured result returned by {@link rerunPublisher}. */
export type RerunResult =
  | { status: "rerun-triggered"; runId: number }
  | { status: "no-prior-run" }
  | { status: "api-error"; message: string };

/**
 * Locates the latest `pull_request_target` run of the given publisher workflow
 * for the specified PR and triggers a rerun.
 *
 * The workflow-runs listing is sorted by `created_at` descending (GitHub API
 * default), so the first matching run found on any page is the most-recent run
 * for that PR. Pagination stops as soon as a matching run is found.
 *
 * @param octokit       Authenticated Octokit client (needs `actions: write`).
 * @param owner         Repository owner login.
 * @param repo          Repository name.
 * @param prNumber      Pull request number to search for in `pull_requests[].number`.
 * @param workflowFile  Workflow filename, e.g. "protected-approval-gate-publisher.yml".
 * @returns             A structured result: `rerun-triggered` when the rerun API succeeds,
 *                      `no-prior-run` when no `pull_request_target` run exists for this PR,
 *                      or `api-error` when the rerun API call fails.
 */
export async function rerunPublisher(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  workflowFile: string,
): Promise<RerunResult> {
  for (let page = 1; ; page++) {
    const { data } = await octokit.rest.actions.listWorkflowRuns({
      owner,
      repo,
      workflow_id: workflowFile,
      event: "pull_request_target",
      per_page: 100,
      page,
    });

    for (const run of data.workflow_runs) {
      const prNums = (run.pull_requests ?? []).map((pr) => pr.number);
      if (prNums.includes(prNumber)) {
        // First match in descending created_at order is the latest run for this PR.
        try {
          await octokit.rest.actions.reRunWorkflow({ owner, repo, run_id: run.id });
          return { status: "rerun-triggered", runId: run.id };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { status: "api-error", message };
        }
      }
    }

    if (data.workflow_runs.length < 100) {
      return { status: "no-prior-run" };
    }
  }
}

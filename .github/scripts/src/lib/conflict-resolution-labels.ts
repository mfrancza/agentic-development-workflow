import type { getOctokit } from "./octokit.js";

type Octokit = ReturnType<typeof getOctokit>;

const escalationLabel = "conflicts-escalated";
const triggerLabel = "agent:resolve-conflicts";

export async function clearConflictEscalation(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<void> {
  const params = { owner, repo, issue_number: issueNumber };
  const labels = await octokit.paginate(octokit.rest.issues.listLabelsOnIssue, { ...params, per_page: 100 });
  if (!labels.some((label) => label.name === escalationLabel)) return;

  await octokit.rest.issues.removeLabel({ ...params, name: escalationLabel });
  await octokit.rest.issues.createComment({
    ...params,
    body: "Operator re-attempted resolution via `agent:resolve-conflicts`; prior escalation marker removed.",
  });
}

export async function removeTriggerLabel(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<boolean> {
  const params = { owner, repo, issue_number: issueNumber };
  try {
    await octokit.rest.issues.removeLabel({ ...params, name: triggerLabel });
    return true;
  } catch (error: unknown) {
    if (typeof error !== "object" || error === null || !("status" in error) || error.status !== 404) throw error;
    const labels = await octokit.paginate(octokit.rest.issues.listLabelsOnIssue, { ...params, per_page: 100 });
    if (labels.some((label) => label.name === triggerLabel)) {
      throw new Error("Trigger label is still present after the failed removal.", { cause: error });
    }
    return false;
  }
}

import { getOctokit } from "./octokit.js";

export function conflictLabelContext() {
  const [owner, repo, extra] = (process.env.REPO ?? "").split("/");
  const token = process.env.GH_TOKEN ?? "";
  const value = process.env.PR_NUMBER ?? "";
  const issueNumber = Number(value);
  if (!owner || !repo || extra !== undefined || !token || !/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(issueNumber)) {
    throw new Error("Repository, GitHub token, and valid PR number are required.");
  }
  return { octokit: getOctokit(token), owner, repo, issueNumber };
}

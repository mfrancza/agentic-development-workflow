import * as core from "@actions/core";
import * as github from "@actions/github";

const OPINIONATED_STATES = new Set(["APPROVED", "CHANGES_REQUESTED", "DISMISSED"]);
type Octokit = ReturnType<typeof github.getOctokit>;

export interface Review { userLogin: string | null; state: string; }
export interface ApprovalResult { conclusion: "success" | "failure"; summary: string; }
interface Candidate { number: number; author: string; headSha: string; state: string; }
interface Config { protectedAuthors: Set<string>; requiredApprovals: number; }

/** Applies GitHub's latest-opinionated-review semantics. */
export function evaluateApprovals(reviews: Review[], prAuthor: string, requiredApprovals: number): ApprovalResult {
  const latestByReviewer = new Map<string, string>();
  for (const review of reviews) {
    if (review.userLogin !== null && OPINIONATED_STATES.has(review.state)) latestByReviewer.set(review.userLogin, review.state);
  }
  const approvals = [...latestByReviewer].filter(([reviewer, state]) => reviewer !== prAuthor && state === "APPROVED").length;
  const conclusion = approvals >= requiredApprovals ? "success" : "failure";
  return { conclusion, summary: conclusion === "success"
    ? `Pull request has ${approvals} qualifying approval(s); ${requiredApprovals} required.`
    : `Pull request has ${approvals} qualifying approval(s); ${requiredApprovals} required before it can merge.` };
}

export async function fetchReviews(octokit: Octokit, owner: string, repo: string, prNumber: number): Promise<Review[]> {
  const reviews: Review[] = [];
  for (let page = 1; ; page += 1) {
    const { data } = await octokit.rest.pulls.listReviews({ owner, repo, pull_number: prNumber, per_page: 100, page });
    reviews.push(...data.map(review => ({ userLogin: review.user?.login ?? null, state: review.state })));
    if (data.length < 100) return reviews;
  }
}

function splitRepository(repository: string): [string, string] {
  const [owner, repo, ...rest] = repository.split("/");
  if (!owner || !repo || rest.length > 0) throw new Error(`Invalid repo format: "${repository}". Expected "owner/name".`);
  return [owner, repo];
}

// Fixed context name. Stale results from an earlier ON interval are replaced by
// the backfill on enable and by the reconcile sweep (see Decision 7).
const CHECK_NAME = "protected-approval-gate";

function checkName(preview: boolean): string {
  return `${CHECK_NAME}${preview ? " (preview)" : ""}`;
}

function parseConfig(): Config {
  const rawAuthors = core.getInput("protected_pr_author_logins", { required: true });
  const rawCount = core.getInput("required_approval_count", { required: true }).trim();
  let authors: unknown;
  try { authors = JSON.parse(rawAuthors); } catch { throw new Error("protected-pr-author-logins must be valid JSON."); }
  if (!Array.isArray(authors) || authors.length === 0 || authors.some(author => typeof author !== "string" || author.trim() === "")) {
    throw new Error("protected-pr-author-logins must be a non-empty JSON array of non-empty strings.");
  }
  const normalized = authors.map(author => author.trim());
  if (new Set(normalized).size !== normalized.length) throw new Error("protected-pr-author-logins must not contain duplicate logins.");
  if (!/^\d+$/.test(rawCount) || Number(rawCount) < 1 || !Number.isSafeInteger(Number(rawCount))) throw new Error("required-approval-count must be a positive integer.");
  return { protectedAuthors: new Set(normalized), requiredApprovals: Number(rawCount) };
}

async function publishResult(octokit: Octokit, owner: string, repo: string, headSha: string, name: string, result: ApprovalResult): Promise<void> {
  await octokit.rest.checks.create({ owner, repo, name, head_sha: headSha, status: "completed", conclusion: result.conclusion, output: { title: name, summary: result.summary } });
}

async function listCandidates(octokit: Octokit, owner: string, repo: string, headSha: string, excludedPr?: number): Promise<number[]> {
  const candidates: number[] = [];
  for (let page = 1; ; page += 1) {
    const { data } = await octokit.rest.pulls.list({ owner, repo, state: "open", per_page: 100, page });
    candidates.push(...data.filter(pr => pr.head.sha === headSha && pr.number !== excludedPr).map(pr => pr.number));
    if (data.length < 100) return candidates;
  }
}

async function evaluateSha(octokit: Octokit, owner: string, repo: string, headSha: string, config: Config, excludedPr?: number): Promise<ApprovalResult | null> {
  const numbers = await listCandidates(octokit, owner, repo, headSha, excludedPr);
  if (numbers.length === 0) return null;
  const results: string[] = [];
  let failed = false;
  for (const number of numbers) {
    const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: number });
    const candidate: Candidate = { number, author: pr.user?.login ?? "", headSha: pr.head.sha, state: pr.state };
    if (candidate.state !== "open" || candidate.headSha !== headSha) continue;
    let result: ApprovalResult;
    if (config.protectedAuthors.has(candidate.author)) result = evaluateApprovals(await fetchReviews(octokit, owner, repo, candidate.number), candidate.author, config.requiredApprovals);
    else result = { conclusion: "success", summary: `Pull request author ${candidate.author} is not protected.` };
    failed ||= result.conclusion === "failure";
    results.push(`#${candidate.number}: ${result.conclusion}`);
  }
  return { conclusion: failed ? "failure" : "success", summary: `Shared SHA candidates: ${results.join(", ") || "none"}.` };
}

async function publishFailure(octokit: Octokit, owner: string, repo: string, sha: string, name: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  core.error(message);
  await publishResult(octokit, owner, repo, sha, name, { conclusion: "failure", summary: `Unable to evaluate all pull requests sharing this SHA: ${message}` });
}

export async function run(): Promise<void> {
  const enabled = core.getInput("enabled", { required: true }).trim() === "true";
  const prNumber = Number(core.getInput("pr_number", { required: true }));
  const [owner, repo] = splitRepository(core.getInput("repo", { required: true }));
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is required to list pull requests and publish the check run.");
  if (!Number.isSafeInteger(prNumber) || prNumber < 1) throw new Error("pr-number must be a positive integer.");
  const octokit = github.getOctokit(token);
  let config: Config;
  try { config = parseConfig(); } catch (error) {
    const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
    if (enabled) await publishFailure(octokit, owner, repo, pr.head.sha, checkName(false), error);
    else core.error(error instanceof Error ? error.message : String(error));
    if (enabled) throw error;
    return;
  }
  const { data: triggeringPr } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
  const liveHeadSha = triggeringPr.head.sha;
  const name = checkName(!enabled);
  try {
    const result = await evaluateSha(octokit, owner, repo, liveHeadSha, config);
    if (result) await publishResult(octokit, owner, repo, liveHeadSha, name, result);
  } catch (error) {
    await publishFailure(octokit, owner, repo, liveHeadSha, name, error);
    throw error;
  }
  const departedSha = core.getInput("departed_sha").trim();
  const departedNumber = Number(core.getInput("departed_pr_number").trim()) || undefined;
  if (enabled && departedSha && !(departedSha === liveHeadSha && triggeringPr.state === "open")) {
    try {
      const result = await evaluateSha(octokit, owner, repo, departedSha, config, departedNumber);
      if (result) await publishResult(octokit, owner, repo, departedSha, checkName(false), result);
    } catch (error) {
      await publishFailure(octokit, owner, repo, departedSha, checkName(false), error);
      throw error;
    }
  }
}

run().catch(core.setFailed);

import * as core from "@actions/core";
import * as github from "@actions/github";
import { expandTeamRefs } from "./lib/expand-team-refs.js";

const OPINIONATED_STATES = new Set(["APPROVED", "CHANGES_REQUESTED", "DISMISSED"]);
type Octokit = ReturnType<typeof github.getOctokit>;

export interface Review { userLogin: string | null; state: string; }
export interface ApprovalResult { conclusion: "success" | "failure"; summary: string; }
interface Candidate { number: number; author: string; headSha: string; state: string; }
interface Config { protectedAuthors: Set<string>; requiredApprovals: number; reviewerEntries: string[]; }

/**
 * Whose approvals count toward the threshold: any non-author reviewer (empty
 * PROTECTED_APPROVAL_REVIEWERS), only the listed logins and team members, or
 * nobody because the list could not be resolved (fail closed).
 */
export type QualifyingReviewers =
  | { kind: "any" }
  | { kind: "listed"; logins: Set<string> }
  | { kind: "unresolved"; message: string };

const TEAM_REF = /^[^/]+\/[^/]+$/;

/** Applies GitHub's latest-opinionated-review semantics. */
export function evaluateApprovals(reviews: Review[], prAuthor: string, requiredApprovals: number, qualifying?: Set<string>): ApprovalResult {
  const latestByReviewer = new Map<string, string>();
  for (const review of reviews) {
    if (review.userLogin !== null && OPINIONATED_STATES.has(review.state)) latestByReviewer.set(review.userLogin, review.state);
  }
  const approvals = [...latestByReviewer].filter(([reviewer, state]) =>
    reviewer !== prAuthor && state === "APPROVED" && (qualifying === undefined || qualifying.has(reviewer.toLowerCase()))).length;
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
  return { protectedAuthors: new Set(normalized), requiredApprovals: Number(rawCount), reviewerEntries: parseReviewerEntries() };
}

/** Parses PROTECTED_APPROVAL_REVIEWERS; empty or unset means any non-author reviewer counts. */
function parseReviewerEntries(): string[] {
  const raw = core.getInput("qualifying_reviewers").trim();
  if (raw === "") return [];
  let entries: unknown;
  try { entries = JSON.parse(raw); } catch { throw new Error("qualifying-reviewers must be valid JSON."); }
  if (!Array.isArray(entries) || entries.some(entry => typeof entry !== "string" || entry.trim() === "")) {
    throw new Error("qualifying-reviewers must be a JSON array of non-empty strings.");
  }
  const normalized = entries.map(entry => entry.trim());
  const malformed = normalized.filter(entry => entry.includes("/") && !TEAM_REF.test(entry));
  if (malformed.length > 0) throw new Error(`qualifying-reviewers entries must be logins or <org>/<team-slug>: ${malformed.join(", ")}.`);
  if (new Set(normalized.map(entry => entry.toLowerCase())).size !== normalized.length) throw new Error("qualifying-reviewers must not contain duplicate entries.");
  return normalized;
}

/**
 * Resolves the configured reviewer entries to a login set. Team references are
 * expanded with the allowlist-resolver token for the repository owner's
 * organization only; a missing token or any lookup failure yields
 * "unresolved" so protected PRs fail rather than counting everyone.
 */
export async function resolveQualifyingReviewers(entries: string[], owner: string, resolverToken: string): Promise<QualifyingReviewers> {
  if (entries.length === 0) return { kind: "any" };
  const teams = entries.filter(entry => entry.includes("/"));
  if (teams.length === 0) return { kind: "listed", logins: new Set(entries.map(entry => entry.toLowerCase())) };
  if (resolverToken === "") {
    return { kind: "unresolved", message: `qualifying-reviewers contains team reference(s) ${teams.join(", ")} but no allowlist-resolver token was provided (set ALLOWLIST_RESOLVER_APP_ID and ALLOWLIST_RESOLVER_APP_PRIVATE_KEY).` };
  }
  const { expanded, errors } = await expandTeamRefs(entries, github.getOctokit(resolverToken), { supportedOrg: owner });
  if (errors.length > 0) {
    return { kind: "unresolved", message: `qualifying-reviewers could not be resolved: ${errors.map(error => `${error.entry} (${error.message ?? error.reason})`).join("; ")}.` };
  }
  return { kind: "listed", logins: new Set(expanded.map(login => login.toLowerCase())) };
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

async function evaluateSha(octokit: Octokit, owner: string, repo: string, headSha: string, config: Config, reviewers: QualifyingReviewers, excludedPr?: number): Promise<ApprovalResult | null> {
  const numbers = await listCandidates(octokit, owner, repo, headSha, excludedPr);
  if (numbers.length === 0) return null;
  const results: string[] = [];
  let failed = false;
  for (const number of numbers) {
    const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: number });
    const candidate: Candidate = { number, author: pr.user?.login ?? "", headSha: pr.head.sha, state: pr.state };
    if (candidate.state !== "open" || candidate.headSha !== headSha) continue;
    let result: ApprovalResult;
    if (!config.protectedAuthors.has(candidate.author)) result = { conclusion: "success", summary: `Pull request author ${candidate.author} is not protected.` };
    else if (reviewers.kind === "unresolved") result = { conclusion: "failure", summary: `Cannot count approvals: ${reviewers.message}` };
    else result = evaluateApprovals(await fetchReviews(octokit, owner, repo, candidate.number), candidate.author, config.requiredApprovals, reviewers.kind === "listed" ? reviewers.logins : undefined);
    failed ||= result.conclusion === "failure";
    results.push(`#${candidate.number}: ${result.conclusion} — ${result.summary}`);
  }
  return { conclusion: failed ? "failure" : "success", summary: `Shared SHA candidates:\n${results.map(line => `- ${line}`).join("\n") || "none"}` };
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
  const reviewers = await resolveQualifyingReviewers(config.reviewerEntries, owner, core.getInput("resolver_token").trim());
  if (reviewers.kind === "unresolved") core.error(reviewers.message);
  const { data: triggeringPr } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
  const liveHeadSha = triggeringPr.head.sha;
  const name = checkName(!enabled);
  try {
    const result = await evaluateSha(octokit, owner, repo, liveHeadSha, config, reviewers);
    if (result) await publishResult(octokit, owner, repo, liveHeadSha, name, result);
  } catch (error) {
    await publishFailure(octokit, owner, repo, liveHeadSha, name, error);
    throw error;
  }
  const departedSha = core.getInput("departed_sha").trim();
  const departedNumber = Number(core.getInput("departed_pr_number").trim()) || undefined;
  if (enabled && departedSha && !(departedSha === liveHeadSha && triggeringPr.state === "open")) {
    try {
      const result = await evaluateSha(octokit, owner, repo, departedSha, config, reviewers, departedNumber);
      if (result) await publishResult(octokit, owner, repo, departedSha, checkName(false), result);
    } catch (error) {
      await publishFailure(octokit, owner, repo, departedSha, checkName(false), error);
      throw error;
    }
  }
}

run().catch(core.setFailed);

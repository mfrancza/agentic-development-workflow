import * as core from "@actions/core";
import { fileURLToPath } from "node:url";
import { checkReviewerFeedback, makeInlineCommentCounter, makeUnresolvedThreadCounter } from "./lib/check-reviewer-feedback.js";
import { expandTeamRefs } from "./lib/expand-team-refs.js";
import { getOctokit } from "./lib/octokit.js";

export const DEFAULT_REVIEWERS = ["mfrancza-reviewer-agent[bot]", "Copilot", "copilot-pull-request-reviewer[bot]", "github-copilot[bot]"];
const SUBMITTED_STATES = new Set(["APPROVED", "COMMENTED", "CHANGES_REQUESTED", "DISMISSED"]);

export interface Review {
  id: number;
  state: string;
  submitted_at?: string | null;
  commit_id: string | null;
  user: { login: string; type?: string } | null;
  body?: string | null;
  html_url?: string;
}
export interface Event {
  id: number;
  event: string;
  created_at: string;
  actor: { type?: string } | null;
  label?: { name?: string | null } | null;
}
export interface Epoch { id: string; at: string | null }
export interface Pull {
  state: string;
  head: string;
  author: string;
  authorType: string;
  labels: string[];
  assignees: string[];
  url: string;
}
export interface Thread { path: string; url: string }
export interface Comment { id: number; author: string; body: string }
export interface Dependencies {
  getPull(): Promise<Pull>;
  getReview(): Promise<Review>;
  listEvents(): Promise<Event[]>;
  listReviews(): Promise<Review[]>;
  feedback(pull: Pull, review: Review): Promise<{ proceed: boolean; reason: string }>;
  addLabel(): Promise<void>;
  assign(pull: Pull): Promise<string[]>;
  threads(): Promise<Thread[]>;
  listComments(): Promise<Comment[]>;
  createComment(body: string): Promise<void>;
  updateComment(id: number, body: string): Promise<void>;
  warn(message: string): void;
}
export interface Result { proceed: boolean; reason: string; limit: number; count?: number; epoch?: Epoch }

export function parseLimit(value: string): number {
  const text = value.trim();
  if (!text) return 8;
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text))) throw new Error("max-review-rounds must be a non-negative safe decimal integer");
  return Number(text);
}

export function parseLogins(value: string, fallback: string[]): string[] {
  if (!value.trim()) return fallback;
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((entry: unknown) => typeof entry !== "string" || !entry.trim())) throw new Error("Expected a JSON array of non-empty login strings");
  return parsed.map((entry: string) => entry.trim());
}

function timestamp(value: string | null | undefined, description: string): number {
  if (!value || !Number.isFinite(Date.parse(value))) throw new Error(`Missing or invalid ${description} timestamp`);
  return Date.parse(value);
}

export function findEpoch(events: Event[]): Epoch {
  if (events.some((event) => event.event === "unlabeled" && !event.label?.name)) throw new Error("Cannot determine removed label for issue event");
  if (events.some((event) => event.event === "unlabeled" && event.label?.name?.toLowerCase() === "human-required" && !event.actor?.type)) throw new Error("Cannot determine reset event actor type");
  const resets = events.filter((event) => event.event === "unlabeled" && event.label?.name?.toLowerCase() === "human-required" && event.actor?.type === "User");
  for (const event of resets) {
    timestamp(event.created_at, "reset");
    if (!Number.isSafeInteger(event.id) || event.id <= 0) throw new Error("Invalid reset event ID");
  }
  resets.sort((left, right) => timestamp(right.created_at, "reset") - timestamp(left.created_at, "reset") || right.id - left.id);
  return resets.length ? { id: String(resets[0].id), at: resets[0].created_at } : { id: "initial", at: null };
}

export function countRounds(reviews: Review[], reviewers: string[], author: string, epoch: Epoch): number {
  const allowed = new Set(reviewers.map((login) => login.toLowerCase()));
  const shas = new Set<string>();
  for (const review of reviews) {
    if (SUBMITTED_STATES.has(review.state.toUpperCase()) && !review.user?.login) throw new Error(`Submitted review ${review.id} has no author`);
    const login = review.user?.login?.toLowerCase();
    if (!login || login === author.toLowerCase() || !allowed.has(login) || !SUBMITTED_STATES.has(review.state.toUpperCase())) continue;
    const submitted = timestamp(review.submitted_at, "review submission");
    if (epoch.at && submitted <= timestamp(epoch.at, "reset")) continue;
    if (!review.commit_id?.trim()) throw new Error(`Eligible review ${review.id} has no commit SHA`);
    shas.add(review.commit_id.toLowerCase());
  }
  return shas.size;
}

export function formatSummary(threads: Thread[], reviewUrl: string, state: string): string {
  if (!threads.length) return state.toUpperCase() === "CHANGES_REQUESTED" ? "No unresolved threads; the review requested top-level changes." : "No unresolved threads.";
  const links = threads.slice(0, 20).map((thread) => `- [${thread.path.replace(/[\[\]`\n\r]/g, " ").slice(0, 200)}](${thread.url || reviewUrl})`);
  if (threads.length > 20) links.push(`- ${threads.length - 20} additional thread(s) omitted.`);
  return `${threads.length} unresolved thread(s):\n${links.join("\n")}`;
}

export async function checkReviewRoundLimit(input: { limit: number; reviewers: string[]; runUrl: string }, deps: Dependencies): Promise<Result> {
  const result = (reason: string, proceed: boolean, epoch?: Epoch, count?: number): Result => ({ proceed, reason, limit: input.limit, epoch, count });
  for (let attempt = 0; attempt < 2; attempt++) {
    const pull = await deps.getPull();
    if (pull.state !== "open") return result("PR is not open; skipping.", false);
    if (!pull.head || !pull.author) throw new Error("Live PR head or author is missing");
    const review = await deps.getReview();
    timestamp(review.submitted_at, "triggering review submission");
    if (!review.user?.login || !SUBMITTED_STATES.has(review.state.toUpperCase())) throw new Error("Triggering review is missing its author or submitted state");
    if (review.user.login.toLowerCase() === pull.author.toLowerCase()) return result("Triggering review is by the PR author; skipping.", false);
    const feedback = await deps.feedback(pull, review);
    if (!feedback.proceed) return result(feedback.reason, false);
    const epoch = findEpoch(await deps.listEvents());
    if (epoch.at && timestamp(review.submitted_at, "triggering review submission") <= timestamp(epoch.at, "reset")) return result("Triggering review predates the latest human reset; obtain a fresh review.", false, epoch);
    let count: number | undefined;
    if (input.limit !== 0) {
      const reviews = await deps.listReviews();
      if (input.reviewers.some((login) => login.toLowerCase() === review.user?.login.toLowerCase()) && !reviews.some((entry) => entry.id === review.id)) throw new Error("Triggering automated review missing from review history");
      count = countRounds(reviews, input.reviewers, pull.author, epoch);
    }
    const currentFeedback = await deps.feedback(pull, review);
    if (!currentFeedback.proceed) return result(currentFeedback.reason, false, epoch, count);
    const latest = await deps.getPull();
    if (latest.state !== "open" || latest.head !== pull.head || latest.author.toLowerCase() !== pull.author.toLowerCase()) return result("PR state, head, or author changed during accounting; skipping stale event.", false, epoch, count);
    const latestEpoch = findEpoch(await deps.listEvents());
    const paused = (value: Pull): boolean => value.labels.some((label) => label.toLowerCase() === "human-required");
    if (latestEpoch.id !== epoch.id || latestEpoch.at !== epoch.at || paused(latest) !== paused(pull)) {
      if (attempt === 0) continue;
      throw new Error("Pause label or reset epoch changed repeatedly during accounting");
    }
    const reached = input.limit > 0 && count !== undefined && count >= input.limit;
    const pauseReason = `human-required label ${paused(latest) ? "already present" : "not present"}; numerical threshold ${input.limit === 0 ? "disabled" : reached ? "reached" : "not reached"}. Resolve the original escalation, remove the label, and obtain a fresh authorized review.`;
    if (!reached) return paused(latest) ? result(pauseReason, false, epoch, count) : result("Actionable feedback is below the review-round limit.", true, epoch, count);
    if (latest.authorType !== "Bot") throw new Error("Cannot deduplicate escalation: PR author is not a bot");
    if (!paused(latest)) await deps.addLabel();
    let assignmentWarnings: string[];
    try { assignmentWarnings = await deps.assign(latest); } catch (error) { assignmentWarnings = [`Assignment failed: ${String(error)}`]; }
    for (const warning of assignmentWarnings) deps.warn(warning);
    let summary: string;
    try { summary = formatSummary(await deps.threads(), latest.url, review.state); }
    catch (error) { summary = `Unresolved thread summary unavailable; see ${latest.url}/files.`; deps.warn(`Thread summary unavailable: ${String(error)}`); }
    const marker = `<!-- review-round-limit:v1 epoch=${epoch.id} -->`;
    const body = `${marker}\n## Review-round limit reached\n\nReviewed commits: ${count}; limit: ${input.limit}. Epoch: ${epoch.id}${epoch.at ? ` (reset at ${epoch.at}; equal timestamps remain in the prior epoch)` : " (PR creation)"}.\n\nHead: ${latest.head}\nTriggering review: ${review.html_url || latest.url}\nWorkflow run: ${input.runUrl || "unavailable"}\n\n${summary}\n\n${assignmentWarnings.length ? `Routing warnings: ${assignmentWarnings.join("; ")}\n\n` : ""}${pauseReason}`;
    const existing = (await deps.listComments()).find((comment) => comment.author.toLowerCase() === latest.author.toLowerCase() && comment.body.includes(marker));
    if (existing) await deps.updateComment(existing.id, body); else await deps.createComment(body);
    return result(pauseReason, false, epoch, count);
  }
  throw new Error("Unable to establish a stable review-round epoch");
}

type Client = ReturnType<typeof getOctokit>;
interface ThreadPage {
  repository: { pullRequest: { reviewThreads: {
    nodes: Array<{ isResolved: boolean; path: string; comments: { nodes: Array<{ url: string }> } }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  } } };
}

export function makeDependencies(options: {
  octokit: Client; resolver?: Client; owner: string; repo: string; prNumber: number; reviewId: number;
  assignees: string[];
}): Dependencies {
  const { octokit, resolver, owner, repo, prNumber, reviewId } = options;
  const issue = { owner, repo, issue_number: prNumber };
  const pull = { owner, repo, pull_number: prNumber };
  return {
    async getPull() {
      const { data } = await octokit.rest.pulls.get(pull);
      return { state: data.state, head: data.head.sha, author: data.user?.login ?? "", authorType: data.user?.type ?? "", labels: data.labels.map((label) => label.name), assignees: (data.assignees ?? []).map((assignee) => assignee.login), url: data.html_url };
    },
    async getReview() { return (await octokit.rest.pulls.getReview({ ...pull, review_id: reviewId })).data; },
    async listEvents() { return await octokit.paginate(octokit.rest.issues.listEvents, { ...issue, per_page: 100 }) as Event[]; },
    async listReviews() { return await octokit.paginate(octokit.rest.pulls.listReviews, { ...pull, per_page: 100 }); },
    async feedback(current, review) {
      return checkReviewerFeedback({ state: review.state, body: review.body ?? "", reviewId, prNumber, owner, repo, reviewAuthor: review.user?.login ?? "", prAuthor: current.author, headSha: current.head, reviewCommitId: review.commit_id ?? "" }, {
        getPrState: async () => current.state,
        countUnresolvedThreads: makeUnresolvedThreadCounter(octokit, owner, repo, prNumber),
        countInlineComments: makeInlineCommentCounter(octokit, owner, repo, prNumber, reviewId),
      });
    },
    async addLabel() { await octokit.rest.issues.addLabels({ ...issue, labels: ["human-required"] }); },
    async assign(current) {
      const warnings: string[] = [];
      const explicit = options.assignees.filter((entry) => !entry.includes("/"));
      const teams = options.assignees.filter((entry) => entry.includes("/"));
      let candidates = explicit;
      if (teams.length && !resolver) warnings.push(`Team expansion unavailable without resolver token: ${teams.join(", ")}`);
      else if (teams.length && resolver) {
        const expansion = await expandTeamRefs(teams, resolver, { supportedOrg: owner });
        candidates = candidates.concat(expansion.expanded);
        warnings.push(...expansion.errors.map((error) => `Team ${error.entry}: ${error.reason}${error.message ? ` (${error.message})` : ""}`));
      }
      if (!options.assignees.length) warnings.push("No escalation assignees configured; configure escalation-assignee or admin-assignees");
      const seen = new Set(current.assignees.map((login) => login.toLowerCase()));
      let capacity = Math.max(0, 10 - seen.size);
      for (const candidate of candidates) {
        if (seen.has(candidate.toLowerCase())) continue;
        seen.add(candidate.toLowerCase());
        if (!capacity) { warnings.push(`Assignee capacity exceeded: ${candidate}`); continue; }
        try {
          await octokit.rest.issues.checkUserCanBeAssigned({ owner, repo, assignee: candidate });
          await octokit.rest.issues.addAssignees({ ...issue, assignees: [candidate] });
          capacity--;
        } catch (error) { warnings.push(`Unable to assign ${candidate}: ${String(error)}`); }
      }
      return warnings;
    },
    async threads() {
      const unresolved: Thread[] = [];
      let cursor: string | null = null;
      do {
        const page: ThreadPage = await octokit.graphql<ThreadPage>(`query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
          repository(owner: $owner, name: $name) { pullRequest(number: $number) {
            reviewThreads(first: 100, after: $cursor) { nodes { isResolved path comments(first: 1) { nodes { url } } } pageInfo { hasNextPage endCursor } }
          } }
        }`, { owner, name: repo, number: prNumber, cursor });
        const connection = page.repository.pullRequest.reviewThreads;
        unresolved.push(...connection.nodes.filter((thread) => !thread.isResolved).map((thread) => ({ path: thread.path, url: thread.comments.nodes[0]?.url ?? "" })));
        if (connection.pageInfo.hasNextPage && (!connection.pageInfo.endCursor || connection.pageInfo.endCursor === cursor)) throw new Error("Invalid review thread pagination cursor");
        cursor = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
      } while (cursor);
      return unresolved;
    },
    async listComments() {
      const comments = await octokit.paginate(octokit.rest.issues.listComments, { ...issue, per_page: 100 });
      return comments.map((comment) => ({ id: comment.id, author: comment.user?.login ?? "", body: comment.body ?? "" }));
    },
    async createComment(body) { await octokit.rest.issues.createComment({ ...issue, body }); },
    async updateComment(comment_id, body) { await octokit.rest.issues.updateComment({ owner, repo, comment_id, body }); },
    warn: core.warning,
  };
}

async function run(): Promise<void> {
  const owner = core.getInput("repo_owner", { required: true });
  const repo = core.getInput("repo_name", { required: true });
  const prNumber = Number(core.getInput("pr_number", { required: true }));
  const reviewId = Number(core.getInput("review_id", { required: true }));
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0 || !Number.isSafeInteger(reviewId) || reviewId <= 0) throw new Error("PR number and review ID must be positive safe integers");
  const octokit = getOctokit(core.getInput("token", { required: true }));
  const resolverToken = core.getInput("resolver_token");
  const explicit = core.getInput("escalation_assignee").trim();
  const admins = parseLogins(core.getInput("admin_assignees"), []);
  const result = await checkReviewRoundLimit({ limit: parseLimit(core.getInput("max_review_rounds")), reviewers: parseLogins(core.getInput("reviewer_logins"), DEFAULT_REVIEWERS), runUrl: core.getInput("run_url") || (process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : "") }, makeDependencies({ octokit, resolver: resolverToken ? getOctokit(resolverToken) : undefined, owner, repo, prNumber, reviewId, assignees: [...(explicit ? [explicit] : []), ...admins] }));
  core.info(result.reason);
  core.setOutput("proceed", String(result.proceed));
  core.setOutput("limit", String(result.limit));
  core.setOutput("round-count", result.count === undefined ? "" : String(result.count));
  core.setOutput("epoch", result.epoch?.id ?? "");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  run().catch((error: unknown) => core.setFailed(error instanceof Error ? error.message : String(error)));
}

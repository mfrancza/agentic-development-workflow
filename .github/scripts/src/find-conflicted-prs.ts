import * as core from "@actions/core";
import { getOctokit } from "./lib/octokit.js";

type OctokitType = ReturnType<typeof getOctokit>;

export type MergeableState = "CONFLICTING" | "MERGEABLE" | "UNKNOWN";

/**
 * Exponential backoff delays in seconds, matching the shell implementation:
 *   DELAYS=(5 10 20 40 80)
 * Polls up to 5 times; sleeps between attempts but not after the last one.
 * Maximum cumulative wait: 5 + 10 + 20 + 40 = 75 s (the 80 s slot is only
 * reached on the final attempt, after which the loop ends without sleeping).
 */
export const DEFAULT_DELAYS: readonly number[] = [5, 10, 20, 40, 80];

/** Maximum number of REST Pulls API pages to scan during enumeration. */
export const MAX_SCAN_PAGES = 50;

/** Maximum number of in-scope PR candidates to collect during enumeration. */
export const MAX_CANDIDATES = 100;

/** Production sleep: real timer. Injected so tests can replace it. */
export function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Interface for a rate-limit guard. Implementations reserve `count` slots
 * in a sliding-window budget before the caller issues API requests.
 */
export interface RateLimitGuard {
  acquire(count: number, sleep: (ms: number) => Promise<void>): Promise<void>;
}

/**
 * Real rate limiter implementing a 30-request-per-minute sliding window.
 * Callers acquire slots before each batch of API requests; if the window is
 * full, acquire() sleeps until enough capacity opens up.
 */
export class RateLimiter implements RateLimitGuard {
  private timestamps: number[] = [];
  private readonly maxPerMin: number;
  private readonly windowMs: number;

  constructor(maxPerMin = 30, windowMs = 60_000) {
    this.maxPerMin = maxPerMin;
    this.windowMs = windowMs;
  }

  async acquire(count: number, sleep: (ms: number) => Promise<void>): Promise<void> {
    while (true) {
      const now = Date.now();
      const cutoff = now - this.windowMs;
      let i = 0;
      while (i < this.timestamps.length && this.timestamps[i]! <= cutoff) i++;
      if (i > 0) this.timestamps.splice(0, i);

      if (this.timestamps.length + count <= this.maxPerMin) {
        const ts = Date.now();
        for (let j = 0; j < count; j++) this.timestamps.push(ts);
        return;
      }

      const oldest = this.timestamps[0]!;
      const waitMs = oldest + this.windowMs - Date.now() + 1;
      await sleep(Math.max(waitMs, 100));
    }
  }
}

/**
 * No-op rate limiter for tests: never blocks, never sleeps.
 */
export const noopRateLimiter: RateLimitGuard = {
  acquire: async () => {},
};

/**
 * Validates the optional pr_number input from workflow_dispatch.
 * Strips CR/LF (output-injection hygiene) then enforces the same regex as
 * the shell: ^[1-9][0-9]*$ — a positive integer with no leading zeros.
 *
 * @returns The parsed PR number, or null if the input was empty.
 * @throws  A descriptive Error if the format is invalid.
 */
export function validatePrNumberInput(input: string): number | null {
  const trimmed = input.replace(/[\r\n]/g, "");
  if (!trimmed) return null;
  if (!/^[1-9][0-9]*$/.test(trimmed)) {
    throw new Error(
      `pr_number must be a positive integer with no leading zeros; got '${trimmed}'`
    );
  }
  return parseInt(trimmed, 10);
}

/**
 * Validates the RESOLVE_CONFLICTS_AUTHOR_ALLOWLIST env var value.
 * Throws with descriptive message on any violation (which becomes ::error::
 * via core.setFailed in run()).
 *
 * Rules:
 *   1. Must be valid JSON
 *   2. Must be an array
 *   3. All entries must be non-empty strings
 *   4. Wildcard "*" may only appear as the sole entry
 *   5. No duplicate entries (case-insensitive)
 *
 * @returns The parsed string array.
 * @throws  A descriptive Error on any rule violation.
 */
export function validateAuthorAllowlist(input: string): string[] {
  // Rule 1: valid JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new Error(
      `RESOLVE_CONFLICTS_AUTHOR_ALLOWLIST is not valid JSON: ${input}`
    );
  }

  // Rule 2: array type
  if (!Array.isArray(parsed)) {
    throw new Error(
      `RESOLVE_CONFLICTS_AUTHOR_ALLOWLIST must be a JSON array`
    );
  }

  // Rule 3: non-empty string entries
  for (let i = 0; i < parsed.length; i++) {
    if (typeof parsed[i] !== "string" || parsed[i] === "") {
      throw new Error(
        `RESOLVE_CONFLICTS_AUTHOR_ALLOWLIST contains a non-string or empty-string entry at index ${i}`
      );
    }
  }

  const arr = parsed as string[];

  // Rule 4: wildcard as sole entry
  if (arr.includes("*") && arr.length > 1) {
    throw new Error(
      `RESOLVE_CONFLICTS_AUTHOR_ALLOWLIST: wildcard "*" may only appear as the sole entry; remove other logins or use ["*"] alone to sweep all authors`
    );
  }

  // Rule 5: no duplicates (case-insensitive)
  const seen = new Set<string>();
  const dupes: string[] = [];
  for (const s of arr) {
    const lower = s.toLowerCase();
    if (seen.has(lower)) {
      if (!dupes.includes(lower)) dupes.push(lower);
    } else {
      seen.add(lower);
    }
  }
  if (dupes.length > 0) {
    throw new Error(
      `RESOLVE_CONFLICTS_AUTHOR_ALLOWLIST contains duplicate entries: ${dupes.join(", ")}`
    );
  }

  return arr;
}

/**
 * Polls a PR's mergeability with exponential backoff until GitHub's async
 * computation settles or the retry limit is exhausted.
 *
 * Matches the shell loop exactly: polls `delays.length` times, sleeping
 * between attempts but not after the last one. API errors are treated as
 * UNKNOWN (matching `2>/dev/null || echo "UNKNOWN"`).
 */
export async function pollMergeability(
  octokit: OctokitType,
  owner: string,
  name: string,
  prNumber: number,
  delays: readonly number[],
  sleep: (ms: number) => Promise<void>
): Promise<MergeableState> {
  let mergeable: MergeableState = "UNKNOWN";

  for (let i = 0; i < delays.length; i++) {
    const attempt = i + 1;
    try {
      const result = await octokit.graphql<{
        repository: { pullRequest: { mergeable: MergeableState } };
      }>(
        `query($owner: String!, $name: String!, $number: Int!) {
          repository(owner: $owner, name: $name) {
            pullRequest(number: $number) {
              mergeable
            }
          }
        }`,
        { owner, name, number: prNumber }
      );
      mergeable = result.repository.pullRequest.mergeable;
    } catch {
      mergeable = "UNKNOWN";
    }

    if (mergeable !== "UNKNOWN") break;

    // Sleep between attempts, but not after the last one — matches
    // `if (( attempt < 5 )); then sleep "${DELAYS[$i]}"; fi`
    if (attempt < delays.length) {
      console.log(
        `PR #${prNumber} mergeability UNKNOWN (attempt ${attempt}/${delays.length}); waiting ${delays[i]}s...`
      );
      await sleep(delays[i] * 1000);
    }
  }

  return mergeable;
}

/**
 * Lists all open PRs authored by the developer-agent bot (up to 100).
 * Uses the GitHub search API with the `author:` qualifier, matching
 * `gh pr list --author 'app/mfrancza-developer-agent' --limit 100`.
 */
export async function listDeveloperAgentPrs(
  octokit: OctokitType,
  owner: string,
  name: string,
  author: string
): Promise<number[]> {
  const response = await octokit.rest.search.issuesAndPullRequests({
    q: `is:pr is:open repo:${owner}/${name} author:${author}`,
    per_page: 100,
  });
  return response.data.items.map((item) => item.number);
}

/**
 * Lists all open PRs in the repository without an author filter, paginating
 * through REST Pulls API pages (100 items per page) until all results have been
 * collected. Uses GET /repos/{owner}/{repo}/pulls, which imposes no hard result
 * cap (unlike the Search API's 1,000-item ceiling), so every open PR is
 * returned regardless of how many the repository has.
 *
 * Pagination stops when a page returns fewer items than requested (last page).
 */
export async function listAllOpenPrs(
  octokit: OctokitType,
  owner: string,
  name: string
): Promise<number[]> {
  const perPage = 100;
  const numbers: number[] = [];
  let page = 1;

  while (true) {
    const response = await octokit.rest.pulls.list({
      owner,
      repo: name,
      state: "open",
      per_page: perPage,
      page,
    });
    const items = response.data;
    for (const pr of items) {
      numbers.push(pr.number);
    }
    // Stop when we've reached the last page (fewer items than requested).
    if (items.length < perPage) break;
    page++;
  }

  return numbers;
}

/**
 * Checks whether a PR's head branch lives in the same repository as the base
 * branch (i.e., is not a fork-headed PR). Calls the REST Pulls API to get the
 * full PR payload and compares head.repo.full_name with base.repo.full_name.
 *
 * Returns false for PRs whose head fork was deleted (head.repo === null),
 * treating them as out of scope, so a stale deleted-fork PR cannot crash the
 * enumeration loop.
 */
export async function isSameRepoHead(
  octokit: OctokitType,
  owner: string,
  name: string,
  prNumber: number
): Promise<boolean> {
  const response = await octokit.rest.pulls.get({
    owner,
    repo: name,
    pull_number: prNumber,
  });
  const pr = response.data;
  // head.repo is null when the head fork was deleted after the PR was opened.
  if (!pr.head.repo) return false;
  return pr.head.repo.full_name === pr.base.repo.full_name;
}

/**
 * Enumerates in-scope open PRs using REST Pulls API with integrated filters.
 * Fork filter and author filter are applied from the page response (no extra
 * API call per PR). Bounded by MAX_SCAN_PAGES and MAX_CANDIDATES with
 * ::warning:: annotations when either limit is reached.
 *
 * @param author           The `app/<slug>` author string; normalized to `<slug>[bot]`
 *                         for REST API login comparison.
 * @param authorAllowlist  Non-empty allowlist: ["*"] sweeps all authors; an
 *                         explicit list sweeps developer-agent + those logins.
 */
export async function enumerateInScopePrs(
  octokit: OctokitType,
  owner: string,
  name: string,
  author: string,
  authorAllowlist: string[],
  sleep: (ms: number) => Promise<void>,
  rateLimiter: RateLimitGuard
): Promise<number[]> {
  const perPage = 100;

  // Bot-login normalization: strip "app/" prefix, append "[bot]"
  const developerBotLogin = author.replace(/^app\//, "") + "[bot]";

  const isWildcard = authorAllowlist.length === 1 && authorAllowlist[0] === "*";
  const allowedLogins = isWildcard
    ? null
    : new Set([developerBotLogin, ...authorAllowlist].map((s) => s.toLowerCase()));

  const candidates: number[] = [];
  let scanBudgetExhausted = false;

  for (let page = 1; page <= MAX_SCAN_PAGES; page++) {
    await rateLimiter.acquire(1, sleep);

    const response = await octokit.rest.pulls.list({
      owner,
      repo: name,
      state: "open",
      per_page: perPage,
      page,
    });
    const items = response.data;

    for (const pr of items) {
      // Fork filter: null head.repo = deleted fork, also exclude cross-repo PRs
      if (!pr.head.repo || pr.head.repo.full_name !== pr.base.repo.full_name) {
        continue;
      }

      // Author filter (for explicit list)
      if (allowedLogins !== null) {
        const prLogin = (pr.user?.login ?? "").toLowerCase();
        if (!allowedLogins.has(prLogin)) {
          continue;
        }
      }

      candidates.push(pr.number);

      if (candidates.length >= MAX_CANDIDATES) {
        core.warning(
          `conflict sweep capped at 100 candidates; additional in-scope PRs may not have been evaluated — reduce open PR count or use an explicit author allowlist to limit scope`
        );
        return candidates;
      }
    }

    if (items.length < perPage) break;

    if (page === MAX_SCAN_PAGES) {
      scanBudgetExhausted = true;
      break;
    }
  }

  if (scanBudgetExhausted) {
    core.warning(
      `conflict sweep scan budget exhausted after 50 pages; only ${candidates.length} in-scope candidates found; additional in-scope PRs may not have been evaluated — reduce open PR count or use an explicit author allowlist to limit scope`
    );
  }

  return candidates;
}

/**
 * Polls candidates with P=5 bounded concurrency.
 * Reserves rate-limit slots atomically before each wave.
 * Returns PR numbers whose mergeability settled as CONFLICTING.
 */
export async function pollCandidatesWithBoundedConcurrency(
  octokit: OctokitType,
  owner: string,
  name: string,
  candidates: number[],
  delays: readonly number[],
  sleep: (ms: number) => Promise<void>,
  rateLimiter: RateLimitGuard
): Promise<number[]> {
  const P = 5;
  const conflicted: number[] = [];

  for (let i = 0; i < candidates.length; i += P) {
    const batch = candidates.slice(i, i + P);
    const states = new Map<number, MergeableState>(
      batch.map((n) => [n, "UNKNOWN" as MergeableState])
    );

    for (let attempt = 0; attempt < delays.length; attempt++) {
      const unknownPrs = batch.filter((n) => states.get(n) === "UNKNOWN");
      if (unknownPrs.length === 0) break;

      // Atomically reserve slots for this wave
      await rateLimiter.acquire(unknownPrs.length, sleep);

      // Fire queries in parallel
      const waveResults = await Promise.all(
        unknownPrs.map(async (prNum) => {
          try {
            const result = await octokit.graphql<{
              repository: { pullRequest: { mergeable: MergeableState } };
            }>(
              `query($owner: String!, $name: String!, $number: Int!) {
                repository(owner: $owner, name: $name) {
                  pullRequest(number: $number) {
                    mergeable
                  }
                }
              }`,
              { owner, name, number: prNum }
            );
            return { prNum, state: result.repository.pullRequest.mergeable };
          } catch {
            return { prNum, state: "UNKNOWN" as MergeableState };
          }
        })
      );

      for (const { prNum, state } of waveResults) {
        states.set(prNum, state);
      }

      const allResolved = batch.every((n) => states.get(n) !== "UNKNOWN");
      if (allResolved) break;

      if (attempt < delays.length - 1) {
        const stillUnknown = batch.filter((n) => states.get(n) === "UNKNOWN");
        console.log(
          `Batch [${batch.join(", ")}]: ${stillUnknown.length} PR(s) still UNKNOWN (attempt ${attempt + 1}/${delays.length}); waiting ${delays[attempt]}s...`
        );
        await sleep(delays[attempt]! * 1000);
      }
    }

    for (const prNum of batch) {
      const state = states.get(prNum)!;
      if (state === "CONFLICTING") {
        console.log(`PR #${prNum} is CONFLICTING — queued for resolution`);
        conflicted.push(prNum);
      } else {
        console.log(`PR #${prNum} mergeability: ${state} — skipping`);
      }
    }
  }

  return conflicted;
}

/**
 * Enumerates open PRs and returns those that are CONFLICTING after the
 * mergeability poll settles.
 *
 * When authorAllowlist is empty (the default), only developer-agent-authored
 * PRs are enumerated using the GitHub search API with an `author:` qualifier
 * (existing behavior — unchanged).
 *
 * When authorAllowlist is non-empty:
 *   - ["*"] sweeps all authors (every open same-repo PR)
 *   - ["alice", "bob"] sweeps developer-agent + those explicit logins
 * Enumeration uses the REST Pulls API with integrated fork filter and author
 * filter (no extra API call per PR). Bounded by MAX_SCAN_PAGES and
 * MAX_CANDIDATES. Polling uses P=5 bounded concurrency with the shared
 * rateLimiter.
 */
export async function findConflictedPrs(
  octokit: OctokitType,
  owner: string,
  name: string,
  author: string,
  delays: readonly number[],
  sleep: (ms: number) => Promise<void>,
  authorAllowlist: string[] = [],
  rateLimiter: RateLimitGuard = new RateLimiter()
): Promise<number[]> {
  if (authorAllowlist.length > 0) {
    const inScopePrs = await enumerateInScopePrs(
      octokit,
      owner,
      name,
      author,
      authorAllowlist,
      sleep,
      rateLimiter
    );

    if (inScopePrs.length === 0) {
      console.log("No in-scope open PRs found.");
      return [];
    }

    console.log(`In-scope open PRs: ${inScopePrs.join(" ")}`);

    return pollCandidatesWithBoundedConcurrency(
      octokit,
      owner,
      name,
      inScopePrs,
      delays,
      sleep,
      rateLimiter
    );
  } else {
    // Default: agent-only (existing behavior preserved)
    const prNumbers = await listDeveloperAgentPrs(octokit, owner, name, author);

    if (prNumbers.length === 0) {
      console.log("No open developer-agent PRs found.");
      return [];
    }

    console.log(`Open PRs: ${prNumbers.join(" ")}`);

    const conflicted: number[] = [];
    for (const prNum of prNumbers) {
      const mergeable = await pollMergeability(
        octokit,
        owner,
        name,
        prNum,
        delays,
        sleep
      );
      if (mergeable === "CONFLICTING") {
        console.log(`PR #${prNum} is CONFLICTING — queued for resolution`);
        conflicted.push(prNum);
      } else {
        console.log(`PR #${prNum} mergeability: ${mergeable} — skipping`);
      }
    }
    return conflicted;
  }
}

async function run(): Promise<void> {
  const token = core.getInput("token", { required: true });
  const repo = core.getInput("repo", { required: true });
  const prNumberInput = core.getInput("pr_number");
  const author = core.getInput("author") || "app/mfrancza-developer-agent";
  const authorAllowlistRaw = core.getInput("author_allowlist") || "[]";

  const [owner, name] = repo.split("/");
  const octokit = getOctokit(token);

  let manualPr: number | null;
  try {
    manualPr = validatePrNumberInput(prNumberInput);
  } catch (error: unknown) {
    core.setFailed(error instanceof Error ? error.message : String(error));
    return;
  }

  let authorAllowlist: string[];
  try {
    authorAllowlist = validateAuthorAllowlist(authorAllowlistRaw);
  } catch (error: unknown) {
    core.setFailed(error instanceof Error ? error.message : String(error));
    return;
  }

  if (manualPr !== null) {
    // Manual dispatch: poll mergeability to let GitHub's async computation
    // settle, then include the PR regardless of result (manual backstop).
    console.log(`Manual dispatch: polling PR #${manualPr} for mergeability`);
    const mergeable = await pollMergeability(
      octokit,
      owner,
      name,
      manualPr,
      DEFAULT_DELAYS,
      defaultSleep
    );
    console.log(
      `PR #${manualPr} mergeability: ${mergeable} (manual dispatch — including regardless)`
    );
    core.setOutput("conflicted_prs", JSON.stringify([manualPr]));
    return;
  }

  // Automatic path: enumerate PRs and filter to CONFLICTING.
  const conflicted = await findConflictedPrs(
    octokit,
    owner,
    name,
    author,
    DEFAULT_DELAYS,
    defaultSleep,
    authorAllowlist
  );
  console.log(`Conflicted PRs: ${JSON.stringify(conflicted)}`);
  core.setOutput("conflicted_prs", JSON.stringify(conflicted));
}

run().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});

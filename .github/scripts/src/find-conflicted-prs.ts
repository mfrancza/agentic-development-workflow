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

/** Production sleep: real timer. Injected so tests can replace it. */
export function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
 * Lists all open PRs in the repository (up to 100), without author filter.
 * Uses the GitHub search API without the `author:` qualifier so every open PR
 * is returned, regardless of who authored it.
 */
export async function listAllOpenPrs(
  octokit: OctokitType,
  owner: string,
  name: string
): Promise<number[]> {
  const response = await octokit.rest.search.issuesAndPullRequests({
    q: `is:pr is:open repo:${owner}/${name}`,
    per_page: 100,
  });
  return response.data.items.map((item) => item.number);
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
 * Enumerates open PRs and returns those that are CONFLICTING after the
 * mergeability poll settles.
 *
 * When allAuthors is false (the default), only developer-agent-authored PRs
 * are enumerated using the GitHub search API with an `author:` qualifier.
 *
 * When allAuthors is true, all open PRs in the repository are enumerated
 * (search query drops the `author:` qualifier). Each candidate is then checked
 * via GET /repos/{owner}/{repo}/pulls/{number} to exclude cross-repository
 * (fork-headed) PRs before the mergeability poll runs.
 */
export async function findConflictedPrs(
  octokit: OctokitType,
  owner: string,
  name: string,
  author: string,
  delays: readonly number[],
  sleep: (ms: number) => Promise<void>,
  allAuthors = false
): Promise<number[]> {
  let prNumbers: number[];

  if (allAuthors) {
    const allPrs = await listAllOpenPrs(octokit, owner, name);

    if (allPrs.length === 0) {
      console.log("No open PRs found.");
      return [];
    }

    console.log(
      `Open PRs (all authors): ${allPrs.join(" ")} — filtering to same-repo heads`
    );

    // Exclude fork-headed PRs: the developer-agent App can only push to
    // branches on the base repository, so including fork PRs would guarantee
    // a runtime failure after a wasted token mint and container boot.
    const sameRepoPrs: number[] = [];
    for (const prNum of allPrs) {
      const sameRepo = await isSameRepoHead(octokit, owner, name, prNum);
      if (sameRepo) {
        sameRepoPrs.push(prNum);
      } else {
        console.log(`PR #${prNum} is fork-headed — skipping`);
      }
    }
    prNumbers = sameRepoPrs;
  } else {
    prNumbers = await listDeveloperAgentPrs(octokit, owner, name, author);
  }

  if (prNumbers.length === 0) {
    console.log(
      allAuthors
        ? "No same-repo open PRs found."
        : "No open developer-agent PRs found."
    );
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

async function run(): Promise<void> {
  const token = core.getInput("token", { required: true });
  const repo = core.getInput("repo", { required: true });
  const prNumberInput = core.getInput("pr_number");
  const author =
    core.getInput("author") || "app/mfrancza-developer-agent";
  const allAuthors = core.getInput("all_authors") === "true";

  const [owner, name] = repo.split("/");
  const octokit = getOctokit(token);

  let manualPr: number | null;
  try {
    manualPr = validatePrNumberInput(prNumberInput);
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
    allAuthors
  );
  console.log(`Conflicted PRs: ${JSON.stringify(conflicted)}`);
  core.setOutput("conflicted_prs", JSON.stringify(conflicted));
}

run().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});

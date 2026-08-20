import * as core from "@actions/core";
import * as fs from "fs";
import { getOctokit } from "./lib/octokit.js";

type OctokitType = ReturnType<typeof getOctokit>;

interface ReviewThreadsResult {
  repository: {
    pullRequest: {
      reviewThreads: {
        pageInfo: {
          endCursor: string | null;
          hasNextPage: boolean;
        };
        nodes: Array<{
          id: string;
          isResolved: boolean;
        }>;
      };
    };
  };
}

/**
 * Checks whether a thread ID has the expected format.
 * Thread IDs are Base64-encoded GraphQL node IDs; they should only contain
 * alphanumeric characters, underscores, equals signs, and hyphens.
 * Preserves the exact regex from the shell implementation: ^[A-Za-z0-9_=-]+$
 */
export function isValidThreadId(id: string): boolean {
  return /^[A-Za-z0-9_=-]+$/.test(id);
}

/**
 * Reads thread IDs from a file, trims surrounding whitespace, filters empty
 * lines, and returns a sorted, deduplicated list.
 * Matches the `sort -u` behaviour of the shell implementation.
 */
export function readThreadIds(filePath: string): string[] {
  const content = fs.readFileSync(filePath, "utf-8");
  const seen = new Set<string>();
  for (const line of content.split("\n")) {
    const id = line.trim();
    if (id) seen.add(id);
  }
  return Array.from(seen).sort();
}

/**
 * Paginates through all review threads on a PR (100 per page) and returns
 * the set of IDs for threads that are still unresolved.
 * The same cursor pattern as the reviewer container's thread fetch:
 * cursor=null on the first page is equivalent to omitting the argument.
 */
export async function fetchOpenThreadIds(
  octokit: OctokitType,
  owner: string,
  name: string,
  prNumber: number
): Promise<Set<string>> {
  const openIds = new Set<string>();
  let cursor: string | null = null;

  while (true) {
    const result: ReviewThreadsResult = await octokit.graphql<ReviewThreadsResult>(
      `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
        repository(owner: $owner, name: $name) {
          pullRequest(number: $number) {
            reviewThreads(first: 100, after: $cursor) {
              pageInfo { endCursor hasNextPage }
              nodes { id isResolved }
            }
          }
        }
      }`,
      { owner, name, number: prNumber, cursor }
    );

    const threads = result.repository.pullRequest.reviewThreads;
    const { nodes, pageInfo } = threads;
    for (const thread of nodes) {
      if (!thread.isResolved) {
        openIds.add(thread.id);
      }
    }

    if (!pageInfo.hasNextPage) break;
    cursor = pageInfo.endCursor;
  }

  return openIds;
}

export interface ResolveResult {
  resolved: string[];
  skippedInvalidFormat: string[];
  skippedNotOpen: string[];
  failed: string[];
}

/**
 * For each recorded thread ID: validate the format, check it is an open
 * thread, then issue the resolveReviewThread mutation.
 *
 * Failures are accumulated rather than failing fast so that as many threads
 * as possible are resolved per run — matching the shell implementation's
 * FAILED=0 / exit "$FAILED" pattern.
 *
 * Untrusted-ID validation semantics preserved exactly:
 *   1. Format check: ^[A-Za-z0-9_=-]+$  (warn and skip if invalid)
 *   2. Intersection: ID must be in the open-thread snapshot (warn and skip if absent)
 *   3. Mutation: resolveReviewThread (error and mark failed if it throws)
 */
export async function resolveThreads(
  octokit: OctokitType,
  prNumber: number,
  threadIds: string[],
  openIds: Set<string>
): Promise<ResolveResult> {
  const result: ResolveResult = {
    resolved: [],
    skippedInvalidFormat: [],
    skippedNotOpen: [],
    failed: [],
  };

  for (const threadId of threadIds) {
    if (!isValidThreadId(threadId)) {
      core.warning(
        "Skipping a recorded line that is not a well-formed thread ID."
      );
      result.skippedInvalidFormat.push(threadId);
      continue;
    }

    if (!openIds.has(threadId)) {
      core.warning(
        `Recorded thread ID ${threadId} is not an open review thread on PR #${prNumber}; skipping.`
      );
      result.skippedNotOpen.push(threadId);
      continue;
    }

    try {
      await octokit.graphql(
        `mutation($threadId: ID!) {
          resolveReviewThread(input: { threadId: $threadId }) {
            thread { id isResolved }
          }
        }`,
        { threadId }
      );
      console.log(`Resolved review thread ${threadId}`);
      result.resolved.push(threadId);
    } catch {
      core.error(`Failed to resolve review thread ${threadId}`);
      result.failed.push(threadId);
    }
  }

  return result;
}

async function run(): Promise<void> {
  const token = core.getInput("token", { required: true });
  const prNumberStr = core.getInput("pr_number", { required: true });
  const repo = core.getInput("repo", { required: true });
  const resolveFile = core.getInput("resolve_file", { required: true });

  // Skip if no file or empty file — matches `[ ! -s "$RESOLVE_FILE" ]`.
  if (!fs.existsSync(resolveFile) || fs.statSync(resolveFile).size === 0) {
    console.log("No review threads recorded for resolution.");
    return;
  }

  const prNumber = parseInt(prNumberStr, 10);
  const [owner, name] = repo.split("/");
  const octokit = getOctokit(token);

  const threadIds = readThreadIds(resolveFile);
  const openIds = await fetchOpenThreadIds(octokit, owner, name, prNumber);
  const result = await resolveThreads(octokit, prNumber, threadIds, openIds);

  if (result.failed.length > 0) {
    // Matches `exit "$FAILED"` — fail loudly so the review threads stay open
    // for the next re-review run (self-healing).
    core.setFailed(
      `Failed to resolve ${result.failed.length} review thread(s).`
    );
  }
}

run().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});

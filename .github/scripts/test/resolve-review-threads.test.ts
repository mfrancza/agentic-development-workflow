import { describe, it, expect, vi, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  isValidThreadId,
  readThreadIds,
  fetchOpenThreadIds,
  resolveThreads,
} from "../src/resolve-review-threads.js";
import { getOctokit } from "../src/lib/octokit.js";

type OctokitType = ReturnType<typeof getOctokit>;

/** Build a minimal mock Octokit with a stub graphql method. */
function makeOctokit(graphql: ReturnType<typeof vi.fn>): OctokitType {
  return { graphql } as unknown as OctokitType;
}

/** Create a temp file with the given content and return its path. */
function writeTmp(content: string): string {
  const p = path.join(os.tmpdir(), `rrt-test-${Math.random().toString(36).slice(2)}.txt`);
  fs.writeFileSync(p, content, "utf-8");
  return p;
}

// ---------------------------------------------------------------------------
// isValidThreadId
// ---------------------------------------------------------------------------

describe("isValidThreadId", () => {
  it("accepts alphanumeric characters", () => {
    expect(isValidThreadId("ABC123abc")).toBe(true);
  });

  it("accepts underscore, hyphen, and equals sign", () => {
    expect(isValidThreadId("abc_def-xyz=")).toBe(true);
  });

  it("accepts a typical Base64url-style GraphQL node ID", () => {
    expect(isValidThreadId("PRRT_kwDOBv4MXc4A3Bab")).toBe(true);
  });

  it("rejects the empty string", () => {
    expect(isValidThreadId("")).toBe(false);
  });

  it("rejects IDs containing spaces", () => {
    expect(isValidThreadId("abc def")).toBe(false);
  });

  it("rejects IDs containing newlines", () => {
    expect(isValidThreadId("abc\ndef")).toBe(false);
  });

  it("rejects IDs containing forward slashes", () => {
    expect(isValidThreadId("abc/def")).toBe(false);
  });

  it("rejects IDs containing plus signs", () => {
    expect(isValidThreadId("abc+def")).toBe(false);
  });

  it("rejects IDs containing exclamation marks", () => {
    expect(isValidThreadId("abc!")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// readThreadIds
// ---------------------------------------------------------------------------

describe("readThreadIds", () => {
  let tmp: string | undefined;

  afterEach(() => {
    if (tmp) {
      fs.unlinkSync(tmp);
      tmp = undefined;
    }
  });

  it("reads IDs from a file", () => {
    tmp = writeTmp("id1\nid2\nid3\n");
    expect(readThreadIds(tmp)).toEqual(["id1", "id2", "id3"]);
  });

  it("returns IDs in sorted order", () => {
    tmp = writeTmp("zzz\naaa\nmmm\n");
    expect(readThreadIds(tmp)).toEqual(["aaa", "mmm", "zzz"]);
  });

  it("deduplicates repeated IDs", () => {
    tmp = writeTmp("id1\nid2\nid1\n");
    expect(readThreadIds(tmp)).toEqual(["id1", "id2"]);
  });

  it("skips empty lines", () => {
    tmp = writeTmp("id1\n\nid2\n\n");
    expect(readThreadIds(tmp)).toEqual(["id1", "id2"]);
  });

  it("handles a file with no trailing newline", () => {
    tmp = writeTmp("id1\nid2");
    expect(readThreadIds(tmp)).toEqual(["id1", "id2"]);
  });

  it("strips CR from Windows CRLF line endings", () => {
    tmp = writeTmp("id1\r\nid2\r\n");
    expect(readThreadIds(tmp)).toEqual(["id1", "id2"]);
  });
});

// ---------------------------------------------------------------------------
// fetchOpenThreadIds
// ---------------------------------------------------------------------------

describe("fetchOpenThreadIds", () => {
  it("returns open thread IDs from a single page", async () => {
    const graphql = vi.fn().mockResolvedValueOnce({
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { endCursor: null, hasNextPage: false },
            nodes: [
              { id: "thread1", isResolved: false },
              { id: "thread2", isResolved: true },
              { id: "thread3", isResolved: false },
            ],
          },
        },
      },
    });

    const result = await fetchOpenThreadIds(makeOctokit(graphql), "owner", "repo", 1);

    expect(result).toEqual(new Set(["thread1", "thread3"]));
    expect(graphql).toHaveBeenCalledOnce();
  });

  it("paginates across multiple pages, accumulating all open IDs", async () => {
    const graphql = vi.fn()
      .mockResolvedValueOnce({
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { endCursor: "cursor1", hasNextPage: true },
              nodes: [{ id: "thread1", isResolved: false }],
            },
          },
        },
      })
      .mockResolvedValueOnce({
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { endCursor: null, hasNextPage: false },
              nodes: [{ id: "thread2", isResolved: false }],
            },
          },
        },
      });

    const result = await fetchOpenThreadIds(makeOctokit(graphql), "owner", "repo", 1);

    expect(result).toEqual(new Set(["thread1", "thread2"]));
    expect(graphql).toHaveBeenCalledTimes(2);
  });

  it("returns an empty set when all threads are already resolved", async () => {
    const graphql = vi.fn().mockResolvedValueOnce({
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { endCursor: null, hasNextPage: false },
            nodes: [{ id: "thread1", isResolved: true }],
          },
        },
      },
    });

    const result = await fetchOpenThreadIds(makeOctokit(graphql), "owner", "repo", 1);

    expect(result).toEqual(new Set());
  });

  it("passes the cursor from the previous page on subsequent requests", async () => {
    const graphql = vi.fn()
      .mockResolvedValueOnce({
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { endCursor: "page2cursor", hasNextPage: true },
              nodes: [],
            },
          },
        },
      })
      .mockResolvedValueOnce({
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { endCursor: null, hasNextPage: false },
              nodes: [],
            },
          },
        },
      });

    await fetchOpenThreadIds(makeOctokit(graphql), "owner", "repo", 7);

    // Second call should forward the cursor from the first response.
    expect(graphql).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      expect.objectContaining({ cursor: "page2cursor" })
    );
  });
});

// ---------------------------------------------------------------------------
// resolveThreads
// ---------------------------------------------------------------------------

describe("resolveThreads", () => {
  it("issues the mutation for a valid, open thread and records it as resolved", async () => {
    const graphql = vi.fn().mockResolvedValue({
      resolveReviewThread: { thread: { id: "thread1", isResolved: true } },
    });
    const openIds = new Set(["thread1"]);

    const result = await resolveThreads(makeOctokit(graphql), 42, ["thread1"], openIds);

    expect(result.resolved).toEqual(["thread1"]);
    expect(result.failed).toEqual([]);
    expect(graphql).toHaveBeenCalledOnce();
  });

  it("skips and warns on IDs with invalid format", async () => {
    const graphql = vi.fn();
    const openIds = new Set<string>();

    const result = await resolveThreads(makeOctokit(graphql), 42, ["bad id!"], openIds);

    expect(result.skippedInvalidFormat).toEqual(["bad id!"]);
    expect(result.resolved).toEqual([]);
    expect(graphql).not.toHaveBeenCalled();
  });

  it("skips and warns on IDs absent from the open-thread snapshot", async () => {
    const graphql = vi.fn();
    const openIds = new Set<string>(["other-thread"]);

    const result = await resolveThreads(makeOctokit(graphql), 42, ["THREAD123"], openIds);

    expect(result.skippedNotOpen).toEqual(["THREAD123"]);
    expect(result.resolved).toEqual([]);
    expect(graphql).not.toHaveBeenCalled();
  });

  it("accumulates failures without failing fast — subsequent threads are still attempted", async () => {
    const graphql = vi.fn()
      .mockRejectedValueOnce(new Error("API error"))
      .mockResolvedValueOnce({
        resolveReviewThread: { thread: { id: "thread2", isResolved: true } },
      });
    const openIds = new Set(["thread1", "thread2"]);

    const result = await resolveThreads(
      makeOctokit(graphql),
      42,
      ["thread1", "thread2"],
      openIds
    );

    expect(result.failed).toEqual(["thread1"]);
    expect(result.resolved).toEqual(["thread2"]);
    expect(graphql).toHaveBeenCalledTimes(2);
  });

  it("returns all-empty arrays for an empty thread ID list", async () => {
    const graphql = vi.fn();
    const openIds = new Set<string>(["thread1"]);

    const result = await resolveThreads(makeOctokit(graphql), 42, [], openIds);

    expect(result.resolved).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.skippedInvalidFormat).toEqual([]);
    expect(result.skippedNotOpen).toEqual([]);
    expect(graphql).not.toHaveBeenCalled();
  });

  it("applies both format-check and open-set check independently", async () => {
    // thread1: valid format, but NOT in openIds → skippedNotOpen
    // thread2: invalid format → skippedInvalidFormat
    // thread3: valid and open → resolved
    const graphql = vi.fn().mockResolvedValue({
      resolveReviewThread: { thread: { id: "thread3", isResolved: true } },
    });
    const openIds = new Set(["thread3"]);

    const result = await resolveThreads(
      makeOctokit(graphql),
      1,
      ["thread1", "bad id!", "thread3"],
      openIds
    );

    expect(result.skippedNotOpen).toEqual(["thread1"]);
    expect(result.skippedInvalidFormat).toEqual(["bad id!"]);
    expect(result.resolved).toEqual(["thread3"]);
  });
});

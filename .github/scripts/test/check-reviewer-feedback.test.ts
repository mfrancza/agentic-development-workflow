import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  checkReviewerFeedback,
  type FeedbackCheckInput,
  type FeedbackCheckDeps,
} from "../src/check-reviewer-feedback.js";

// Suppress @actions/core logging so test output stays clean.
vi.mock("@actions/core", () => ({
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  setOutput: vi.fn(),
  setFailed: vi.fn(),
  getInput: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const BASE_INPUT: FeedbackCheckInput = {
  state: "approved",
  body: "",
  reviewId: 1001,
  prNumber: 42,
  owner: "acme",
  repo: "myrepo",
};

function makeDeps(overrides?: Partial<FeedbackCheckDeps>): FeedbackCheckDeps {
  return {
    countUnresolvedThreads: vi.fn(),
    countInlineComments: vi.fn(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Non-approval review states
// ---------------------------------------------------------------------------

describe("non-approval review states", () => {
  it("proceeds for 'changes_requested' without calling any API", async () => {
    const deps = makeDeps();
    const result = await checkReviewerFeedback(
      { ...BASE_INPUT, state: "changes_requested" },
      deps,
    );
    expect(result.proceed).toBe(true);
    expect(deps.countUnresolvedThreads).not.toHaveBeenCalled();
    expect(deps.countInlineComments).not.toHaveBeenCalled();
  });

  it("proceeds for 'commented' without calling any API", async () => {
    const deps = makeDeps();
    const result = await checkReviewerFeedback(
      { ...BASE_INPUT, state: "commented" },
      deps,
    );
    expect(result.proceed).toBe(true);
    expect(deps.countUnresolvedThreads).not.toHaveBeenCalled();
    expect(deps.countInlineComments).not.toHaveBeenCalled();
  });

  it("proceeds for an unexpected state value", async () => {
    const deps = makeDeps();
    const result = await checkReviewerFeedback(
      { ...BASE_INPUT, state: "dismissed" },
      deps,
    );
    expect(result.proceed).toBe(true);
    expect(deps.countUnresolvedThreads).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2. Approved review — primary thread count check (GraphQL succeeds)
// ---------------------------------------------------------------------------

describe("approved review — primary unresolved-thread check", () => {
  it("is case-insensitive when matching 'APPROVED'", async () => {
    // 'APPROVED' (upper) should be treated as approved and go to the thread check.
    const deps = makeDeps({
      countUnresolvedThreads: vi.fn().mockResolvedValue(0),
    });
    const result = await checkReviewerFeedback(
      { ...BASE_INPUT, state: "APPROVED" },
      deps,
    );
    expect(result.proceed).toBe(false);
    expect(deps.countUnresolvedThreads).toHaveBeenCalledOnce();
  });

  it("skips when unresolved thread count is zero (bare-approval fallback not reached)", async () => {
    const deps = makeDeps({
      countUnresolvedThreads: vi.fn().mockResolvedValue(0),
    });
    const result = await checkReviewerFeedback(BASE_INPUT, deps);
    expect(result.proceed).toBe(false);
    expect(deps.countInlineComments).not.toHaveBeenCalled();
  });

  it("proceeds when unresolved thread count is 1", async () => {
    const deps = makeDeps({
      countUnresolvedThreads: vi.fn().mockResolvedValue(1),
    });
    const result = await checkReviewerFeedback(BASE_INPUT, deps);
    expect(result.proceed).toBe(true);
    expect(deps.countInlineComments).not.toHaveBeenCalled();
  });

  it("proceeds when unresolved thread count is large", async () => {
    const deps = makeDeps({
      countUnresolvedThreads: vi.fn().mockResolvedValue(50),
    });
    const result = await checkReviewerFeedback(BASE_INPUT, deps);
    expect(result.proceed).toBe(true);
  });

  it("skips with zero threads even when review body is non-empty", async () => {
    // Thread check takes precedence: zero threads → skip regardless of body.
    const deps = makeDeps({
      countUnresolvedThreads: vi.fn().mockResolvedValue(0),
    });
    const result = await checkReviewerFeedback(
      { ...BASE_INPUT, body: "LGTM! Great work." },
      deps,
    );
    expect(result.proceed).toBe(false);
    expect(deps.countInlineComments).not.toHaveBeenCalled();
  });

  it("skips with zero threads without checking inline comments", async () => {
    // Inline comment check is part of the bare-approval fallback only.
    const deps = makeDeps({
      countUnresolvedThreads: vi.fn().mockResolvedValue(0),
      countInlineComments: vi.fn().mockResolvedValue(5),
    });
    const result = await checkReviewerFeedback(BASE_INPUT, deps);
    expect(result.proceed).toBe(false);
    expect(deps.countInlineComments).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3. Approved review — bare-approval fallback (GraphQL errored)
// ---------------------------------------------------------------------------

describe("approved review — bare-approval fallback (GraphQL error)", () => {
  let deps: FeedbackCheckDeps;

  beforeEach(() => {
    // In every test in this group, the GraphQL call fails.
    deps = makeDeps({
      countUnresolvedThreads: vi
        .fn()
        .mockRejectedValue(new Error("GraphQL API error")),
    });
  });

  // --- bare approval: skip ---

  it("skips when body is empty and inline count is zero", async () => {
    (deps.countInlineComments as ReturnType<typeof vi.fn>).mockResolvedValue(0);
    const result = await checkReviewerFeedback(
      { ...BASE_INPUT, body: "" },
      deps,
    );
    expect(result.proceed).toBe(false);
  });

  it("skips when body is whitespace-only and inline count is zero", async () => {
    // Whitespace-only body is treated as no body.
    (deps.countInlineComments as ReturnType<typeof vi.fn>).mockResolvedValue(0);
    const result = await checkReviewerFeedback(
      { ...BASE_INPUT, body: "   \t\n  " },
      deps,
    );
    expect(result.proceed).toBe(false);
  });

  // --- body present → proceed ---

  it("proceeds when body is non-empty (even with zero inline comments)", async () => {
    (deps.countInlineComments as ReturnType<typeof vi.fn>).mockResolvedValue(0);
    const result = await checkReviewerFeedback(
      { ...BASE_INPUT, body: "Please address the nit on line 42." },
      deps,
    );
    expect(result.proceed).toBe(true);
  });

  it("proceeds when body is non-empty and there are inline comments", async () => {
    (deps.countInlineComments as ReturnType<typeof vi.fn>).mockResolvedValue(3);
    const result = await checkReviewerFeedback(
      { ...BASE_INPUT, body: "See inline comments." },
      deps,
    );
    expect(result.proceed).toBe(true);
  });

  // --- inline comments present → proceed ---

  it("proceeds when inline count > 0 and body is empty", async () => {
    (deps.countInlineComments as ReturnType<typeof vi.fn>).mockResolvedValue(5);
    const result = await checkReviewerFeedback(
      { ...BASE_INPUT, body: "" },
      deps,
    );
    expect(result.proceed).toBe(true);
  });

  it("proceeds when inline count is 1 and body is empty", async () => {
    (deps.countInlineComments as ReturnType<typeof vi.fn>).mockResolvedValue(1);
    const result = await checkReviewerFeedback(
      { ...BASE_INPUT, body: "" },
      deps,
    );
    expect(result.proceed).toBe(true);
  });

  // --- inline comment API failure → fail open ---

  it("proceeds (fail-open) when inline comment API also fails and body is empty", async () => {
    (deps.countInlineComments as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("REST API error"),
    );
    const result = await checkReviewerFeedback(
      { ...BASE_INPUT, body: "" },
      deps,
    );
    // Unknown inline count: cannot confirm there is nothing to respond to.
    expect(result.proceed).toBe(true);
  });

  it("proceeds (fail-open) when inline comment API fails and body is non-empty", async () => {
    (deps.countInlineComments as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("REST API error"),
    );
    const result = await checkReviewerFeedback(
      { ...BASE_INPUT, body: "Please take another look." },
      deps,
    );
    expect(result.proceed).toBe(true);
  });

  it("proceeds (fail-open) when both APIs fail and body is whitespace-only", async () => {
    (deps.countInlineComments as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("503 Service Unavailable"),
    );
    const result = await checkReviewerFeedback(
      { ...BASE_INPUT, body: "   " },
      deps,
    );
    // Cannot confirm zero inline comments, so fail open.
    expect(result.proceed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Output contract — proceed is always a boolean
// ---------------------------------------------------------------------------

describe("output contract", () => {
  it("returns proceed=true as a boolean (not a string)", async () => {
    const deps = makeDeps({
      countUnresolvedThreads: vi.fn().mockResolvedValue(1),
    });
    const result = await checkReviewerFeedback(BASE_INPUT, deps);
    expect(typeof result.proceed).toBe("boolean");
    expect(result.proceed).toBe(true);
  });

  it("returns proceed=false as a boolean (not a string)", async () => {
    const deps = makeDeps({
      countUnresolvedThreads: vi.fn().mockResolvedValue(0),
    });
    const result = await checkReviewerFeedback(BASE_INPUT, deps);
    expect(typeof result.proceed).toBe("boolean");
    expect(result.proceed).toBe(false);
  });

  it("always returns a non-empty reason string", async () => {
    const scenarios: [Partial<FeedbackCheckInput>, FeedbackCheckDeps][] = [
      [
        { state: "changes_requested" },
        makeDeps(),
      ],
      [
        {},
        makeDeps({ countUnresolvedThreads: vi.fn().mockResolvedValue(0) }),
      ],
      [
        {},
        makeDeps({ countUnresolvedThreads: vi.fn().mockResolvedValue(3) }),
      ],
      [
        {},
        makeDeps({
          countUnresolvedThreads: vi
            .fn()
            .mockRejectedValue(new Error("err")),
          countInlineComments: vi.fn().mockResolvedValue(0),
        }),
      ],
    ];
    for (const [inputOverride, d] of scenarios) {
      const result = await checkReviewerFeedback(
        { ...BASE_INPUT, ...inputOverride },
        d,
      );
      expect(result.reason).toBeTruthy();
    }
  });
});

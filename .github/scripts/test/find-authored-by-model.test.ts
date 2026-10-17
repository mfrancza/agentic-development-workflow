import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  parseAuthoredByModel,
  findAuthoredByModel,
} from "../src/find-authored-by-model.js";
import type { getOctokit } from "../src/lib/octokit.js";

// Silence @actions/core logging so test output stays clean.
vi.mock("@actions/core", () => ({
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  setOutput: vi.fn(),
  setFailed: vi.fn(),
  getInput: vi.fn(),
}));

type Octokit = ReturnType<typeof getOctokit>;

/** Build a minimal Octokit mock with the pulls.get method findAuthoredByModel uses. */
function makeOctokit(pullsGet: ReturnType<typeof vi.fn>): Octokit {
  return {
    rest: {
      pulls: {
        get: pullsGet,
      },
    },
  } as unknown as Octokit;
}

const OWNER = "acme";
const REPO = "my-repo";

// ---------------------------------------------------------------------------
// parseAuthoredByModel — pure function tests (no Octokit)
// ---------------------------------------------------------------------------

describe("parseAuthoredByModel", () => {
  it("returns the model name when a well-formed marker is present", () => {
    const body = "Implement feature\n\n<!-- authored-by-model: opus -->\n\nCloses #1";
    expect(parseAuthoredByModel(body)).toBe("opus");
  });

  it("returns empty string when the marker is absent", () => {
    const body = "Implement feature\n\nCloses #1";
    expect(parseAuthoredByModel(body)).toBe("");
  });

  it("returns empty string for a malformed marker (missing colon after authored-by-model)", () => {
    // The regex requires 'authored-by-model:' with a colon; without it the
    // marker is not recognised.
    const body = "<!-- authored-by-model sonnet -->";
    expect(parseAuthoredByModel(body)).toBe("");
  });

  it("handles extra whitespace around the model name", () => {
    // Leading whitespace inside the comment and trailing whitespace before '-->'
    // should both be tolerated by the '\s*' anchors in the regex.
    const body = "<!--  authored-by-model:   sonnet   -->";
    expect(parseAuthoredByModel(body)).toBe("sonnet");
  });

  it("returns empty string when the body is null", () => {
    expect(parseAuthoredByModel(null)).toBe("");
  });

  it("extracts the model from a longer PR body with text before and after the marker", () => {
    const body = [
      "## Summary",
      "This PR implements the feature.",
      "",
      "<!-- authored-by-model: claude-sonnet-4-5 -->",
      "",
      "Closes #42",
    ].join("\n");
    expect(parseAuthoredByModel(body)).toBe("claude-sonnet-4-5");
  });

  it("matches the marker case-insensitively", () => {
    const body = "<!-- AUTHORED-BY-MODEL: haiku -->";
    expect(parseAuthoredByModel(body)).toBe("haiku");
  });

  it("returns the first match when multiple markers are present", () => {
    const body =
      "<!-- authored-by-model: sonnet -->\n<!-- authored-by-model: opus -->";
    expect(parseAuthoredByModel(body)).toBe("sonnet");
  });
});

// ---------------------------------------------------------------------------
// findAuthoredByModel — async function tests (mocked Octokit)
// ---------------------------------------------------------------------------

describe("findAuthoredByModel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the authoring model when the PR body contains a well-formed marker", async () => {
    const pullsGet = vi.fn().mockResolvedValue({
      data: {
        body: "Some content\n\n<!-- authored-by-model: gpt-5.6-sol -->\n\nCloses #7",
      },
    });

    const result = await findAuthoredByModel(
      makeOctokit(pullsGet),
      OWNER,
      REPO,
      42,
    );

    expect(result).toBe("gpt-5.6-sol");
    expect(pullsGet).toHaveBeenCalledWith({
      owner: OWNER,
      repo: REPO,
      pull_number: 42,
    });
  });

  it("returns empty string when the PR body contains no marker", async () => {
    const pullsGet = vi.fn().mockResolvedValue({
      data: { body: "A PR with no authored-by-model marker." },
    });

    const result = await findAuthoredByModel(makeOctokit(pullsGet), OWNER, REPO, 5);

    expect(result).toBe("");
  });

  it("returns empty string when the PR body is null", async () => {
    const pullsGet = vi.fn().mockResolvedValue({
      data: { body: null },
    });

    const result = await findAuthoredByModel(makeOctokit(pullsGet), OWNER, REPO, 3);

    expect(result).toBe("");
  });
});

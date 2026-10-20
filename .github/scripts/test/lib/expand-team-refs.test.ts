import { beforeEach, describe, expect, it, vi } from "vitest";
import { expandTeamRefs } from "../../src/lib/expand-team-refs.js";
import type { getOctokit } from "../../src/lib/octokit.js";

type Octokit = ReturnType<typeof getOctokit>;

function makeOctokit(
  paginate: ReturnType<typeof vi.fn> = vi.fn(),
  listMembersInOrg: ReturnType<typeof vi.fn> = vi.fn(),
): Octokit {
  return {
    paginate,
    rest: {
      teams: { listMembersInOrg },
    },
  } as unknown as Octokit;
}

describe("expandTeamRefs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes through pure logins without calling the API", async () => {
    const paginate = vi.fn();
    const result = await expandTeamRefs(
      ["alice", "bob"],
      makeOctokit(paginate),
      { supportedOrg: "acme" },
    );

    expect(result).toEqual({ expanded: ["alice", "bob"], errors: [] });
    expect(paginate).not.toHaveBeenCalled();
  });

  it("expands team members returned across pagination", async () => {
    const listMembersInOrg = vi.fn();
    const paginate = vi.fn().mockResolvedValue([{ login: "alice" }, { login: "bob" }]);
    const result = await expandTeamRefs(
      ["acme/developers"],
      makeOctokit(paginate, listMembersInOrg),
      { supportedOrg: "acme" },
    );

    expect(result).toEqual({ expanded: ["alice", "bob"], errors: [] });
    expect(paginate).toHaveBeenCalledWith(listMembersInOrg, {
      org: "acme",
      team_slug: "developers",
    });
  });

  it("expands mixed explicit logins and teams", async () => {
    const paginate = vi.fn().mockResolvedValue([{ login: "bob" }]);
    const result = await expandTeamRefs(
      ["alice", "acme/developers", "carol"],
      makeOctokit(paginate),
      { supportedOrg: "acme" },
    );

    expect(result).toEqual({ expanded: ["alice", "bob", "carol"], errors: [] });
  });

  it("deduplicates explicit logins and members case-insensitively in first-seen order", async () => {
    const paginate = vi
      .fn()
      .mockResolvedValueOnce([{ login: "ALICE" }, { login: "bob" }])
      .mockResolvedValueOnce([{ login: "Bob" }, { login: "carol" }]);
    const result = await expandTeamRefs(
      ["alice", "acme/first", "BOB", "acme/second"],
      makeOctokit(paginate),
      { supportedOrg: "acme" },
    );

    expect(result).toEqual({ expanded: ["alice", "bob", "carol"], errors: [] });
  });

  it("reports an empty team while preserving explicit logins", async () => {
    const result = await expandTeamRefs(
      ["alice", "acme/empty"],
      makeOctokit(vi.fn().mockResolvedValue([])),
      { supportedOrg: "acme" },
    );

    expect(result).toEqual({
      expanded: ["alice"],
      errors: [{ entry: "acme/empty", reason: "empty_team" }],
    });
  });

  it.each([
    [404, "not_found"],
    [403, "forbidden"],
  ] as const)("maps HTTP %i to %s", async (status, reason) => {
    const paginate = vi.fn().mockRejectedValue(Object.assign(new Error("failure"), { status }));
    const result = await expandTeamRefs(
      ["acme/developers"],
      makeOctokit(paginate),
      { supportedOrg: "acme" },
    );

    expect(result).toEqual({
      expanded: [],
      errors: [{ entry: "acme/developers", reason }],
    });
  });

  it("reports other HTTP errors with their status", async () => {
    const paginate = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("server failure"), { status: 500 }));
    const result = await expandTeamRefs(
      ["acme/developers"],
      makeOctokit(paginate),
      { supportedOrg: "acme" },
    );

    expect(result).toEqual({
      expanded: [],
      errors: [
        {
          entry: "acme/developers",
          reason: "api_error",
          message: "Team lookup failed with status 500.",
        },
      ],
    });
  });

  it("reports malformed entries and keeps resolving later teams", async () => {
    const paginate = vi.fn().mockResolvedValue([{ login: "alice" }]);
    const result = await expandTeamRefs(
      ["", "acme//developers", "acme/valid"],
      makeOctokit(paginate),
      { supportedOrg: "acme" },
    );

    expect(result).toEqual({
      expanded: ["alice"],
      errors: [
        { entry: "", reason: "malformed" },
        { entry: "acme//developers", reason: "malformed" },
      ],
    });
    expect(paginate).toHaveBeenCalledTimes(1);
  });

  it("treats bot identities as explicit logins", async () => {
    const paginate = vi.fn();
    const result = await expandTeamRefs(
      ["foo[bot]"],
      makeOctokit(paginate),
      { supportedOrg: "acme" },
    );

    expect(result).toEqual({ expanded: ["foo[bot]"], errors: [] });
    expect(paginate).not.toHaveBeenCalled();
  });

  it("includes both inherited and direct team members", async () => {
    const paginate = vi.fn().mockResolvedValue([
      { login: "nested-member", inherited: true },
      { login: "direct-member", inherited: false },
    ]);
    const result = await expandTeamRefs(
      ["acme/parent-team"],
      makeOctokit(paginate),
      { supportedOrg: "acme" },
    );

    expect(result).toEqual({
      expanded: ["nested-member", "direct-member"],
      errors: [],
    });
  });

  it("rejects cross-organization teams without calling the API", async () => {
    const paginate = vi.fn().mockResolvedValue([{ login: "alice" }]);
    const result = await expandTeamRefs(
      ["other-org/developers", "acme/valid"],
      makeOctokit(paginate),
      { supportedOrg: "AcMe" },
    );

    expect(result.errors).toEqual([
      {
        entry: "other-org/developers",
        reason: "cross_org",
        message:
          'Team reference organization "other-org" is unsupported; supported organization is "AcMe".',
      },
    ]);
    expect(paginate).toHaveBeenCalledTimes(1);
  });
});

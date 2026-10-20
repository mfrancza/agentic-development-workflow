import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@actions/core", () => ({
  getInput: vi.fn(), getBooleanInput: vi.fn(), info: vi.fn(), setFailed: vi.fn(),
}));
vi.mock("../src/lib/octokit.js", () => ({ getOctokit: vi.fn() }));

import * as core from "@actions/core";
import { getOctokit } from "../src/lib/octokit.js";
import { run } from "../src/check-agent-allowlist.js";

const paginate = vi.fn();
function inputs(values: Record<string, string> = {}) {
  vi.mocked(core.getInput).mockImplementation((name) => values[name] ?? "");
  vi.mocked(core.getBooleanInput).mockImplementation((name) => values[name] === "true");
}
function octokit() {
  vi.mocked(getOctokit).mockReturnValue({
    paginate,
    rest: { teams: { listMembersInOrg: vi.fn() } },
  } as never);
}

describe("check-agent-allowlist", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GITHUB_REPOSITORY_OWNER = "org";
    delete process.env.AGENT_ALLOWLIST;
    octokit();
  });

  it("allows a matching login-only list without an API call", async () => {
    process.env.AGENT_ALLOWLIST = '["Alice","developer[bot]"]';
    inputs({ principal: "alice" });
    await run();
    expect(core.setFailed).not.toHaveBeenCalled();
    expect(paginate).not.toHaveBeenCalled();
  });

  it("denies a login-only nonmember", async () => {
    process.env.AGENT_ALLOWLIST = '["alice"]'; inputs({ principal: "mallory" });
    await run(); expect(core.setFailed).toHaveBeenCalled(); expect(paginate).not.toHaveBeenCalled();
  });

  it("allows a resolved team member, including paginated lookup", async () => {
    process.env.AGENT_ALLOWLIST = '["org/team"]'; inputs({ principal: "ALICE", resolver_token: "token" });
    paginate.mockResolvedValue([{ login: "alice" }]); await run();
    expect(core.setFailed).not.toHaveBeenCalled(); expect(paginate).toHaveBeenCalledTimes(1);
  });

  it("allows an additional trusted login before any team lookup", async () => {
    process.env.AGENT_ALLOWLIST = '["org/broken"]';
    inputs({ principal: "Copilot", additional_trusted_logins: '["copilot"]' });
    await run(); expect(core.setFailed).not.toHaveBeenCalled(); expect(paginate).not.toHaveBeenCalled();
  });

  it("denies an empty allowlist", async () => {
    process.env.AGENT_ALLOWLIST = ""; inputs({ principal: "alice" }); await run();
    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining("empty"));
  });

  it("fails closed for an unavailable resolver credential", async () => {
    process.env.AGENT_ALLOWLIST = '["org/team"]'; inputs({ principal: "alice" }); await run();
    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining("credential-unavailable"));
  });

  it("fails closed for team errors independently of ordering", async () => {
    for (const list of ['["org/good","org/broken"]', '["org/broken","org/good"]']) {
      vi.clearAllMocks(); octokit(); process.env.AGENT_ALLOWLIST = list;
      inputs({ principal: "alice", resolver_token: "token" });
      paginate.mockImplementation(async (_method, options) => {
        if (options.team_slug === "broken") throw Object.assign(new Error("no"), { status: 403 });
        return [{ login: "alice" }];
      });
      await run(); expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining("broken: forbidden"));
    }
  });

  it("does not let an explicit login bypass a failing sibling team", async () => {
    process.env.AGENT_ALLOWLIST = '["alice","org/broken"]';
    inputs({ principal: "alice", resolver_token: "token" });
    paginate.mockRejectedValue(Object.assign(new Error("no"), { status: 403 })); await run();
    expect(core.setFailed).toHaveBeenCalled();
  });

  it("allows an explicit login after all teams resolve", async () => {
    process.env.AGENT_ALLOWLIST = '["alice","org/good"]';
    inputs({ principal: "alice", resolver_token: "token" }); paginate.mockResolvedValue([]); await run();
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it("enforces the single-org constraint without a lookup", async () => {
    process.env.AGENT_ALLOWLIST = '["other-org/team"]';
    inputs({ principal: "alice", resolver_token: "token" }); await run();
    expect(paginate).not.toHaveBeenCalled();
    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('supported organization is "org"'));
  });

  it("passes through an intentionally skipped gate", async () => {
    inputs({ principal: "mallory", skip_gate: "true" }); await run();
    expect(core.setFailed).not.toHaveBeenCalled();
  });
});

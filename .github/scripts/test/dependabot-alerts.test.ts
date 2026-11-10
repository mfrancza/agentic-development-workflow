import { describe, expect, it, vi } from "vitest";
import { classifyAlert, DependabotReadError, discoverAlerts, normalizeAlert, readNpmSourceEvidence, revalidateAlert, revalidateEligibility, type Alert, type NpmSourceEvidence } from "../src/lib/dependabot-alerts.js";
import type { getOctokit } from "../src/lib/octokit.js";

type Octokit = ReturnType<typeof getOctokit>;
const sha = "a".repeat(40);

function rawAlert(): Record<string, unknown> {
  return {
    id: "alert-id", number: 7, state: "OPEN", vulnerableManifestFilename: "package-lock.json",
    vulnerableManifestPath: "app/package-lock.json", vulnerableRequirements: "<2", dependencyRelationship: "TRANSITIVE",
    securityAdvisory: { ghsaId: "GHSA-test-test-test", withdrawnAt: null },
    securityVulnerability: { vulnerableVersionRange: "<2", severity: "HIGH", package: { name: "vulnerable", ecosystem: "NPM" }, firstPatchedVersion: { identifier: "2.0.0" } },
    dependabotUpdate: { error: { errorType: "path_dependencies_not_reachable", title: "Local dependencies unavailable", body: "The following path based dependencies could not be retrieved: local-module" }, pullRequest: null },
  };
}

function alert(): Alert {
  const result = normalizeAlert("repository-id", rawAlert());
  if (!result) throw new Error("invalid fixture");
  return result;
}

function evidence(): NpmSourceEvidence {
  return {
    sha, manifest: JSON.stringify({ dependencies: { "local-module": "file:../local-module", parent: "^1.0.0" } }),
    lockfile: JSON.stringify({ lockfileVersion: 3, packages: {
      "": {}, "../local-module": { version: "1.0.0" }, "node_modules/local-module": { resolved: "../local-module", link: true },
      "node_modules/parent": { version: "1.0.0", resolved: "https://registry.npmjs.org/parent/-/parent-1.0.0.tgz" },
      "node_modules/parent/node_modules/vulnerable": { version: "1.0.0", resolved: "https://registry.npmjs.org/vulnerable/-/vulnerable-1.0.0.tgz" },
    } }), npmConfigs: [null, null], dependabotConfig: null,
  };
}

function client(graphql: ReturnType<typeof vi.fn>): Octokit { return { graphql } as unknown as Octokit; }
function page(nodes: unknown[], hasNextPage = false, endCursor: string | null = null): unknown {
  return { repository: { id: "repository-id", vulnerabilityAlerts: { nodes, pageInfo: { hasNextPage, endCursor } } } };
}
function blob(text: string): unknown { return { __typename: "Blob", text, isBinary: false, isTruncated: false }; }
function sourceResponse(source = evidence()): unknown {
  return { repository: { id: "repository-id", file0: blob(source.manifest), file1: blob(source.lockfile),
    file2: source.npmConfigs[0] === null ? null : blob(source.npmConfigs[0]),
    file3: source.npmConfigs[1] === null ? null : blob(source.npmConfigs[1]), file4: null, file5: null } };
}
const head = { repository: { id: "repository-id", defaultBranchRef: { target: { oid: sha } } } };

describe("alert normalization and classification", () => {
  it("recognizes the synthetic npm local-path case, not an upstream code alone", () => {
    expect(classifyAlert(alert(), evidence())).toEqual({ eligible: true });
    expect(classifyAlert(alert())).toEqual({ eligible: false, reason: "unverified-source-access" });
    const candidate = alert();
    candidate.update!.error!.body = "some other error";
    expect(classifyAlert(candidate, evidence())).toEqual({ eligible: false, reason: "unverified-error-shape" });
  });

  it.each([2, 3])("accepts npm v%s link targets with public dependency declarations", version => {
    const source = evidence();
    const lock = JSON.parse(source.lockfile);
    lock.lockfileVersion = version;
    lock.packages["../local-module"].dependencies = { public: "^1.0.0" };
    source.lockfile = JSON.stringify(lock);
    expect(classifyAlert(alert(), source)).toEqual({ eligible: true });
  });

  it.each([
    (packages: Record<string, Record<string, unknown>>) => { packages["../unrelated"] = { version: "1.0.0" }; },
    (packages: Record<string, Record<string, unknown>>) => { delete packages["node_modules/local-module"]; },
    (packages: Record<string, Record<string, unknown>>) => { packages["../local-module"].dependencies = { private: "git+ssh://private.example.test/repo" }; },
    (packages: Record<string, Record<string, unknown>>) => { packages["../local-module"].dependencies = { private: "file:../other" }; },
    (packages: Record<string, Record<string, unknown>>) => { packages["../local-module"].workspaces = ["packages/*"]; },
  ])("rejects unverified local-target evidence %#", modify => {
    const source = evidence();
    const lock = JSON.parse(source.lockfile);
    modify(lock.packages);
    source.lockfile = JSON.stringify(lock);
    expect(classifyAlert(alert(), source)).toEqual({ eligible: false, reason: "unverified-source-access" });
  });

  it.each([
    ["missing-data", (value: Alert) => { value.advisory = null; }],
    ["missing-data", (value: Alert) => { value.vulnerability = null; }],
    ["not-open", (value: Alert) => { value.state = "FIXED"; }],
    ["not-open", (value: Alert) => { value.state = "DISMISSED"; }],
    ["withdrawn-advisory", (value: Alert) => { value.advisory!.withdrawnAt = "2025-01-01T00:00:00Z"; }],
    ["no-patched-version", (value: Alert) => { value.vulnerability!.patchedVersion = null; }],
    ["no-update-error", (value: Alert) => { value.update = null; }],
    ["no-update-error", (value: Alert) => { value.update!.error = null; }],
    ["unsupported-ecosystem", (value: Alert) => { value.vulnerability!.ecosystem = "PIP"; }],
    ["unsupported-error", (value: Alert) => { value.update!.error!.type = "dependency_file_not_resolvable"; }],
    ["unsupported-error", (value: Alert) => { value.update!.error!.type = "private_source_authentication_failure"; }],
    ["unverified-source-access", (value: Alert) => { value.update!.error!.title = "Private registry authentication failed"; }],
    ["unverified-source-access", (value: Alert) => { value.relationship = "DIRECT"; }],
    ["unverified-source-access", (value: Alert) => { value.manifestPath = "../package-lock.json"; }],
    ["unverified-source-access", (value: Alert) => { value.manifestFilename = "yarn.lock"; }],
  ])("returns %s for a failed predicate", (reason, modify) => {
    const candidate = alert(); modify(candidate);
    expect(classifyAlert(candidate, evidence())).toEqual({ eligible: false, reason });
  });

  it.each([ ["OPEN", false], ["OPEN", true], ["CLOSED", false], ["MERGED", false] ])("rejects associated %s PR (draft=%s)", (state, isDraft) => {
    const candidate = alert(); candidate.update!.pullRequest = { number: 9, state, isDraft };
    expect(classifyAlert(candidate, evidence())).toEqual({ eligible: false, reason: "associated-pull-request" });
  });

  it.each([
    (source: NpmSourceEvidence) => { source.npmConfigs[0] = "//registry.npmjs.org/:_authToken=redacted"; },
    (source: NpmSourceEvidence) => { source.dependabotConfig = "registries:\n  private: {}"; },
    (source: NpmSourceEvidence) => { source.lockfile = source.lockfile.replace("registry.npmjs.org", "private.example.test"); },
    (source: NpmSourceEvidence) => { source.manifest = source.manifest.replace("file:../local-module", "git+ssh://private.example.test/repo"); },
    (source: NpmSourceEvidence) => { source.manifest = source.manifest.replace("local-module", "another-module"); },
    (source: NpmSourceEvidence) => { source.manifest = source.manifest.replace("file:../local-module", "file:/outside/repo"); },
    (source: NpmSourceEvidence) => { source.manifest = source.manifest.replace("\"dependencies\"", "\"workspaces\":[],\"dependencies\""); },
    (source: NpmSourceEvidence) => { source.lockfile = source.lockfile.replace("registry.npmjs.org/vulnerable/-/", "registry.npmjs.org/other/-/"); },
    (source: NpmSourceEvidence) => { source.lockfile = source.lockfile.replace('"resolved":"../local-module"', '"resolved":"../other"'); },
    (source: NpmSourceEvidence) => { source.lockfile = "{"; },
    (source: NpmSourceEvidence) => { source.npmConfigs = []; },
    (source: NpmSourceEvidence) => { source.sha = "main"; },
  ])("rejects ambiguous or private source evidence %#", modify => {
    const source = evidence(); modify(source);
    expect(classifyAlert(alert(), source)).toEqual({ eligible: false, reason: "unverified-source-access" });
  });

  it("rejects incomplete and malformed GraphQL fields", () => {
    for (const field of ["id", "number", "state", "vulnerableManifestPath", "vulnerableRequirements", "dependencyRelationship", "securityAdvisory", "securityVulnerability", "dependabotUpdate"]) {
      const raw = rawAlert(); delete raw[field];
      expect(normalizeAlert("repository-id", raw), field).toBeNull();
    }
    expect(normalizeAlert("repository-id", null)).toBeNull();
    const raw = rawAlert(); raw.securityVulnerability = { package: { ecosystem: "NPM", name: "vulnerable" }, vulnerableVersionRange: "<2" };
    expect(normalizeAlert("repository-id", raw)).toBeNull();
  });
});

describe("GraphQL discovery and revalidation", () => {
  it("paginates open alerts and preserves alert-specific patched version", async () => {
    const second = { ...rawAlert(), id: "second", number: 8 };
    const graphql = vi.fn().mockResolvedValueOnce(page([rawAlert()], true, "next")).mockResolvedValueOnce(page([second]));
    const alerts = await discoverAlerts(client(graphql), "owner", "repo");
    expect(alerts.map(item => item.number)).toEqual([7, 8]);
    expect(alerts[0].vulnerability?.patchedVersion).toBe("2.0.0");
    expect(alerts[0].vulnerability?.severity).toBe("HIGH");
    expect(graphql.mock.calls[0][0]).toContain("states: OPEN");
    expect(graphql.mock.calls[1][1].cursor).toBe("next");
  });

  it.each([
    page([null]), page([], true, null), { repository: null },
    { repository: { id: "repository-id", vulnerabilityAlerts: { nodes: [], pageInfo: null } } },
    { errors: [{ message: "sensitive" }], ...page([]) as object },
  ])("rejects incomplete responses %# without exposing payloads", async response => {
    await expect(discoverAlerts(client(vi.fn().mockResolvedValue(response)), "owner", "repo")).rejects.toThrow("Dependabot data could not be read completely");
  });

  it("rejects repeated cursors and thrown partial/denied API errors", async () => {
    await expect(discoverAlerts(client(vi.fn().mockResolvedValue(page([], true, "same"))), "o", "r")).rejects.toBeInstanceOf(DependabotReadError);
    await expect(discoverAlerts(client(vi.fn().mockRejectedValue(new Error("sensitive response"))), "o", "r")).rejects.toThrow("Dependabot data could not be read completely");
  });

  it("refetches current data and checks identity", async () => {
    const current = { ...rawAlert(), state: "FIXED" };
    const graphql = vi.fn().mockResolvedValue({ repository: { id: "repository-id", vulnerabilityAlert: current } });
    const result = await revalidateAlert(client(graphql), "o", "r", alert());
    expect(classifyAlert(result)).toEqual({ eligible: false, reason: "not-open" });
    expect(graphql.mock.calls[0][1].number).toBe(7);
    graphql.mockResolvedValue({ repository: { id: "repository-id", vulnerabilityAlert: { ...current, id: "other" } } });
    await expect(revalidateAlert(client(graphql), "o", "r", alert())).rejects.toBeInstanceOf(DependabotReadError);
    graphql.mockResolvedValue({ repository: { id: "repository-id", vulnerabilityAlert: null } });
    expect(await revalidateAlert(client(graphql), "o", "r", alert())).toBeNull();
  });
});

describe("pinned source evidence", () => {
  it("reads manifest, lockfile and configuration at one default-branch SHA", async () => {
    const graphql = vi.fn().mockResolvedValueOnce(head).mockResolvedValueOnce(sourceResponse());
    const result = await readNpmSourceEvidence(client(graphql), "o", "r", alert());
    expect(result).toEqual(evidence());
    expect(Object.values(graphql.mock.calls[1][1]).filter(value => typeof value === "string" && value.startsWith(`${sha}:`))).toEqual([
      `${sha}:app/package.json`, `${sha}:app/package-lock.json`, `${sha}:.npmrc`, `${sha}:app/.npmrc`, `${sha}:.github/dependabot.yml`, `${sha}:.github/dependabot.yaml`,
    ]);
  });

  it("rejects missing fields, truncation, and API failures", async () => {
    for (const response of [ { repository: { id: "repository-id" } }, { errors: ["denied"], ...sourceResponse() as object },
      { repository: { ...(sourceResponse() as { repository: object }).repository, file0: { __typename: "Blob", text: "{}", isBinary: false, isTruncated: true } } } ]) {
      const graphql = vi.fn().mockResolvedValueOnce(head).mockResolvedValueOnce(response);
      await expect(readNpmSourceEvidence(client(graphql), "o", "r", alert())).rejects.toBeInstanceOf(DependabotReadError);
    }
  });

  it("revalidates alert and checks the source SHA again before returning eligible", async () => {
    const reader = client(vi.fn().mockResolvedValue({ repository: { id: "repository-id", vulnerabilityAlert: rawAlert() } }));
    const content = vi.fn().mockResolvedValueOnce(head).mockResolvedValueOnce(sourceResponse()).mockResolvedValueOnce(head);
    expect((await revalidateEligibility(reader, client(content), "o", "r", alert())).eligibility).toEqual({ eligible: true });
    const changed = { repository: { id: "repository-id", defaultBranchRef: { target: { oid: "b".repeat(40) } } } };
    const stale = vi.fn().mockResolvedValueOnce(head).mockResolvedValueOnce(sourceResponse()).mockResolvedValueOnce(changed);
    await expect(revalidateEligibility(reader, client(stale), "o", "r", alert())).rejects.toBeInstanceOf(DependabotReadError);
  });
});

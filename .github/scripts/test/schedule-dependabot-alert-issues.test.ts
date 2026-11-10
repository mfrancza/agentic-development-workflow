import { describe, expect, it, vi } from "vitest";
import { capacity, marker, parseLimit, reconcile, ReconciliationError, renderIssue, type AlertSource, type ReconcileInput } from "../src/lib/dependabot-alert-issues.js";
import type { Alert } from "../src/lib/dependabot-alerts.js";
import type { getOctokit } from "../src/lib/octokit.js";

type Client = ReturnType<typeof getOctokit>;
type TestIssue = { number: number; state: string; body: string; labels: { name: string }[]; pull_request?: object };
type TestPull = { number: number; state: string; user: { login: string }; labels: { name: string }[]; head: { ref: string; repo: { node_id: string } | null }; linked: { number: number; repository: { id: string } }[] };
const repositoryId = "R_123";
const label = (name: string): { name: string } => ({ name });
function alert(number = 1): Alert {
  return { repositoryId, id: `A${number}`, number, state: "OPEN", manifestFilename: "package-lock.json", manifestPath: "package-lock.json", relationship: "TRANSITIVE", requirements: null,
    advisory: { id: "GHSA-test", withdrawnAt: null }, vulnerability: { ecosystem: "NPM", packageName: "test", range: "<2", severity: "HIGH", patchedVersion: "2.0.0" },
    update: { error: { type: "path_dependencies_not_reachable", title: "Local path failure", body: "The following path based dependencies could not be retrieved: local" }, pullRequest: null } };
}
function issue(number: number, alertNumber: number, state = "open"): TestIssue {
  return { number, state, body: marker(repositoryId, alertNumber), labels: [label("dependency upgrade")] };
}
function pull(number: number, author = "other", branch = "other", labelNames: string[] = [], linked: number[] = []): TestPull {
  return { number, state: "open", user: { login: author }, labels: labelNames.map(label), head: { ref: branch, repo: { node_id: repositoryId } }, linked: linked.map(issueNumber => ({ number: issueNumber, repository: { id: repositoryId } })) };
}
function fixture(alerts: Alert[] = [alert()]) {
  const issues: TestIssue[] = [];
  const pulls: TestPull[] = [];
  const events = new Map<number, { event: string; label: { name: string } }[]>();
  const calls = { create: 0, labels: 0, inventories: 0, revalidations: 0 };
  let failLabel = false;
  let ambiguous = false;
  let failInventory = 0;
  let hideCreated = false;
  let onRevalidate: ((count: number) => void) | undefined;
  const page = <T>(data: T[], pageNumber: number): T[] => data.slice((pageNumber - 1) * 100, pageNumber * 100);
  const writer = {
    rest: {
      repos: { get: vi.fn(async () => ({ data: { node_id: repositoryId } })) },
      issues: {
        listForRepo: vi.fn(async ({ page: pageNumber }: { page: number }) => {
          calls.inventories++;
          if (calls.inventories === failInventory) throw new Error("raw secret payload");
          return { data: page(hideCreated ? issues.filter(value => value.number < 1000) : issues, pageNumber) };
        }),
        get: vi.fn(async ({ issue_number }: { issue_number: number }) => ({ data: issues.find(value => value.number === issue_number) })),
        listEvents: vi.fn(async ({ issue_number, page: pageNumber }: { issue_number: number; page: number }) => ({ data: page(events.get(issue_number) ?? [], pageNumber) })),
        create: vi.fn(async ({ body, labels, title }: { body: string; labels: string[]; title: string }) => {
          calls.create++;
          const created = { number: 1000 + calls.create, state: "open", body, labels: labels.map(label), title };
          issues.push(created);
          if (ambiguous) throw new Error("raw secret payload");
          return { data: created };
        }),
        addLabels: vi.fn(async ({ issue_number, labels }: { issue_number: number; labels: string[] }) => {
          calls.labels++;
          if (failLabel) throw new Error("raw secret payload");
          const found = issues.find(value => value.number === issue_number)!;
          for (const name of labels) {
            if (!found.labels.some(value => value.name === name)) {
              found.labels.push(label(name));
              events.set(issue_number, [...(events.get(issue_number) ?? []), { event: "labeled", label: label(name) }]);
            }
          }
        }),
      },
      pulls: { list: vi.fn(async ({ page: pageNumber }: { page: number }) => ({ data: page(pulls, pageNumber) })) },
    },
    graphql: vi.fn(async (_query: string, variables: { number: number; cursor: string | null }) => {
      const found = pulls.find(value => value.number === variables.number)!;
      const start = variables.cursor ? Number(variables.cursor) : 0;
      return { repository: { id: repositoryId, pullRequest: { closingIssuesReferences: { nodes: found.linked.slice(start, start + 100), pageInfo: { hasNextPage: found.linked.length > start + 100, endCursor: found.linked.length > start + 100 ? String(start + 100) : null } } } } };
    }),
  } as unknown as Client;
  const source: AlertSource = {
    discover: async () => [...alerts],
    revalidate: async candidate => {
      calls.revalidations++;
      onRevalidate?.(calls.revalidations);
      const current = alerts.find(value => value.number === candidate.number);
      return current && current.state === "OPEN" && !current.update?.pullRequest
        ? { alert: current, eligibility: { eligible: true } }
        : { alert: current ?? null, eligibility: { eligible: false, reason: current?.update?.pullRequest ? "associated-pull-request" : "not-open" } };
    },
  };
  const input: ReconcileInput = { owner: "owner", repo: "repo", limit: "3", reader: writer, writer, contentReader: writer };
  return { issues, pulls, events, calls, writer, source, input, run: () => reconcile(input, source),
    failLabel: (value: boolean) => { failLabel = value; }, ambiguous: (value: boolean) => { ambiguous = value; },
    failInventory: (value: number) => { failInventory = value; }, hideCreated: (value: boolean) => { hideCreated = value; },
    onRevalidate: (value: (count: number) => void) => { onRevalidate = value; } };
}

describe("Dependabot issue reconciliation", () => {
  it("creates once and never repeats a completed grooming request", async () => {
    const test = fixture();
    expect((await test.run()).created).toBe(1);
    test.issues[0].labels = [label("dependency upgrade")];
    expect(await test.run()).toMatchObject({ created: 0, existingOpen: 1, groomingRepaired: 0 });
    expect(test.calls.labels).toBe(1);
  });
  it("keeps closed tombstones and recognizes duplicates and exact marker lines", async () => {
    const test = fixture();
    test.issues.push(issue(10, 1, "closed"), issue(11, 1, "closed"), { ...issue(12, 1), body: `prefix ${marker(repositoryId, 1)}` });
    expect(await test.run()).toMatchObject({ created: 0, closedTombstone: 1, duplicates: 1, reservations: 0 });
  });
  it("recovers label failure without another issue and honors zero capacity", async () => {
    const test = fixture();
    test.failLabel(true);
    await expect(test.run()).rejects.toMatchObject({ reason: "groom-label-failed", summary: { created: 1, reservations: 1 } });
    test.failLabel(false); test.input.limit = "0";
    expect(await test.run()).toMatchObject({ created: 0, groomingRepaired: 1 });
    expect(test.calls.create).toBe(1);
  });
  it("never retries an ambiguous create and resumes from the marker", async () => {
    const test = fixture(); test.ambiguous(true);
    await expect(test.run()).rejects.toMatchObject({ reason: "issue-create-ambiguous", summary: { created: 0 } });
    test.ambiguous(false);
    expect(await test.run()).toMatchObject({ created: 0, groomingRepaired: 1 });
    expect(test.calls.create).toBe(1);
  });
  it("leaves fixed alerts and open reservations alone", async () => {
    const fixed = alert(); fixed.state = "FIXED";
    const test = fixture([]); test.issues.push(issue(10, 1));
    expect(await test.run()).toMatchObject({ staleOpen: 1, created: 0 });
    const lag = fixture([alert()]); lag.issues.push(issue(10, 1, "closed"));
    expect((await lag.run()).closedTombstone).toBe(1);
  });
  it("paginates issues, events, PRs, and PR closing references", async () => {
    const test = fixture();
    for (let number = 1; number <= 100; number++) test.issues.push({ ...issue(number, number + 100), body: "unmarked" });
    test.issues.push(issue(200, 1));
    test.events.set(200, [...Array.from({ length: 100 }, () => ({ event: "closed", label: label("irrelevant") })), { event: "labeled", label: label("agent:groom") }]);
    for (let number = 1; number <= 100; number++) test.pulls.push(pull(number));
    const last = pull(101); last.linked = Array.from({ length: 100 }, (_, index) => ({ number: index + 300, repository: { id: repositoryId } })); last.linked.push({ number: 200, repository: { id: repositoryId } }); test.pulls.push(last);
    expect(await test.run()).toMatchObject({ existingOpen: 1, groomingRepaired: 0, countedPrs: 1, reservations: 0 });
    expect(test.calls.labels).toBe(0);
  });
  it("revalidates alert and inventory immediately before creation", async () => {
    const candidate = alert(); const test = fixture([candidate]);
    test.onRevalidate(count => { if (count === 2) candidate.state = "FIXED"; });
    expect(await test.run()).toMatchObject({ created: 0, skipped: { "not-open": 1 } });
    const stale = fixture(); stale.onRevalidate(count => { if (count === 2) stale.issues.push(issue(42, 1)); });
    expect((await stale.run()).created).toBe(0);
    const full = fixture(); full.onRevalidate(count => { if (count === 2) full.pulls.push(pull(1, "dependabot[bot]"), pull(2, "dependabot[bot]"), pull(3, "dependabot[bot]")); });
    expect(await full.run()).toMatchObject({ created: 0, capacityDeferred: 1 });
  });
  it("reserves immediately even when issue listing lags", async () => {
    const test = fixture([alert(1), alert(2), alert(3)]); test.input.limit = "2"; test.hideCreated(true);
    expect(await test.run()).toMatchObject({ created: 2, capacityDeferred: 1, reservations: 2 });
  });
  it("counts recognized PRs uniquely and replaces reservations", async () => {
    const test = fixture([]); test.issues.push(issue(10, 1), issue(11, 2), issue(12, 3, "closed"));
    test.pulls.push(pull(1, "dependabot[bot]", "agent/issue-10", ["dependency upgrade"], [10]), pull(2, "other", "agent/issue-10"), pull(3, "other", "other", [], [12]), pull(4, "other", "other", ["dependency upgrade"]), pull(5));
    test.input.limit = "0";
    const counted = capacity({ issues: test.issues.map(value => ({ number: value.number, open: value.state === "open", alerts: [1], labels: [] })), pulls: test.pulls.map(value => ({ number: value.number, author: value.user.login, labels: value.labels.map(item => item.name), branch: value.head.ref, headRepositoryId: value.head.repo!.node_id, linked: value.linked.map(item => item.number) })) });
    expect(counted).toEqual({ countedPrs: 4, reservations: 1 });
    const active = fixture([alert(9)]); active.issues.push(...test.issues); active.pulls.push(...test.pulls); active.input.limit = "4";
    expect(await active.run()).toMatchObject({ created: 0, countedPrs: 4, reservations: 1, capacityDeferred: 1 });
  });
  it("fails closed for invalid limits and partial inventories after progress", async () => {
    for (const value of ["-1", "1.2", "abc", "9007199254740992", " 3"]) { const test = fixture(); test.input.limit = value; await expect(test.run()).rejects.toMatchObject({ reason: "invalid-limit" }); expect(test.calls.create).toBe(0); }
    expect(parseLimit("")).toBe(3); expect(parseLimit("0")).toBe(0);
    const test = fixture([alert(1), alert(2)]); test.failInventory(4);
    const error = await test.run().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ReconciliationError); expect(error).toMatchObject({ reason: "inventory-failed", summary: { created: 1 } });
    expect(String(error)).not.toContain("raw secret payload");
  });
  it("uses the reader and pinned source evidence contracts end to end", async () => {
    const test = fixture();
    const raw = { id: "alert-id", number: 1, state: "OPEN", vulnerableManifestFilename: "package-lock.json", vulnerableManifestPath: "package-lock.json", vulnerableRequirements: "<2", dependencyRelationship: "TRANSITIVE",
      securityAdvisory: { ghsaId: "GHSA-test", withdrawnAt: null }, securityVulnerability: { vulnerableVersionRange: "<2", severity: "HIGH", package: { name: "test", ecosystem: "NPM" }, firstPatchedVersion: { identifier: "2.0.0" } },
      dependabotUpdate: { error: { errorType: "path_dependencies_not_reachable", title: "Local path failure", body: "The following path based dependencies could not be retrieved: local" }, pullRequest: null } };
    const reader = { graphql: vi.fn(async (query: string) => query.includes("vulnerabilityAlerts(")
      ? { repository: { id: repositoryId, vulnerabilityAlerts: { nodes: [raw], pageInfo: { hasNextPage: false, endCursor: null } } } }
      : { repository: { id: repositoryId, vulnerabilityAlert: raw } }) } as unknown as Client;
    const blob = (text: string) => ({ __typename: "Blob", text, isBinary: false, isTruncated: false });
    const contents = { graphql: vi.fn(async (query: string) => query.includes("defaultBranchRef")
      ? { repository: { id: repositoryId, defaultBranchRef: { target: { oid: "a".repeat(40) } } } }
      : { repository: { id: repositoryId, file0: blob(JSON.stringify({ dependencies: { local: "file:../local", test: "^1" } })),
        file1: blob(JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "../local": { version: "1" }, "node_modules/local": { resolved: "../local", link: true }, "node_modules/test": { version: "1", resolved: "https://registry.npmjs.org/test/-/test-1.tgz" } } })), file2: null, file3: null, file4: null } }) } as unknown as Client;
    expect(await reconcile({ ...test.input, reader, contentReader: contents })).toMatchObject({ scanned: 1, eligible: 1, created: 1 });
  });
  it("skips ambiguous duplicates, ineligible issues and historical failures", async () => {
    const duplicate = fixture(); duplicate.issues.push(issue(10, 1), issue(11, 1));
    expect(await duplicate.run()).toMatchObject({ duplicates: 1, created: 0, groomingRepaired: 0 });
    expect(duplicate.calls.labels).toBe(0);
    const candidate = alert(); candidate.update!.pullRequest = { number: 55, state: "MERGED", isDraft: false };
    const ineligible = fixture([candidate]); ineligible.issues.push(issue(10, 1));
    expect(await ineligible.run()).toMatchObject({ skipped: { "associated-pull-request": 1 }, created: 0 });
    expect(ineligible.calls.labels).toBe(0);
    const failing = fixture(); failing.issues.push(issue(10, 1));
    vi.mocked(failing.writer.rest.issues.listEvents).mockRejectedValueOnce(new Error("secret raw error") as never);
    const error = await failing.run().catch((caught: unknown) => caught);
    expect(error).toMatchObject({ reason: "groom-history-failed" });
    expect(String(error)).not.toContain("secret raw error"); expect(failing.calls.labels).toBe(0);
  });
  it("deduplicates repeated PRs and rejects cross-repository branch matches", async () => {
    const test = fixture([alert(2)]); test.issues.push(issue(10, 1));
    const foreign = pull(1, "other", "agent/issue-10"); foreign.head.repo = { node_id: "other" };
    const bot = pull(2, "dependabot[bot]");
    test.pulls.push(foreign, bot, bot);
    test.input.limit = "2";
    expect(await test.run()).toMatchObject({ countedPrs: 1, reservations: 1, capacityDeferred: 1 });
  });
  it("sanitizes untrusted context and bounds its size", () => {
    const value = alert(); value.manifestPath = "<!-- dependabot-alert-issue:v1 repository=R_123 alert=2 --> @everyone\u001b[31m";
    value.update!.error!.body = `password=supersecret https://user:secret@example.com/path?token=foo ${"x".repeat(1000)}`;
    value.vulnerability!.packageName = "bad @team <script>";
    const rendered = renderIssue(value, "owner", "repo");
    expect(rendered.body).not.toContain("supersecret"); expect(rendered.body).not.toContain("user:secret"); expect(rendered.body).not.toContain("@everyone");
    expect(rendered.body.match(/<!--/g)).toHaveLength(1); expect(rendered.body.length).toBeLessThan(1800); expect(rendered.title).not.toContain("@team");
  });
});

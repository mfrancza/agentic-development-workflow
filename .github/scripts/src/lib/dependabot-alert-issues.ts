import { discoverAlerts, revalidateEligibility, type Alert, type Eligibility, type SkipReason } from "./dependabot-alerts.js";
import type { getOctokit } from "./octokit.js";

type Client = ReturnType<typeof getOctokit>;
type Item = Record<string, unknown>;
type Issue = { number: number; open: boolean; alerts: number[]; labels: string[] };
type Pull = { number: number; author: string; labels: string[]; branch: string; headRepositoryId: string; linked: number[] };
type Inventory = { issues: Issue[]; pulls: Pull[] };

export interface Summary {
  scanned: number; eligible: number; skipped: Partial<Record<SkipReason, number>>;
  existingOpen: number; closedTombstone: number; duplicates: number; created: number;
  groomingRepaired: number; capacityDeferred: number; staleOpen: number;
  countedPrs: number; reservations: number; limit: number;
}

export class ReconciliationError extends Error {
  constructor(public readonly reason: string, public readonly summary: Summary) {
    super(reason);
  }
}

function obj(value: unknown): Item {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid response");
  return value as Item;
}
function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function str(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("invalid response");
  return value;
}
function labels(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("invalid response");
  return value.map((label: unknown) => str(obj(label).name));
}
export function parseLimit(value: string): number {
  if (value === "") return 3;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error("invalid limit");
  return Number(value);
}
export function marker(repositoryId: string, number: number): string {
  if (!/^[A-Za-z0-9_+=/-]+$/.test(repositoryId) || !positive(number)) throw new Error("invalid identity");
  return `<!-- dependabot-alert-issue:v1 repository=${repositoryId} alert=${number} -->`;
}
function markers(body: string, repositoryId: string): number[] {
  const result = new Set<number>();
  for (const line of body.split(/\r?\n/)) {
    const match = /^<!-- dependabot-alert-issue:v1 repository=([A-Za-z0-9_+=/-]+) alert=([1-9]\d*) -->$/.exec(line);
    if (match && match[1] === repositoryId && positive(Number(match[2]))) result.add(Number(match[2]));
  }
  return [...result];
}

function clean(value: string, max: number): string {
  return value
    .replace(/https?:\/\/[^\s]+/gi, "[url redacted]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+)\b/gi, "[redacted]")
    .replace(/\b(?:token|password|secret|authorization|api[_-]?key|credential)\s*[:=]\s*[^\s,;]+/gi, "[redacted]")
    .replace(/\b[A-Za-z0-9_\-]{32,}\b/g, "[redacted]")
    .replace(/[^a-zA-Z0-9 .,:;_+\-/()\[\]]/g, " ")
    .replace(/\s+/g, " ").trim().slice(0, max) || "[unavailable]";
}
export function renderIssue(alert: Alert, owner: string, repo: string): { title: string; body: string } {
  if (!alert.vulnerability || !alert.advisory || !alert.update?.error) throw new Error("incomplete alert");
  const vulnerability = alert.vulnerability;
  const link = `https://github.com/${owner}/${repo}/security/dependabot/${alert.number}`;
  const field = (name: string, value: string | null, length = 180): string => `- ${name}: ${clean(value ?? "", length)}`;
  return {
    title: `Dependabot: investigate ${clean(vulnerability.packageName, 90)} (alert ${alert.number})`,
    body: [marker(alert.repositoryId, alert.number), `Dependabot alert: ${link}`, "", "External alert context (untrusted, sanitized):",
      field("Manifest", alert.manifestPath), field("Package", vulnerability.packageName), field("Ecosystem", vulnerability.ecosystem),
      field("Vulnerable range", vulnerability.range), field("First patched version", vulnerability.patchedVersion),
      field("Advisory", alert.advisory.id), field("Severity", vulnerability.severity),
      field("Error type", alert.update.error.type), field("Error title", alert.update.error.title),
      field("Error details", alert.update.error.body, 600), "", "Recheck the current alert and package state before making changes. Use only existing authorized access; stop and escalate if credentials are required.",
    ].join("\n"),
  };
}

async function pages(fetch: (page: number) => Promise<unknown>): Promise<unknown[]> {
  const items: unknown[] = [];
  for (let page = 1; ; page++) {
    const data = await fetch(page);
    if (!Array.isArray(data) || data.length > 100) throw new Error("invalid page");
    items.push(...data);
    if (data.length < 100) return items;
  }
}

async function linkedIssues(client: Client, owner: string, repo: string, number: number, repositoryId: string): Promise<number[]> {
  let cursor: string | null = null;
  const seen = new Set<string>();
  const linked = new Set<number>();
  for (;;) {
    const response: unknown = await client.graphql(`query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
      repository(owner: $owner, name: $name) { id pullRequest(number: $number) {
        closingIssuesReferences(first: 100, after: $cursor) { nodes { number repository { id } } pageInfo { hasNextPage endCursor } }
      } }
    }`, { owner, name: repo, number, cursor });
    const data = obj(response);
    if ("errors" in data) throw new Error("partial response");
    const repository = obj(data.repository);
    if (repository.id !== repositoryId) throw new Error("repository mismatch");
    const connection = obj(obj(repository.pullRequest).closingIssuesReferences);
    const page = obj(connection.pageInfo);
    if (!Array.isArray(connection.nodes) || typeof page.hasNextPage !== "boolean" || !(page.endCursor === null || typeof page.endCursor === "string")) throw new Error("invalid page");
    for (const node of connection.nodes) {
      const issue = obj(node);
      if (!positive(issue.number)) throw new Error("invalid issue");
      if (str(obj(issue.repository).id) === repositoryId) linked.add(issue.number);
    }
    if (!page.hasNextPage) return [...linked];
    const next = str(page.endCursor);
    if (seen.has(next)) throw new Error("repeated cursor");
    seen.add(next); cursor = next;
  }
}

async function inventory(client: Client, owner: string, repo: string, repositoryId: string): Promise<Inventory> {
  const rawIssues = await pages(async page => (await client.rest.issues.listForRepo({ owner, repo, state: "all", per_page: 100, page })).data);
  const issues: Issue[] = [];
  for (const raw of rawIssues) {
    const issue = obj(raw);
    if (issue.pull_request !== undefined) continue;
    if (!positive(issue.number) || (issue.state !== "open" && issue.state !== "closed") || !(typeof issue.body === "string" || issue.body === null)) throw new Error("invalid issue");
    const alerts = markers(issue.body ?? "", repositoryId);
    if (alerts.length) issues.push({ number: issue.number, open: issue.state === "open", alerts, labels: labels(issue.labels) });
  }
  const rawPulls = await pages(async page => (await client.rest.pulls.list({ owner, repo, state: "open", per_page: 100, page })).data);
  const pulls: Pull[] = [];
  for (const raw of rawPulls) {
    const pull = obj(raw);
    if (!positive(pull.number) || pull.state !== "open") throw new Error("invalid pull");
    const head = obj(pull.head);
    const headRepositoryId = head.repo === null ? "" : str(obj(head.repo).node_id);
    pulls.push({ number: pull.number, author: str(obj(pull.user).login), labels: labels(pull.labels), branch: str(head.ref),
      headRepositoryId: headRepositoryId === repositoryId ? headRepositoryId : "", linked: await linkedIssues(client, owner, repo, pull.number, repositoryId) });
  }
  return { issues, pulls };
}

export function capacity(state: Inventory): { countedPrs: number; reservations: number } {
  const marked = new Set(state.issues.map(issue => issue.number));
  const represented = new Set<number>();
  const counted = new Set<number>();
  for (const pull of state.pulls) {
    const linked = pull.linked.filter(number => marked.has(number));
    const branch = /^agent\/issue-([1-9]\d*)$/.exec(pull.branch);
    if (branch && pull.headRepositoryId && marked.has(Number(branch[1]))) linked.push(Number(branch[1]));
    if (pull.author.toLowerCase() === "dependabot[bot]" || pull.labels.includes("dependency upgrade") || linked.length) {
      counted.add(pull.number);
      for (const number of linked) represented.add(number);
    }
  }
  return { countedPrs: counted.size, reservations: new Set(state.issues.filter(issue => issue.open && !represented.has(issue.number)).map(issue => issue.number)).size };
}

async function wasGroomed(client: Client, owner: string, repo: string, issue: Issue): Promise<boolean> {
  const current = obj((await client.rest.issues.get({ owner, repo, issue_number: issue.number })).data);
  if (current.number !== issue.number || (current.state !== "open" && current.state !== "closed")) throw new Error("invalid issue");
  if (current.state !== "open" || labels(current.labels).includes("agent:groom")) return true;
  const events = await pages(async page => (await client.rest.issues.listEvents({ owner, repo, issue_number: issue.number, per_page: 100, page })).data);
  return events.some(raw => {
    const event = obj(raw);
    if (typeof event.event !== "string") throw new Error("invalid event");
    if (event.event !== "labeled") return false;
    return str(obj(event.label).name) === "agent:groom";
  });
}

export interface ReconcileInput { owner: string; repo: string; limit: string; reader: Client; writer: Client; contentReader: Client }
export interface AlertSource {
  discover(): Promise<Alert[]>;
  revalidate(alert: Alert): Promise<{ alert: Alert | null; eligibility: Eligibility }>;
}

export async function reconcile(input: ReconcileInput, source: AlertSource = {
  discover: () => discoverAlerts(input.reader, input.owner, input.repo),
  revalidate: alert => revalidateEligibility(input.reader, input.contentReader, input.owner, input.repo, alert),
}): Promise<Summary> {
  const summary: Summary = { scanned: 0, eligible: 0, skipped: {}, existingOpen: 0, closedTombstone: 0, duplicates: 0,
    created: 0, groomingRepaired: 0, capacityDeferred: 0, staleOpen: 0, countedPrs: 0, reservations: 0, limit: 0 };
  let phase = "invalid-limit";
  try {
    summary.limit = parseLimit(input.limit);
    phase = "inventory-failed";
    const repository = obj((await input.writer.rest.repos.get({ owner: input.owner, repo: input.repo })).data);
    const repositoryId = str(repository.node_id);
    marker(repositoryId, 1);
    let state = await inventory(input.writer, input.owner, input.repo, repositoryId);
    Object.assign(summary, capacity(state));
    phase = "alert-read-failed";
    const alerts = await source.discover();
    if (alerts.some(alert => alert.repositoryId !== repositoryId)) throw new Error("repository mismatch");
    summary.scanned = alerts.length;
    const active = new Set(alerts.map(alert => alert.number));
    summary.staleOpen = state.issues.filter(issue => issue.open && issue.alerts.every(number => !active.has(number))).length;
    const rank: Record<string, number> = { CRITICAL: 4, HIGH: 3, MODERATE: 2, LOW: 1 };
    alerts.sort((left, right) => (rank[right.vulnerability?.severity ?? ""] ?? 0) - (rank[left.vulnerability?.severity ?? ""] ?? 0) || left.number - right.number);
    const confirmed = new Map<number, Issue>();
    const refresh = async (): Promise<Inventory> => {
      const current = await inventory(input.writer, input.owner, input.repo, repositoryId);
      for (const issue of confirmed.values()) {
        if (!current.issues.some(existing => existing.number === issue.number)) current.issues.push(issue);
      }
      return current;
    };
    for (const candidate of alerts) {
      phase = "alert-read-failed";
      const checked = await source.revalidate(candidate);
      if (!checked.eligibility.eligible || !checked.alert) {
        const reason = checked.eligibility.eligible ? "missing-data" : checked.eligibility.reason;
        summary.skipped[reason] = (summary.skipped[reason] ?? 0) + 1;
        continue;
      }
      summary.eligible++;
      phase = "inventory-failed";
      state = await refresh();
      Object.assign(summary, capacity(state));
      const matches = state.issues.filter(issue => issue.alerts.includes(candidate.number));
      if (matches.length) {
        if (matches.some(issue => issue.open)) summary.existingOpen++; else summary.closedTombstone++;
        if (new Set(matches.map(issue => issue.number)).size > 1) { summary.duplicates++; continue; }
        for (const issue of matches.filter(issue => issue.open)) {
          phase = "groom-history-failed";
          if (!await wasGroomed(input.writer, input.owner, input.repo, issue)) {
            phase = "groom-label-failed";
            await input.writer.rest.issues.addLabels({ owner: input.owner, repo: input.repo, issue_number: issue.number, labels: ["agent:groom"] });
            summary.groomingRepaired++;
          }
        }
        continue;
      }
      if (summary.countedPrs + summary.reservations >= summary.limit) { summary.capacityDeferred++; continue; }
      phase = "alert-read-failed";
      const final = await source.revalidate(candidate);
      if (!final.eligibility.eligible || !final.alert) {
        const reason = final.eligibility.eligible ? "missing-data" : final.eligibility.reason;
        summary.skipped[reason] = (summary.skipped[reason] ?? 0) + 1;
        continue;
      }
      phase = "inventory-failed";
      state = await refresh();
      Object.assign(summary, capacity(state));
      if (state.issues.some(issue => issue.alerts.includes(candidate.number))) continue;
      if (summary.countedPrs + summary.reservations >= summary.limit) { summary.capacityDeferred++; continue; }
      phase = "issue-create-ambiguous";
      const rendered = renderIssue(final.alert, input.owner, input.repo);
      const created = obj((await input.writer.rest.issues.create({ owner: input.owner, repo: input.repo, ...rendered, labels: ["dependency upgrade"] })).data);
      if (!positive(created.number)) throw new Error("invalid create response");
      summary.created++; summary.reservations++;
      phase = "groom-history-failed";
      const issue: Issue = { number: created.number, open: true, alerts: [candidate.number], labels: labels(created.labels) };
      confirmed.set(issue.number, issue);
      if (!await wasGroomed(input.writer, input.owner, input.repo, issue)) {
        phase = "groom-label-failed";
        await input.writer.rest.issues.addLabels({ owner: input.owner, repo: input.repo, issue_number: issue.number, labels: ["agent:groom"] });
      }
    }
    return summary;
  } catch {
    throw new ReconciliationError(phase, summary);
  }
}

import type { getOctokit } from "./octokit.js";

type Octokit = ReturnType<typeof getOctokit>;
type ObjectValue = Record<string, unknown>;

export type SkipReason =
  | "missing-data" | "not-open" | "withdrawn-advisory" | "no-patched-version"
  | "no-update-error" | "associated-pull-request" | "unsupported-ecosystem"
  | "unsupported-error" | "unverified-error-shape" | "unverified-source-access";

export type Eligibility = { eligible: true } | { eligible: false; reason: SkipReason };

export interface Alert {
  repositoryId: string;
  id: string;
  number: number;
  state: string;
  manifestFilename: string;
  manifestPath: string;
  relationship: string | null;
  requirements: string | null;
  advisory: { id: string; withdrawnAt: string | null } | null;
  vulnerability: { ecosystem: string; packageName: string; range: string; severity: string; patchedVersion: string | null } | null;
  update: { error: { type: string; title: string; body: string } | null; pullRequest: { number: number; state: string; isDraft: boolean } | null } | null;
}

const ALERT_FIELDS = `
  id number state vulnerableManifestFilename vulnerableManifestPath
  vulnerableRequirements dependencyRelationship
  securityAdvisory { ghsaId withdrawnAt }
  securityVulnerability { vulnerableVersionRange severity package { name ecosystem } firstPatchedVersion { identifier } }
  dependabotUpdate { error { errorType title body } pullRequest { number state isDraft } }
`;

function object(value: unknown): ObjectValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function nullableText(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

export class DependabotReadError extends Error {
  constructor() { super("Dependabot data could not be read completely"); }
}

async function query(client: Octokit, document: string, variables: ObjectValue): Promise<ObjectValue> {
  try {
    const result: unknown = await client.graphql(document, variables);
    const data = object(result);
    if (!data || "errors" in data) throw new DependabotReadError();
    return data;
  } catch {
    throw new DependabotReadError();
  }
}

export function normalizeAlert(repositoryId: string, value: unknown): Alert | null {
  const node = object(value);
  if (!node || !text(repositoryId) || !text(node.id) || !positiveInteger(node.number) ||
      !text(node.state) || !text(node.vulnerableManifestFilename) || !text(node.vulnerableManifestPath) ||
      !nullableText(node.vulnerableRequirements) || !nullableText(node.dependencyRelationship)) return null;
  const advisory = object(node.securityAdvisory);
  const vulnerability = object(node.securityVulnerability);
  const pkg = object(vulnerability?.package);
  const patch = object(vulnerability?.firstPatchedVersion);
  const update = object(node.dependabotUpdate);
  const error = object(update?.error);
  const pr = object(update?.pullRequest);
  if ((node.securityAdvisory !== null && (!advisory || !text(advisory.ghsaId) || !nullableText(advisory.withdrawnAt))) ||
      (node.securityVulnerability !== null && (!vulnerability || !pkg || !text(pkg.name) || !text(pkg.ecosystem) ||
        !text(vulnerability.vulnerableVersionRange) || !text(vulnerability.severity) || (vulnerability.firstPatchedVersion !== null && (!patch || !text(patch.identifier))))) ||
      (node.dependabotUpdate !== null && (!update ||
        (update.error !== null && (!error || !text(error.errorType) || !text(error.title) || !text(error.body))) ||
        (update.pullRequest !== null && (!pr || !positiveInteger(pr.number) || !text(pr.state) || typeof pr.isDraft !== "boolean"))))) return null;
  return {
    repositoryId, id: node.id as string, number: node.number, state: node.state as string,
    manifestFilename: node.vulnerableManifestFilename as string, manifestPath: node.vulnerableManifestPath as string,
    relationship: node.dependencyRelationship as string | null, requirements: node.vulnerableRequirements as string | null,
    advisory: advisory ? { id: advisory.ghsaId as string, withdrawnAt: advisory.withdrawnAt as string | null } : null,
    vulnerability: vulnerability && pkg ? { ecosystem: pkg.ecosystem as string, packageName: pkg.name as string,
      range: vulnerability.vulnerableVersionRange as string, severity: vulnerability.severity as string, patchedVersion: patch ? patch.identifier as string : null } : null,
    update: update ? { error: error ? { type: error.errorType as string, title: error.title as string, body: error.body as string } : null,
      pullRequest: pr ? { number: pr.number as number, state: pr.state as string, isDraft: pr.isDraft as boolean } : null } : null,
  };
}

export async function discoverAlerts(client: Octokit, owner: string, name: string): Promise<Alert[]> {
  const alerts: Alert[] = [];
  const cursors = new Set<string>();
  const ids = new Set<string>();
  let cursor: string | null = null;
  let repositoryId: string | null = null;
  for (;;) {
    const data = await query(client, `query($owner: String!, $name: String!, $cursor: String) {
      repository(owner: $owner, name: $name) { id vulnerabilityAlerts(first: 100, after: $cursor, states: OPEN) {
        nodes { ${ALERT_FIELDS} } pageInfo { hasNextPage endCursor }
      } }
    }`, { owner, name, cursor });
    const repository = object(data.repository);
    const connection = object(repository?.vulnerabilityAlerts);
    const page = object(connection?.pageInfo);
    const currentId = text(repository?.id);
    if (!currentId || (repositoryId && repositoryId !== currentId) || !connection || !Array.isArray(connection.nodes) ||
        !page || typeof page.hasNextPage !== "boolean" || !nullableText(page.endCursor)) throw new DependabotReadError();
    repositoryId = currentId;
    for (const node of connection.nodes) {
      const alert = normalizeAlert(currentId, node);
      if (!alert || ids.has(alert.id)) throw new DependabotReadError();
      ids.add(alert.id);
      alerts.push(alert);
    }
    if (!page.hasNextPage) return alerts;
    const next = text(page.endCursor);
    if (!next || cursors.has(next)) throw new DependabotReadError();
    cursors.add(next);
    cursor = next;
  }
}

export async function revalidateAlert(client: Octokit, owner: string, name: string, previous: Alert): Promise<Alert | null> {
  const data = await query(client, `query($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) { id vulnerabilityAlert(number: $number) { ${ALERT_FIELDS} } }
  }`, { owner, name, number: previous.number });
  const repository = object(data.repository);
  if (!repository || repository.id !== previous.repositoryId || !("vulnerabilityAlert" in repository)) throw new DependabotReadError();
  if (repository.vulnerabilityAlert === null) return null;
  const alert = normalizeAlert(previous.repositoryId, repository.vulnerabilityAlert);
  if (!alert || alert.id !== previous.id || alert.number !== previous.number) throw new DependabotReadError();
  return alert;
}

export function classifyAlert(alert: Alert | null, evidence?: NpmSourceEvidence | null): Eligibility {
  if (!alert || !alert.advisory || !alert.vulnerability) return { eligible: false, reason: "missing-data" };
  if (alert.state !== "OPEN") return { eligible: false, reason: "not-open" };
  if (alert.advisory.withdrawnAt !== null) return { eligible: false, reason: "withdrawn-advisory" };
  if (!text(alert.vulnerability.patchedVersion)) return { eligible: false, reason: "no-patched-version" };
  if (alert.update?.pullRequest) return { eligible: false, reason: "associated-pull-request" };
  if (!alert.update?.error) return { eligible: false, reason: "no-update-error" };
  if (alert.vulnerability.ecosystem !== "NPM") return { eligible: false, reason: "unsupported-ecosystem" };
  if (alert.update.error.type !== "path_dependencies_not_reachable") return { eligible: false, reason: "unsupported-error" };
  const errorText = `${alert.update.error.title}\n${alert.update.error.body}`;
  if (/auth|credential|token|password|private|forbidden|unauthorized|registry|network|timed?\s*out|rate.limit|proxy|transport/i.test(errorText)) {
    return { eligible: false, reason: "unverified-source-access" };
  }
  if (!/^The following path based dependencies could not be retrieved: [@a-zA-Z0-9_./, -]+\.?$/.test(alert.update.error.body.trim())) {
    return { eligible: false, reason: "unverified-error-shape" };
  }
  const paths = sourcePaths(alert.manifestPath);
  if (!evidence || !paths || !/^[0-9a-f]{40}$/i.test(evidence.sha) || evidence.npmConfigs.length !== paths.length - 4 || alert.manifestFilename !== "package-lock.json") return { eligible: false, reason: "unverified-source-access" };
  return evaluateNpmSource(alert, evidence);
}

export interface NpmSourceEvidence {
  sha: string;
  manifest: string;
  lockfile: string;
  npmConfigs: (string | null)[];
  dependabotConfig: string | null;
}

function sourcePaths(manifestPath: string): string[] | null {
  const parts = manifestPath.split("/");
  if (manifestPath.length > 1024 || parts.length > 20 || parts.some(part => !part || part === "." || part === "..") || parts.pop() !== "package-lock.json") return null;
  const directory = parts.join("/");
  const configPaths = [".npmrc"];
  for (let index = 0; index < parts.length; index++) configPaths.push(`${parts.slice(0, index + 1).join("/")}/.npmrc`);
  return [directory ? `${directory}/package.json` : "package.json", manifestPath, ...configPaths, ".github/dependabot.yml", ".github/dependabot.yaml"];
}

async function defaultBranchSha(client: Octokit, owner: string, name: string, repositoryId: string): Promise<string> {
  const head = await query(client, `query($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) { id defaultBranchRef { target { oid } } }
  }`, { owner, name });
  const repository = object(head.repository);
  const sha = text(object(object(repository?.defaultBranchRef)?.target)?.oid);
  if (repository?.id !== repositoryId) throw new DependabotReadError();
  if (!sha || !/^[0-9a-f]{40}$/i.test(sha)) throw new DependabotReadError();
  return sha;
}

export async function readNpmSourceEvidence(client: Octokit, owner: string, name: string, alert: Alert): Promise<NpmSourceEvidence | null> {
  const paths = sourcePaths(alert.manifestPath);
  if (!paths) return null;
  const sha = await defaultBranchSha(client, owner, name, alert.repositoryId);
  const declarations = paths.map((_, index) => `$path${index}: String!`).join(", ");
  const fields = paths.map((_, index) => `file${index}: object(expression: $path${index}) { __typename ... on Blob { text isBinary isTruncated } }`).join("\n");
  const variables: ObjectValue = { owner, name };
  paths.forEach((path, index) => { variables[`path${index}`] = `${sha}:${path}`; });
  const data = await query(client, `query($owner: String!, $name: String!, ${declarations}) {
    repository(owner: $owner, name: $name) { id ${fields} }
  }`, variables);
  const repository = object(data.repository);
  if (!repository || repository.id !== alert.repositoryId) throw new DependabotReadError();
  const files = paths.map((_, index) => {
    const key = `file${index}`;
    if (!(key in repository)) throw new DependabotReadError();
    if (repository[key] === null) return null;
    const blob = object(repository[key]);
    if (!blob || blob.__typename !== "Blob" || blob.isBinary !== false || blob.isTruncated !== false || typeof blob.text !== "string") throw new DependabotReadError();
    return blob.text;
  });
  if (files[0] === null || files[1] === null) return null;
  return { sha, manifest: files[0], lockfile: files[1], npmConfigs: files.slice(2, -2),
    dependabotConfig: files.slice(-2).filter((file): file is string => file !== null).join("\n") || null };
}

function evaluateNpmSource(alert: Alert, evidence: NpmSourceEvidence): Eligibility {
  if (evidence.npmConfigs.some(config => config !== null && config.trim()) ||
      (evidence.dependabotConfig !== null && evidence.dependabotConfig.trim())) return { eligible: false, reason: "unverified-source-access" };
  try {
    const manifest = object(JSON.parse(evidence.manifest));
    const lock = object(JSON.parse(evidence.lockfile));
    const packages = object(lock?.packages);
    const localDependencies = new Map<string, string>();
    if (!manifest || !packages || ![2, 3].includes(lock?.lockfileVersion as number) || alert.relationship !== "TRANSITIVE") return { eligible: false, reason: "unverified-source-access" };
    if (manifest.workspaces !== undefined || manifest.overrides !== undefined) return { eligible: false, reason: "unverified-source-access" };
    for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      if (manifest[section] === undefined) continue;
      const dependencies = object(manifest[section]);
      if (!dependencies) return { eligible: false, reason: "unverified-source-access" };
      for (const [name, value] of Object.entries(dependencies)) {
        if (typeof value !== "string") return { eligible: false, reason: "unverified-source-access" };
        if (/^file:\.\.?\//.test(value)) localDependencies.set(name, value.slice(5));
        else if (!/^[\d\s.*^~<>=|+-]+$/.test(value)) return { eligible: false, reason: "unverified-source-access" };
      }
    }
    const error = alert.update?.error;
    const reported = error?.body.trim().replace(/^The following path based dependencies could not be retrieved: /, "").replace(/\.$/, "").split(/,\s*/);
    if (!reported?.length || reported.some(name => !localDependencies.has(name))) return { eligible: false, reason: "unverified-source-access" };
    let found = false;
    for (const [path, value] of Object.entries(packages)) {
      const entry = object(value);
      if (!entry) return { eligible: false, reason: "unverified-source-access" };
      if (path && entry.resolved === undefined) return { eligible: false, reason: "unverified-source-access" };
      if (entry.resolved !== undefined && (typeof entry.resolved !== "string" ||
          (!/^https:\/\/registry\.npmjs\.org\/[a-zA-Z0-9@%._~/-]+$/.test(entry.resolved) &&
           !(entry.link === true && [...localDependencies].some(([name, localPath]) => path === `node_modules/${name}` && entry.resolved === localPath))))) return { eligible: false, reason: "unverified-source-access" };
      const packageName = alert.vulnerability?.packageName;
      if (packageName && /^[a-zA-Z0-9@._/-]+$/.test(packageName) &&
          (path === `node_modules/${packageName}` || path.endsWith(`/node_modules/${packageName}`)) &&
          typeof entry.resolved === "string" && entry.resolved.startsWith(`https://registry.npmjs.org/${packageName}/-/`) && text(entry.version)) found = true;
    }
    return found ? { eligible: true } : { eligible: false, reason: "unverified-source-access" };
  } catch {
    return { eligible: false, reason: "unverified-source-access" };
  }
}

export async function revalidateEligibility(reader: Octokit, contentReader: Octokit, owner: string, name: string, previous: Alert): Promise<{ alert: Alert | null; eligibility: Eligibility }> {
  const alert = await revalidateAlert(reader, owner, name, previous);
  const preliminary = classifyAlert(alert);
  if (!alert || preliminary.eligible || preliminary.reason !== "unverified-source-access") return { alert, eligibility: preliminary };
  const evidence = await readNpmSourceEvidence(contentReader, owner, name, alert);
  const eligibility = classifyAlert(alert, evidence);
  if (eligibility.eligible && evidence && await defaultBranchSha(contentReader, owner, name, alert.repositoryId) !== evidence.sha) throw new DependabotReadError();
  return { alert, eligibility };
}

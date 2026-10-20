import * as core from "@actions/core";
import { expandTeamRefs } from "./lib/expand-team-refs.js";
import { getOctokit } from "./lib/octokit.js";

function parseArray(value: string, input: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
      throw new Error("must be a JSON array of strings");
    }
    return parsed;
  } catch (error) {
    throw new Error(`Invalid ${input}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function includesLogin(entries: string[], principal: string): boolean {
  const normalized = principal.toLowerCase();
  return entries.some((entry) => entry.toLowerCase() === normalized);
}

function fail(message: string): void {
  core.setFailed(`Agent allowlist gate denied: ${message}`);
}

/** Implements the reusable-workflow sender/reviewer authorization policy. */
export async function run(): Promise<void> {
  const skipGate = core.getBooleanInput("skip_gate");
  if (skipGate) {
    core.info("Agent allowlist gate intentionally skipped for this event.");
    return;
  }
  const principal = core.getInput("principal", { required: true });

  const trusted = parseArray(core.getInput("additional_trusted_logins") || "[]", "additional-trusted-logins");
  // Known identities are deliberately the sole pre-resolution bypass.
  if (includesLogin(trusted, principal)) {
    core.info(`Agent allowlist gate allowed trusted identity ${principal}.`);
    return;
  }

  const rawAllowlist = core.getInput("allowlist");
  if (rawAllowlist.trim() === "") {
    fail("AGENT_ALLOWLIST is empty.");
    return;
  }
  let entries: string[];
  try {
    entries = parseArray(rawAllowlist, "AGENT_ALLOWLIST");
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return;
  }
  if (entries.length === 0) {
    fail("AGENT_ALLOWLIST is empty.");
    return;
  }

  // Send every slash-bearing entry to the shared expander.  Its stricter
  // validation ensures malformed values such as "org/team/extra" fail closed
  // rather than disappearing from the login-only path.
  const teamRefs = entries.filter((entry) => entry.includes("/"));
  const explicitLogins = entries.filter((entry) => !entry.includes("/"));
  if (teamRefs.length === 0) {
    if (includesLogin(explicitLogins, principal)) {
      core.info(`Agent allowlist gate allowed ${principal} from login-only allowlist.`);
    } else {
      fail(`principal ${principal} is not in the login-only AGENT_ALLOWLIST.`);
    }
    return;
  }

  const token = core.getInput("resolver_token");
  if (token === "") {
    fail(`credential-unavailable: AGENT_ALLOWLIST contains team references (${teamRefs.join(", ")}) but no allowlist resolver identity/token is available.`);
    return;
  }

  const expansion = await expandTeamRefs(entries, getOctokit(token), {
    supportedOrg: process.env.GITHUB_REPOSITORY_OWNER ?? "",
  });
  // A successfully resolved empty team grants no logins, but is not an
  // allowlist-resolution failure. Keep the shared expander's error signal for
  // callers that need fail-closed empty-team semantics.
  const blockingErrors = expansion.errors.filter((error) => error.reason !== "empty_team");
  for (const error of expansion.errors) {
    if (error.reason === "empty_team") {
      core.warning(`Allowlist team ${error.entry} is empty and grants no logins.`);
    }
  }
  if (blockingErrors.length > 0) {
    const details = blockingErrors
      .map((error) => `${error.entry}: ${error.reason}${error.message ? ` (${error.message})` : ""}`)
      .join("; ");
    fail(`team resolution failed (fail-closed): ${details}`);
    return;
  }

  if (includesLogin(expansion.expanded, principal) || includesLogin(explicitLogins, principal)) {
    core.info(`Agent allowlist gate allowed ${principal}.`);
    return;
  }
  fail(`principal ${principal} is not in AGENT_ALLOWLIST or a resolved allowlisted team.`);
}

run().catch((error: unknown) => core.setFailed(error instanceof Error ? error.message : String(error)));

import type { getOctokit } from "./octokit.js";

/** A non-fatal problem encountered while resolving one list entry. */
export interface ResolutionError {
  entry: string;
  reason:
    | "malformed"
    | "not_found"
    | "forbidden"
    | "api_error"
    | "empty_team"
    | "cross_org";
  message?: string;
}

/** The authenticated Octokit client used to look up organization team members. */
export type Octokit = ReturnType<typeof getOctokit>;

export interface TeamRefExpansion {
  expanded: string[];
  errors: ResolutionError[];
}

function errorStatus(error: unknown): number | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof error.status === "number"
  ) {
    return error.status;
  }

  return undefined;
}

/**
 * Expands organization team references in a list of GitHub logins.
 *
 * Team lookup failures are collected rather than thrown so each caller can
 * choose whether its policy is fail-closed or warn-and-skip.
 */
export async function expandTeamRefs(
  entries: string[],
  octokit: Octokit,
  options: { supportedOrg: string },
): Promise<TeamRefExpansion> {
  const expanded: string[] = [];
  const errors: ResolutionError[] = [];
  const seenLogins = new Set<string>();

  const addLogin = (login: string): void => {
    const normalizedLogin = login.toLowerCase();
    if (!seenLogins.has(normalizedLogin)) {
      seenLogins.add(normalizedLogin);
      expanded.push(login);
    }
  };

  for (const entry of entries) {
    if (entry === "" || entry.includes("/") && !/^[^/]+\/[^/]+$/.test(entry)) {
      errors.push({ entry, reason: "malformed" });
      continue;
    }

    if (!entry.includes("/")) {
      addLogin(entry);
      continue;
    }

    const [org, team_slug] = entry.split("/");
    if (org.toLowerCase() !== options.supportedOrg.toLowerCase()) {
      errors.push({
        entry,
        reason: "cross_org",
        message: `Team reference organization "${org}" is unsupported; supported organization is "${options.supportedOrg}".`,
      });
      continue;
    }

    try {
      const members = await octokit.paginate(octokit.rest.teams.listMembersInOrg, {
        org,
        team_slug,
      });

      if (members.length === 0) {
        errors.push({ entry, reason: "empty_team" });
        continue;
      }

      for (const member of members) {
        addLogin(member.login);
      }
    } catch (error) {
      const status = errorStatus(error);
      if (status === 404) {
        errors.push({ entry, reason: "not_found" });
      } else if (status === 403) {
        errors.push({ entry, reason: "forbidden" });
      } else {
        errors.push({
          entry,
          reason: "api_error",
          message: `Team lookup failed with status ${status ?? "unknown"}.`,
        });
      }
    }
  }

  return { expanded, errors };
}

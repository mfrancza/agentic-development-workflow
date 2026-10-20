import * as core from "@actions/core";

/** Returns true when a JSON list has a string entry containing a slash. */
export function hasTeamReference(value: string): boolean {
  if (value === "") return false;

  let entries: unknown;
  try {
    entries = JSON.parse(value);
  } catch {
    return false;
  }

  return Array.isArray(entries) && entries.some(
    (entry) => typeof entry === "string" && entry.includes("/"),
  );
}

export function run(): void {
  const assignees = process.env.INPUT_ASSIGNEES ?? core.getInput("assignees");
  core.setOutput("assignees_has_team", String(hasTeamReference(assignees)));
}

run();

import * as core from "@actions/core";
import { getOctokit } from "./lib/octokit.js";

type Octokit = ReturnType<typeof getOctokit>;

/**
 * Regex that matches the `<!-- authored-by-model: <name> -->` HTML-comment
 * marker injected into PR bodies by the developer/design entrypoint.
 *
 * Capture group 1 is the model name (no whitespace, no `>`).
 * Defined in `docs/design/configurable-model-pair-preferences.md` Decision 4.
 */
export const AUTHORED_BY_MODEL_REGEX = /<!--\s*authored-by-model:\s*([^\s>]+)\s*-->/i;

/**
 * Extracts the authoring model from a PR body.
 *
 * Returns the model ID captured by the marker regex, or an empty string when
 * the body is null or contains no well-formed marker.
 *
 * @param body  The pull-request body text, or null when the body is absent.
 * @returns     The authoring model ID, or `""` when the marker is absent or
 *              the body is null.
 */
export function parseAuthoredByModel(body: string | null): string {
  if (body === null) return "";
  const match = body.match(AUTHORED_BY_MODEL_REGEX);
  if (!match) return "";
  return match[1];
}

/**
 * Reads the PR body via Octokit and returns the authoring model ID parsed from
 * the `<!-- authored-by-model: … -->` marker.
 *
 * Logs an informational message in both the found and not-found cases so the
 * workflow output indicates whether the pairing tier will be active.
 *
 * @param octokit   Authenticated Octokit client.
 * @param owner     Repository owner (user or organisation).
 * @param repo      Repository name.
 * @param prNumber  Pull request number to inspect.
 * @returns         The authoring model ID (e.g. `"sonnet"`), or `""` when the
 *                  marker is absent.
 */
export async function findAuthoredByModel(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<string> {
  const { data } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });

  const model = parseAuthoredByModel(data.body);

  if (!model) {
    core.info(
      `PR #${prNumber}: authored-by-model marker absent or empty; pairing tier will be skipped.`,
    );
  } else {
    core.info(`PR #${prNumber}: authoring model is "${model}".`);
  }

  return model;
}

async function run(): Promise<void> {
  const token = core.getInput("token", { required: true });
  const repository = core.getInput("repository", { required: true });
  const prNumberStr = core.getInput("pr_number", { required: true });

  const separatorIndex = repository.indexOf("/");
  if (separatorIndex === -1) {
    core.setFailed(`Invalid repository format: "${repository}". Expected "owner/name".`);
    return;
  }
  const owner = repository.slice(0, separatorIndex);
  const repo = repository.slice(separatorIndex + 1);

  const prNumber = parseInt(prNumberStr, 10);
  if (isNaN(prNumber) || prNumber <= 0) {
    core.setFailed(`Invalid pr-number: "${prNumberStr}". Must be a positive integer.`);
    return;
  }

  const octokit = getOctokit(token);
  const authoringModel = await findAuthoredByModel(octokit, owner, repo, prNumber);

  core.setOutput("authoring_model", authoringModel);
}

// Skip the entry-point side-effect when the module is imported by the test
// runner (vitest sets VITEST=true). This prevents spurious ::error:: log
// annotations during `npm test` without coupling the logic to a test-only
// variable anywhere except this single guard.
if (!process.env.VITEST) {
  run().catch((err: unknown) =>
    core.setFailed(err instanceof Error ? err.message : String(err)),
  );
}

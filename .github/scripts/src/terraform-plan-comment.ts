import * as core from "@actions/core";
import { existsSync, readFileSync } from "node:fs";
import { getOctokit } from "./lib/octokit.js";

/**
 * Posts (or upserts) a `terraform plan` output as a PR comment.
 *
 * On the first call the activity creates a new comment; on subsequent calls
 * it finds the existing comment by looking for one authored by the bot login
 * and updates it in place, so every push produces a single evergreen comment
 * on the PR rather than a growing thread.
 *
 * Inputs (via composite action env vars → core.getInput):
 *   token      – GitHub token with PR comment write access (issues: write)
 *   repo       – Repository in "owner/name" format (e.g. github.repository)
 *   pr_number  – Pull request number to comment on
 *   plan_file  – Path to the file containing the terraform plan text
 *               (produced upstream by `terraform show -no-color <plan-file>`)
 *   bot_login  – The [bot] login that owns the comment
 *               (e.g. "terraform-ci[bot]")
 *
 * Outputs:
 *   comment_id – ID of the created or updated PR comment
 */

/** Maximum UTF-8 bytes allowed for the plan body before the code fence. */
export const MAX_PLAN_BYTES = 60 * 1024; // 60 KB

/** Footer appended when the plan text is truncated. */
export const TRUNCATION_SUFFIX = "\n… (truncated)";

/**
 * Truncates `planText` to at most `maxBytes` UTF-8 bytes, appending
 * {@link TRUNCATION_SUFFIX} when truncation occurs.
 *
 * GitHub's PR-comment limit is 65 536 characters.  Capping the plan body at
 * 60 KB leaves comfortable headroom for the Markdown code-fence wrapper and
 * header without risking a rejected comment.
 *
 * Node's `Buffer.subarray(0, n).toString("utf8")` drops any incomplete
 * trailing multi-byte sequence automatically, so the returned string is
 * always valid UTF-8.
 */
export function truncatePlan(
  planText: string,
  maxBytes: number = MAX_PLAN_BYTES,
): string {
  if (Buffer.byteLength(planText, "utf8") <= maxBytes) {
    return planText;
  }
  const truncated = Buffer.from(planText, "utf8")
    .subarray(0, maxBytes)
    .toString("utf8");
  return truncated + TRUNCATION_SUFFIX;
}

/**
 * Wraps the (possibly truncated) plan text in a Markdown code fence with a
 * short header suitable for a PR comment body.
 */
export function formatComment(planText: string): string {
  const body = truncatePlan(planText);
  return `## Terraform Plan\n\n\`\`\`\n${body}\n\`\`\``;
}

type OctokitClient = ReturnType<typeof getOctokit>;

/**
 * Returns the ID of the first PR comment authored by `botLogin`, or
 * `undefined` if no such comment exists.
 *
 * Uses `octokit.paginate` to walk all pages of PR comments so it works
 * correctly on PRs with many comments.
 */
export async function findExistingComment(
  octokit: OctokitClient,
  owner: string,
  repo: string,
  prNumber: number,
  botLogin: string,
): Promise<number | undefined> {
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner,
    repo,
    issue_number: prNumber,
    per_page: 100,
  });
  const match = comments.find((c) => c.user?.login === botLogin);
  return match?.id;
}

/**
 * Creates a new comment on the PR, or updates the existing bot comment in
 * place.  Returns the comment ID and whether it was newly created.
 */
export async function upsertPlanComment(
  octokit: OctokitClient,
  owner: string,
  repo: string,
  prNumber: number,
  botLogin: string,
  body: string,
): Promise<{ commentId: number; created: boolean }> {
  const existingId = await findExistingComment(
    octokit,
    owner,
    repo,
    prNumber,
    botLogin,
  );

  if (existingId !== undefined) {
    const { data } = await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: existingId,
      body,
    });
    return { commentId: data.id, created: false };
  }

  const { data } = await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body,
  });
  return { commentId: data.id, created: true };
}

export async function run(): Promise<void> {
  const token = core.getInput("token", { required: true });
  const repo = core.getInput("repo", { required: true });
  const prNumberStr = core.getInput("pr_number", { required: true });
  const planFile = core.getInput("plan_file", { required: true });
  const botLogin = core.getInput("bot_login", { required: true });

  const prNumber = parseInt(prNumberStr, 10);
  if (isNaN(prNumber)) {
    throw new Error(
      `Invalid pr-number: "${prNumberStr}". Expected a positive integer.`,
    );
  }

  const slashIndex = repo.indexOf("/");
  if (slashIndex === -1) {
    throw new Error(
      `Invalid repo format: "${repo}". Expected "owner/name".`,
    );
  }
  const owner = repo.slice(0, slashIndex);
  const repoName = repo.slice(slashIndex + 1);

  if (!existsSync(planFile)) {
    throw new Error(`Plan file not found: "${planFile}"`);
  }

  const planText = readFileSync(planFile, "utf8");
  const body = formatComment(planText);
  const octokit = getOctokit(token);

  const { commentId, created } = await upsertPlanComment(
    octokit,
    owner,
    repoName,
    prNumber,
    botLogin,
    body,
  );

  core.info(
    `${created ? "Created" : "Updated"} terraform plan comment ` +
      `(id=${commentId}) on PR #${prNumber}.`,
  );
  core.setOutput("comment_id", String(commentId));
}

run().catch((err: unknown) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});

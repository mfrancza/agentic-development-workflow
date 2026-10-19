import * as core from "@actions/core";
import { context } from "@actions/github";
import { getOctokit } from "./lib/octokit.js";

type Octokit = ReturnType<typeof getOctokit>;

const ACTIONABLE_CONCLUSIONS = new Set([
  "failure",
  "timed_out",
  "action_required",
]);

export interface ResolveCheckPrResult {
  proceed: boolean;
  prNumber?: number;
  headSha?: string;
}

type EventPayload = {
  workflow_run?: PayloadRun;
  check_run?: PayloadRun;
};

type PayloadRun = {
  head_sha?: unknown;
  pull_requests?: Array<{ number?: unknown }>;
};

/**
 * Parses the caller-configured check-name allowlist. The boundary is
 * deliberately fail-closed: only a non-empty JSON array containing strings
 * can authorise a fix-checks run.
 */
export function parseAllowedChecks(input: string): string[] | undefined {
  try {
    const value: unknown = JSON.parse(input);
    if (
      !Array.isArray(value) ||
      value.length === 0 ||
      !value.every((name) => typeof name === "string")
    ) {
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}

function eventDetails(
  eventName: string,
  payload: EventPayload
): { headSha: string; prNumber?: number } | undefined {
  const event =
    eventName === "workflow_run"
      ? payload.workflow_run
      : eventName === "check_run"
        ? payload.check_run
        : undefined;

  if (!event || typeof event.head_sha !== "string" || !event.head_sha) {
    return undefined;
  }

  const number = event.pull_requests?.[0]?.number;
  return {
    headSha: event.head_sha,
    ...(typeof number === "number" ? { prNumber: number } : {}),
  };
}

/**
 * Resolves a workflow_run or check_run event to an open pull request and
 * authorises it only when the current Checks API state contains an allowed,
 * actionable check run.
 */
export async function resolveCheckPr(
  octokit: Octokit,
  owner: string,
  repo: string,
  eventName: string,
  payload: EventPayload,
  allowedChecksInput: string
): Promise<ResolveCheckPrResult> {
  const allowedChecks = parseAllowedChecks(allowedChecksInput);
  if (!allowedChecks) {
    core.info("FIX_CHECKS_ALLOW is empty or malformed; skipping.");
    return { proceed: false };
  }

  const details = eventDetails(eventName, payload);
  if (!details) {
    core.info(`Event '${eventName}' has no usable head SHA; skipping.`);
    return { proceed: false };
  }

  let prNumber = details.prNumber;
  if (prNumber === undefined) {
    const response = await octokit.rest.repos.listPullRequestsAssociatedWithCommit({
      owner,
      repo,
      commit_sha: details.headSha,
    });
    const pr = response.data.find(
      (candidate) =>
        candidate.state === "open" && candidate.head.sha === details.headSha
    );
    prNumber = pr?.number;
  }

  if (prNumber === undefined) {
    core.info(`No open PR found for SHA ${details.headSha}; skipping.`);
    return { proceed: false };
  }

  const checkRuns = await octokit.rest.checks.listForRef({
    owner,
    repo,
    ref: details.headSha,
  });
  const actionableAllowedCheck = checkRuns.data.check_runs.find(
    (checkRun) =>
      allowedChecks.includes(checkRun.name) &&
      ACTIONABLE_CONCLUSIONS.has(checkRun.conclusion ?? "")
  );

  if (!actionableAllowedCheck) {
    core.info(
      `No allowed actionable check run remains for PR #${prNumber} at ${details.headSha}; skipping.`
    );
    return { proceed: false, prNumber, headSha: details.headSha };
  }

  core.info(
    `Resolved PR #${prNumber} at ${details.headSha}; allowed actionable check '${actionableAllowedCheck.name}' found.`
  );
  return { proceed: true, prNumber, headSha: details.headSha };
}

async function run(): Promise<void> {
  const token = core.getInput("token", { required: true });
  const repository = core.getInput("repository", { required: true });
  const eventName = core.getInput("event_name", { required: true });
  const allowedChecks = core.getInput("allowed_checks", { required: true });
  const separatorIndex = repository.indexOf("/");
  if (separatorIndex === -1) {
    core.setFailed(`Invalid repository format: ${repository}`);
    return;
  }

  const result = await resolveCheckPr(
    getOctokit(token),
    repository.slice(0, separatorIndex),
    repository.slice(separatorIndex + 1),
    eventName,
    context.payload as EventPayload,
    allowedChecks
  );
  core.setOutput("proceed", result.proceed ? "true" : "false");
  if (result.prNumber !== undefined) core.setOutput("pr_number", String(result.prNumber));
  if (result.headSha !== undefined) core.setOutput("head_sha", result.headSha);
}

run().catch(core.setFailed);

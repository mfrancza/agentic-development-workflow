import * as core from "@actions/core";
import { getOctokit } from "./lib/octokit.js";
import { resolveModel, type SubjectType } from "./lib/resolve-model.js";
import { type PairingConfig } from "./lib/model-pair.js";

/**
 * Entry point — reads action inputs, calls resolveModel, and publishes the
 * resolved model name as the `claude_model` output.
 */
async function run(): Promise<void> {
  const token = core.getInput("token", { required: true });
  const subjectTypeInput = core.getInput("subject_type", { required: true });
  const subjectNumberStr = core.getInput("subject_number", { required: true });
  const repo = core.getInput("repo", { required: true });
  const defaultModel = core.getInput("default_model", { required: true });

  if (subjectTypeInput !== "issue" && subjectTypeInput !== "pr") {
    throw new Error(
      `Invalid subject-type: "${subjectTypeInput}". Must be "issue" or "pr".`,
    );
  }
  const subjectType: SubjectType = subjectTypeInput;

  const subjectNumber = parseInt(subjectNumberStr, 10);
  if (isNaN(subjectNumber) || subjectNumber <= 0) {
    throw new Error(
      `Invalid subject-number: "${subjectNumberStr}". Must be a positive integer.`,
    );
  }

  const slashIndex = repo.indexOf("/");
  if (slashIndex === -1) {
    throw new Error(
      `Invalid repo: "${repo}". Expected "owner/name" format.`,
    );
  }
  const owner = repo.slice(0, slashIndex);
  const repoName = repo.slice(slashIndex + 1);

  const agentTypeInput = core.getInput("agent_type", { required: false });
  const agentType = agentTypeInput.trim() || undefined;

  // ---------------------------------------------------------------------------
  // Pairing tier inputs (optional; only used for agent-type: review)
  // ---------------------------------------------------------------------------
  const pairingPolicyRaw = core.getInput("pairing_policy", { required: false }).trim();
  const authoringModel = core.getInput("authoring_model", { required: false }).trim();
  const availableProvidersRaw = core.getInput("available_providers", { required: false }).trim();

  let pairingOptions: Parameters<typeof resolveModel>[7] = undefined;

  if (agentType === "review" && pairingPolicyRaw) {
    let pairingConfig: PairingConfig;
    try {
      pairingConfig = JSON.parse(pairingPolicyRaw) as PairingConfig;
    } catch (err) {
      core.warning(
        `Pairing tier skipped: failed to parse pairing-policy JSON: ${err instanceof Error ? err.message : String(err)}. ` +
          `Falling through to DEFAULT_MODEL.`,
      );
      pairingConfig = { policy: "off", enabled: false };
    }

    // Parse available-providers: supports "anthropic,openai,xai" or ["anthropic","openai"]
    let availableProviders: string[] = [];
    if (availableProvidersRaw) {
      const trimmed = availableProvidersRaw.trim();
      if (trimmed.startsWith("[")) {
        try {
          availableProviders = JSON.parse(trimmed) as string[];
        } catch {
          availableProviders = trimmed
            .replace(/[\[\]"]/g, "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        }
      } else {
        availableProviders = trimmed
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      }
    }

    pairingOptions = {
      pairingConfig,
      authoringModel,
      availableProviders,
    };
  } else if (agentType === "review" && !pairingPolicyRaw) {
    // Pairing tier inputs absent — log and fall through (disabled by default).
    // No warning needed; the feature is opt-in.
  }

  const octokit = getOctokit(token);
  const claudeModel = await resolveModel(
    octokit,
    subjectType,
    subjectNumber,
    owner,
    repoName,
    defaultModel,
    agentType,
    pairingOptions,
    (msg: string) => {
      // Messages prefixed with "ERROR:" must be surfaced as core.error(); all
      // others are core.warning().  This fulfils Decision 5 of the design which
      // requires core.error() when DEFAULT_MODEL == authoring model.
      if (msg.startsWith("ERROR:")) {
        core.error(msg.slice("ERROR:".length).trim());
      } else {
        core.warning(msg);
      }
    },
  );

  core.setOutput("claude_model", claudeModel);
  core.info(`Resolved model: ${claudeModel}`);
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

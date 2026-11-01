import * as core from "@actions/core";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Matches a `# release-self-pin: <worker-filename>` anchor comment.
 *
 * Capture group 1: the declared worker filename (e.g.
 * "agent-review-worker-reusable.yml").  Everything after the first whitespace
 * following the filename is ignored, so an inline trailing comment such as
 * `  # rewritten at release by …` does not pollute the capture.
 */
const ANCHOR_RE = /^\s*#\s+release-self-pin:\s+(\S+)/;

/**
 * Returns a regex that matches the `uses:` self-pin line for the given worker
 * filename.
 *
 * Capture group 1: the `@<ref>` value (e.g. "v0.3.0").
 */
function selfPinRe(workerFile: string): RegExp {
  const escaped = workerFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `uses:\\s+mfrancza/agentic-development-workflow/\\.github/workflows/${escaped}@(\\S+)`,
  );
}

/**
 * Rewrites self-referencing reusable-workflow pins that are explicitly
 * declared via a `# release-self-pin: <worker-filename>` anchor comment to
 * point at `targetVersion`.
 *
 * Rules (Decision 2 in docs/design/release-self-pin-worker.md):
 * - Only `uses:` lines that immediately follow a matching anchor comment
 *   (with only blank lines permitted between anchor and `uses:`) are
 *   candidates for rewriting.
 * - The next non-blank line after an anchor MUST be a `uses:` self-pin for
 *   the worker the anchor declares.  If it is not, the function throws with a
 *   diagnostic citing the file and line — the anchor is a hard contract, not
 *   a hint.
 * - `uses:` lines that are not preceded by an anchor are left completely
 *   untouched (even if they match the self-referencing pattern).
 * - When every anchored pin already points at `targetVersion`, no bytes
 *   change and `null` is returned so the caller knows not to write the file.
 *
 * @param content        The raw file content (UTF-8 string).
 * @param targetVersion  The version to rewrite pins to (e.g. "v1.2.3").
 * @param filePath       The file path used in diagnostic messages.
 * @returns The rewritten content, or `null` if no lines changed.
 */
export function rewriteFileContent(
  content: string,
  targetVersion: string,
  filePath: string = "<unknown>",
): string | null {
  const lines = content.split("\n");
  let fileChanged = false;
  const newLines = [...lines];

  for (let i = 0; i < lines.length; i++) {
    const anchorMatch = ANCHOR_RE.exec(lines[i]);
    if (!anchorMatch) continue;

    const declaredWorker = anchorMatch[1];

    // Find the next non-blank line after the anchor (blank = whitespace-only).
    let nextIdx = i + 1;
    while (nextIdx < lines.length && lines[nextIdx].trim() === "") {
      nextIdx++;
    }

    if (nextIdx >= lines.length) {
      throw new Error(
        `${filePath}:${i + 1}: anchor "# release-self-pin: ${declaredWorker}" ` +
          `is not followed by a uses: self-pin line (reached end of file).`,
      );
    }

    const nextLine = lines[nextIdx];

    // A comment line can never be the required uses: pin — it would be a
    // broken anchor (e.g. prose comment between the anchor and the live line).
    if (/^\s*#/.test(nextLine)) {
      throw new Error(
        `${filePath}:${i + 1}: anchor "# release-self-pin: ${declaredWorker}" ` +
          `is not followed by the expected uses: self-pin for "${declaredWorker}". ` +
          `Next non-blank line (${filePath}:${nextIdx + 1}) is a comment, not a uses: line: ` +
          `"${nextLine.trim()}"`,
      );
    }

    const usesRe = selfPinRe(declaredWorker);
    const usesMatch = usesRe.exec(nextLine);

    if (!usesMatch) {
      throw new Error(
        `${filePath}:${i + 1}: anchor "# release-self-pin: ${declaredWorker}" ` +
          `is not followed by the expected uses: self-pin for "${declaredWorker}". ` +
          `Next non-blank line (${filePath}:${nextIdx + 1}): "${nextLine.trim()}"`,
      );
    }

    const ref = usesMatch[1];
    if (ref !== targetVersion) {
      // Replace only the @<ref> suffix.  usesMatch.index is where the match
      // starts in nextLine; usesMatch[0].length covers the full match.
      const matchEnd = usesMatch.index + usesMatch[0].length;
      newLines[nextIdx] =
        nextLine.slice(0, matchEnd - ref.length) +
        targetVersion +
        nextLine.slice(matchEnd);
      fileChanged = true;
    }

    // Advance i past the uses: line so we do not double-process it.
    i = nextIdx;
  }

  return fileChanged ? newLines.join("\n") : null;
}

const VERSION_RE = /^v\d+\.\d+\.\d+$/;

/**
 * Activity entry point.
 *
 * Inputs (via `core.getInput`):
 *   workflows_dir   Directory containing workflow files.
 *                   Default: ".github/workflows"
 *   target_version  Version to rewrite pins to (must match ^v\d+\.\d+\.\d+$).
 *                   Required.
 *
 * Outputs (via `core.setOutput`):
 *   changed        "true" if one or more files were rewritten; "false" otherwise.
 *   files-changed  Number of files rewritten (as a decimal string).
 */
export async function run(): Promise<void> {
  const workflowsDir =
    core.getInput("workflows_dir") || ".github/workflows";
  const targetVersion = core.getInput("target_version", { required: true });

  if (!VERSION_RE.test(targetVersion)) {
    throw new Error(
      `target-version "${String(targetVersion)}" does not match required pattern ^v\\d+\\.\\d+\\.\\d+$`,
    );
  }

  const files = readdirSync(workflowsDir)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .sort();

  let filesChanged = 0;

  for (const file of files) {
    const filePath = join(workflowsDir, file);
    const content = readFileSync(filePath, "utf8");
    const newContent = rewriteFileContent(content, targetVersion, filePath);
    if (newContent !== null) {
      writeFileSync(filePath, newContent, "utf8");
      filesChanged++;
      core.info(`Rewrote self-referencing pin in: ${file}`);
    }
  }

  const changed = filesChanged > 0;
  core.setOutput("changed", String(changed));
  core.setOutput("files-changed", String(filesChanged));
  core.info(
    `Rewrite complete: changed=${String(changed)}, files-changed=${filesChanged}`,
  );
}

run().catch(core.setFailed);

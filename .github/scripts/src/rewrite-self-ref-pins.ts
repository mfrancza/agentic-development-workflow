import * as core from "@actions/core";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PINNED_SELF_REF_RE } from "./lib/self-ref-pins.js";

/**
 * Rewrites every self-referencing reusable-workflow pin in a workflow file's
 * content to point at `targetVersion`.
 *
 * Rules:
 * - Lines whose first non-whitespace character is `#` are treated as comments
 *   and are never rewritten.
 * - Only `mfrancza/agentic-development-workflow/.github/workflows/*@<ref>`
 *   patterns are matched; all other `uses:` lines are left untouched.
 * - When every matched pin already points at `targetVersion`, the file is
 *   unchanged and `null` is returned so the caller knows not to write it.
 *
 * @param content        The raw file content (UTF-8 string).
 * @param targetVersion  The version to rewrite pins to (e.g. "v1.2.3").
 * @returns The rewritten content, or `null` if no lines changed.
 */
export function rewriteFileContent(
  content: string,
  targetVersion: string,
): string | null {
  const lines = content.split("\n");
  let fileChanged = false;

  const newLines = lines.map((line) => {
    // Skip comment lines — first non-whitespace char is '#'.
    if (/^\s*#/.test(line)) return line;

    const m = PINNED_SELF_REF_RE.exec(line);
    if (!m) return line;

    const ref = m[2];
    if (ref === targetVersion) return line; // Already at target — no change.

    fileChanged = true;
    // Replace only the @<ref> suffix.  m.index is where the match starts in
    // `line`; m[0].length is the length of the full match.  Slicing off the
    // last `ref.length` characters of the match and appending targetVersion
    // preserves everything before and after the match (including indentation
    // and any trailing comment).
    const matchEnd = m.index + m[0].length;
    return (
      line.slice(0, matchEnd - ref.length) +
      targetVersion +
      line.slice(matchEnd)
    );
  });

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
    const newContent = rewriteFileContent(content, targetVersion);
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

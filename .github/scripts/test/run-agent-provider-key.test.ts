import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Static contract test: the run-agent composite action forwards exactly one
 * provider API key into the container, chosen by the same model-name routing
 * the container entrypoints use.
 *
 * Why: before this guard, `docker run` passed ANTHROPIC_API_KEY,
 * OPENAI_API_KEY and XAI_API_KEY unconditionally, so a prompt-injected agent
 * on an Anthropic run could read the other two vendors' keys out of its own
 * environment. The action now routes on the model name. The entrypoints'
 * `resolve_provider()` functions remain the ground truth (explicit allowlists
 * for OpenAI and xAI); the action uses namespace prefixes, which are strictly
 * broader. This test asserts that every model literal the entrypoints accept
 * routes to the same provider under the action's prefixes, so the two cannot
 * drift apart silently: a mismatch would surface at runtime as
 * "<KEY> is required" from the entrypoint, but should be caught here first.
 */

const repoRoot = new URL("../../../", import.meta.url);
const action = readFileSync(
  new URL(".github/actions/run-agent/action.yml", repoRoot),
  "utf8",
);
const entrypoints = [
  "docker/scripts/entrypoint.sh",
  "docker/reviewer/entrypoint.sh",
].map((p) => ({ path: p, content: readFileSync(new URL(p, repoRoot), "utf8") }));

type Provider = "anthropic" | "openai" | "xai";

/**
 * The action's routing, mirrored from the `case "${AGENT_MODEL}"` block. The
 * pattern-text assertions below pin this mirror to the YAML so the two cannot
 * be edited independently.
 */
function actionProvider(model: string): Provider | null {
  if (/^(sonnet|opus|haiku)$/.test(model) || model.startsWith("claude-")) return "anthropic";
  if (model.startsWith("gpt-") || /^o[0-9]/.test(model)) return "openai";
  if (model.startsWith("grok-")) return "xai";
  return null;
}

/**
 * Extracts (pattern, provider) pairs from a shell `resolve_provider()` case
 * statement: a line of the form `  pat1|pat2|...)` followed within two lines
 * by `echo "<provider>"`.
 */
function entrypointRoutes(content: string): Array<{ pattern: string; provider: Provider }> {
  const start = content.indexOf("resolve_provider()");
  expect(start, "entrypoint defines resolve_provider()").toBeGreaterThanOrEqual(0);
  const lines = content.slice(start).split("\n");
  const routes: Array<{ pattern: string; provider: Provider }> = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*([A-Za-z0-9_.|*-]+)\)\s*$/);
    if (!m) continue;
    for (let j = i + 1; j <= i + 2 && j < lines.length; j++) {
      const p = lines[j].match(/echo "(anthropic|openai|xai)"/);
      if (p) {
        for (const pattern of m[1].split("|")) {
          routes.push({ pattern, provider: p[1] as Provider });
        }
        break;
      }
    }
    if (lines[i].trim().startsWith("*)")) break;
  }
  expect(routes.length, "parsed at least one route").toBeGreaterThan(0);
  return routes;
}

describe("run-agent forwards exactly one provider API key", () => {
  it("does not pass all three keys unconditionally on the docker run line", () => {
    const dockerRun = action.slice(action.indexOf("docker run --rm"));
    expect(dockerRun).not.toMatch(/-e ANTHROPIC_API_KEY \\\n\s*-e OPENAI_API_KEY/);
    expect(dockerRun).toContain('"${_key_env[@]}"');
  });

  it("routes by the documented prefixes (pins the TypeScript mirror to the YAML)", () => {
    expect(action).toContain("sonnet|opus|haiku|claude-*) _key_env=(-e ANTHROPIC_API_KEY)");
    expect(action).toContain("gpt-*|o[0-9]*)              _key_env=(-e OPENAI_API_KEY)");
    expect(action).toContain("grok-*)                     _key_env=(-e XAI_API_KEY)");
  });

  for (const { path, content } of entrypoints) {
    describe(`agrees with resolve_provider() in ${path}`, () => {
      for (const { pattern, provider } of entrypointRoutes(content)) {
        // Turn a shell glob into a representative literal: `claude-*` →
        // `claude-x`. Literal patterns are used as-is.
        const sample = pattern.replace(/\*$/, "x");
        it(`${pattern} → ${provider}`, () => {
          expect(actionProvider(sample)).toBe(provider);
        });
      }
    });
  }

  it("forwards no key for an unrecognised model (entrypoint then fails loud)", () => {
    expect(actionProvider("llama-3")).toBeNull();
    expect(action).toContain("matches no provider prefix; forwarding no provider API key");
  });
});

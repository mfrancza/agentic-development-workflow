import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const entrypoint = readFileSync(
  new URL("../../../docker/scripts/entrypoint.sh", import.meta.url),
  "utf8",
);

function pushCommands(source: string): string[] {
  return source
    .replace(/\\\n\s*/g, " ")
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .flatMap((line) =>
      Array.from(line.matchAll(/\bgit\s+push(?:\s|$)[^;|&]*/g), (match) => match[0].trim()),
    );
}

function unsafePush(command: string): boolean {
  const argumentsAfterPush = command
    .replace(/^git\s+push\s*/, "")
    .match(/(?:[^\s'"\\]|\\.|"[^"]*"|'[^']*')+/g) ?? [];
  return argumentsAfterPush.some((argument) => {
    const unquoted = argument.replace(/["']/g, "");
    return /^--force(?:=|-|$)/.test(unquoted) ||
      /^-[^-\s]*f/.test(unquoted) ||
      /^\+/.test(unquoted);
  });
}

describe("normal-only entrypoint publication", () => {
  const actions = [
    { name: "fix_checks", count: 1 },
    { name: "resolve_conflicts", count: 2 },
    { name: "fix_deployment", count: 1 },
  ];

  for (const { name, count } of actions) {
    it(`${name} keeps all ${count} push paths free of force`, () => {
      const functionBody = entrypoint.match(
        new RegExp(`^action_${name}\\(\\) \\{\\n([\\s\\S]*?)^\\}`, "m"),
      );
      expect(functionBody, `Missing action_${name}`).not.toBeNull();
      const pushes = pushCommands(functionBody![1]);
      expect(pushes).toHaveLength(count);
      expect(pushes.filter(unsafePush)).toEqual([]);
    });
  }

  it.each([
    "git push --force origin branch",
    "git push --force-with-lease origin branch",
    "git push --force-with-lease=refs/heads/branch:abc origin branch",
    "git push --force-if-includes origin branch",
    "git push -f origin branch",
    "git push -vf origin branch",
    'git push origin "+HEAD:refs/heads/branch"',
    "git push origin '+HEAD:refs/heads/branch'",
    "git push origin +HEAD:refs/heads/branch",
    "if git push -f origin branch; then",
    "git push \\\n      --force origin branch",
  ])("recognizes unsafe push syntax: %s", (source) => {
    const commands = pushCommands(source);
    expect(commands).toHaveLength(1);
    expect(unsafePush(commands[0])).toBe(true);
  });
});

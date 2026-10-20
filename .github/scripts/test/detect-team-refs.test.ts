import { describe, expect, it } from "vitest";
import { hasTeamReference } from "../src/detect-team-refs.js";

describe("hasTeamReference", () => {
  it.each([
    ["", false],
    ["[]", false],
    ['["alice", "octo/maintainers"]', true],
    ['["alice", "not/a/team/reference"]', true],
    ['["alice", 1]', false],
    ["not json", false],
  ])("returns %s for %j", (input, expected) => {
    expect(hasTeamReference(input)).toBe(expected);
  });
});

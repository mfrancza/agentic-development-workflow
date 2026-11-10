import { describe, expect, it, vi } from "vitest";
import { shouldResolveConflicts } from "../src/lib/conflict-resolution-state.js";

describe("conflict resolution state gate", () => {
  it("bypasses the PR lookup for push and dispatch", async () => {
    const getState = vi.fn();
    await expect(shouldResolveConflicts("", "", getState)).resolves.toBe(true);
    expect(getState).not.toHaveBeenCalled();
  });

  it.each(["", "0", "01", "-1", "1.5", "9007199254740992"])(
    "rejects an invalid on-demand PR number %s",
    async (number) => {
      const getState = vi.fn();
      await expect(shouldResolveConflicts("operator", number, getState)).rejects.toThrow("valid PR number");
      expect(getState).not.toHaveBeenCalled();
    },
  );

  it.each([["open", true], ["closed", false], ["unknown", false]])(
    "returns the gate result for state %s",
    async (state, expected) => {
      const getState = vi.fn().mockResolvedValue(state);
      await expect(shouldResolveConflicts("operator", "42", getState)).resolves.toBe(expected);
      expect(getState).toHaveBeenCalledWith(42);
    },
  );

  it("fails closed when the PR lookup fails", async () => {
    await expect(shouldResolveConflicts("operator", "42", async () => {
      throw new Error("API unavailable");
    })).rejects.toThrow("API unavailable");
  });
});

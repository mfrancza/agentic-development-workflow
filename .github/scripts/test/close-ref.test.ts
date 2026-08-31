import { describe, it, expect } from "vitest";
import { parseClosesRef } from "../src/lib/close-ref.js";

describe("parseClosesRef", () => {
  it("returns the issue number when the body contains a well-formed 'Closes #N' reference", () => {
    expect(parseClosesRef("Implement feature\n\nCloses #137")).toBe(137);
  });

  it("returns undefined when the body contains no Closes #N reference", () => {
    expect(parseClosesRef("No issue reference here.")).toBeUndefined();
  });

  it("returns undefined when the body is null", () => {
    expect(parseClosesRef(null)).toBeUndefined();
  });

  it("matches case-insensitively", () => {
    expect(parseClosesRef("CLOSES #42")).toBe(42);
  });

  it("returns the first issue number when multiple references appear in the body", () => {
    expect(parseClosesRef("Closes #10\nAlso closes #20")).toBe(10);
  });
});

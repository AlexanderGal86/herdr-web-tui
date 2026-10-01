/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { terminalFontFamily } from "./terminalFont";

describe("terminalFontFamily", () => {
  afterEach(() => {
    document.documentElement.style.removeProperty("--mono");
  });

  it("returns the trimmed --mono custom property when set", () => {
    document.documentElement.style.setProperty("--mono", '"Nerd Font", monospace');
    expect(terminalFontFamily("fallback")).toBe('"Nerd Font", monospace');
  });

  it("falls back when --mono is empty", () => {
    expect(terminalFontFamily("fallback")).toBe("fallback");
  });
});

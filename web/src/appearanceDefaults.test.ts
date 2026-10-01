/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import {
  defaultDisplayScope,
  defaultSidebarWidth,
  setAppearance,
} from "./appearance";

afterEach(() => {
  setAppearance("tui");
});

describe("defaultDisplayScope", () => {
  it("prefers the all-scope under the tui theme", () => {
    setAppearance("tui");
    expect(defaultDisplayScope("space")).toBe("all");
  });

  it("keeps the fallback under the web theme", () => {
    setAppearance("web");
    expect(defaultDisplayScope("space")).toBe("space");
  });
});

describe("defaultSidebarWidth", () => {
  it("prefers the narrow tui width", () => {
    setAppearance("tui");
    expect(defaultSidebarWidth(320)).toBe(240);
  });

  it("keeps the fallback width under the web theme", () => {
    setAppearance("web");
    expect(defaultSidebarWidth(320)).toBe(320);
  });
});

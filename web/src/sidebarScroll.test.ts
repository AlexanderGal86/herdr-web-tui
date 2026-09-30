/** @vitest-environment jsdom */
import { afterEach, expect, it } from "vitest";
import { spaceScrollContainer } from "./sidebarScroll";

afterEach(() => { document.body.replaceChildren(); });

it("uses the independently scrolling spaces section for drag edge detection", () => {
  const list = document.createElement("div");
  const section = document.createElement("section");
  section.dataset.sidebarSection = "spaces";
  section.style.overflowY = "auto";
  list.append(section);
  document.body.append(list);
  expect(spaceScrollContainer(list)).toBe(section);
  section.style.overflowY = "visible";
  expect(spaceScrollContainer(list)).toBe(list);
});

it("retains the original scrolling list when there is no spaces section", () => {
  const list = document.createElement("div");
  expect(spaceScrollContainer(list)).toBe(list);
  expect(spaceScrollContainer(null)).toBeNull();
});

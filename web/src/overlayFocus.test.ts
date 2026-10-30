/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from "vitest";
import { trapFocusWithin } from "./overlayFocus";

type TabEvent = Parameters<typeof trapFocusWithin>[0];

function tabEvent(container: HTMLElement, shiftKey = false): TabEvent {
  return {
    key: "Tab",
    shiftKey,
    currentTarget: container,
    preventDefault: vi.fn(),
  } as unknown as TabEvent;
}

describe("trapFocusWithin", () => {
  it("wraps Tab from an unfocusable in-trap element (tabindex=-1)", () => {
    const container = document.createElement("div");
    const first = document.createElement("button");
    const last = document.createElement("button");
    const unfocusable = document.createElement("span");
    unfocusable.tabIndex = -1;
    container.append(first, unfocusable, last);
    document.body.appendChild(container);
    unfocusable.focus();

    const event = tabEvent(container);
    trapFocusWithin(event);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(document.activeElement).toBe(first);

    container.remove();
  });

  it("wraps Shift+Tab back to the last focusable element", () => {
    const container = document.createElement("div");
    const first = document.createElement("button");
    const last = document.createElement("button");
    const unfocusable = document.createElement("span");
    unfocusable.tabIndex = -1;
    container.append(first, unfocusable, last);
    document.body.appendChild(container);
    unfocusable.focus();

    const event = tabEvent(container, true);
    trapFocusWithin(event);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(document.activeElement).toBe(last);

    container.remove();
  });

  it("keeps normal cycling between focusable elements", () => {
    const container = document.createElement("div");
    const first = document.createElement("button");
    const last = document.createElement("button");
    container.append(first, last);
    document.body.appendChild(container);
    first.focus();

    const event = tabEvent(container);
    trapFocusWithin(event);

    expect(event.preventDefault).not.toHaveBeenCalled();

    container.remove();
  });
});

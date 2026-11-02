/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DisconnectedBridgeRow } from "./App";

const roots: Root[] = [];
const onSelect = vi.fn();
const onRetry = vi.fn();
let container: HTMLElement;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  onSelect.mockClear();
  onRetry.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) {
      root.unmount();
    }
  });
  document.body.innerHTML = "";
});

async function renderRow() {
  const root = roots[roots.length - 1];
  await act(async () => {
    root.render(
      <DisconnectedBridgeRow
        label="Bridge A"
        message="Bridge disconnected"
        onSelect={onSelect}
        onRetry={onRetry}
      />,
    );
  });
  return container.firstElementChild as HTMLElement;
}

describe("DisconnectedBridgeRow", () => {
  it("renders a non-interactive row with a select button and a retry button", async () => {
    const row = await renderRow();

    expect(row.tagName).toBe("DIV");
    expect(row.className).toBe("pane-row");
    expect(row.getAttribute("role")).toBeNull();
    expect(row.getAttribute("tabindex")).toBeNull();

    const select = row.querySelector<HTMLButtonElement>("button.pane-select");
    expect(select?.type).toBe("button");
    expect(select?.querySelector(".dot[data-status='unknown']")).not.toBeNull();
    expect(select?.querySelector(".pane-name")?.textContent).toBe("Bridge A");
    expect(select?.querySelector(".pane-meta")?.textContent).toBe(
      "Bridge disconnected",
    );

    const retry = row.querySelector<HTMLButtonElement>("button.pane-word");
    expect(retry?.type).toBe("button");
    expect(retry?.dataset.status).toBe("working");
    expect(retry?.textContent).toBe("retry");
  });

  it("selects the pane when the select button is clicked", async () => {
    const row = await renderRow();
    const select = row.querySelector<HTMLButtonElement>("button.pane-select");

    await act(async () => {
      select?.click();
    });

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("retries without selecting when the retry button is clicked", async () => {
    const row = await renderRow();
    const retry = row.querySelector<HTMLButtonElement>("button.pane-word");

    await act(async () => {
      retry?.click();
    });

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("keeps the select button ahead of retry in tab order", async () => {
    const row = await renderRow();
    // Both are native buttons without tabIndex overrides, so DOM order is tab order.
    const select = row.querySelector("button.pane-select") as HTMLElement;
    const retry = row.querySelector("button.pane-word") as HTMLElement;
    expect(
      select.compareDocumentPosition(retry) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

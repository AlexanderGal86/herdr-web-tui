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
}

function row() {
  const row = container.querySelector<HTMLElement>('.pane-row[role="button"]');
  if (!row) {
    throw new Error("missing disconnected row");
  }
  return row;
}

function retryButton() {
  const button = container.querySelector<HTMLButtonElement>("button.pane-word");
  if (!button) {
    throw new Error("missing retry button");
  }
  return button;
}

function pressKey(target: HTMLElement, key: string) {
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}

describe("DisconnectedBridgeRow", () => {
  it("renders the retry affordance as a real button inside a row button role", async () => {
    await renderRow();
    const rowElement = row();
    expect(rowElement.tagName).toBe("DIV");
    expect(rowElement.tabIndex).toBe(0);
    const button = retryButton();
    expect(button.tagName).toBe("BUTTON");
    expect(button.type).toBe("button");
    // No nested interactive element inside a native button: the row must not be one.
    expect(rowElement.querySelector("button")).not.toBeNull();
  });

  it("selects the row on Enter and Space keys", async () => {
    await renderRow();
    await act(async () => {
      pressKey(row(), "Enter");
    });
    expect(onSelect).toHaveBeenCalledTimes(1);
    await act(async () => {
      pressKey(row(), " ");
    });
    expect(onSelect).toHaveBeenCalledTimes(2);
    await act(async () => {
      pressKey(row(), "a");
    });
    expect(onSelect).toHaveBeenCalledTimes(2);
  });

  it("retries without selecting when the retry button is clicked", async () => {
    await renderRow();
    await act(async () => {
      retryButton().click();
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("does not select the row when keys pressed on the retry button bubble up", async () => {
    await renderRow();
    await act(async () => {
      pressKey(retryButton(), "Enter");
    });
    expect(onSelect).not.toHaveBeenCalled();
  });
});

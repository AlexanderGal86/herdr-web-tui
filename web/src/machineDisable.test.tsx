/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MachineDisableFlow,
  machineDisableTarget,
  type MachineDisableMenuTarget,
} from "./machineDisable";
import type { MachineGroup } from "./machines";

let container: HTMLDivElement;
let root: Root;

function group(overrides: Partial<MachineGroup>): MachineGroup {
  return {
    key: "machine:farm1",
    machineId: "farm1",
    label: "farm1",
    runtimeId: "machine:farm1",
    status: "connected",
    view: {
      runtimeId: "machine:farm1",
      mode: "machine",
      label: "farm1",
      loadState: "ready",
      capabilityState: "ready",
      hasSnapshot: true,
    },
    ...overrides,
  };
}

function renderFlow(menu: MachineDisableMenuTarget | null, onDisable: (id: string) => Promise<void>) {
  flushSync(() => {
    root.render(
      <MachineDisableFlow menu={menu} onDisable={onDisable} onCloseMenu={() => {}} />,
    );
  });
}

function menuItem() {
  return container.querySelector<HTMLButtonElement>('[role="menuitem"]');
}

function confirmButton() {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "Отключить",
  );
}

function cancelButton() {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "Cancel",
  );
}

async function click(button: HTMLButtonElement) {
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
});

describe("machineDisableTarget", () => {
  it("targets saved SSH machine groups only", () => {
    expect(machineDisableTarget(group({}))).toEqual({ machineId: "farm1", label: "farm1" });
    expect(
      machineDisableTarget(
        group({
          machineId: "local",
          key: "machine:local",
          label: "Local",
          runtimeId: "same-origin",
          view: {
            runtimeId: "same-origin",
            mode: "same-origin",
            label: "Local",
            loadState: "ready",
            capabilityState: "ready",
            hasSnapshot: true,
          },
        }),
      ),
    ).toBeNull();
    expect(
      machineDisableTarget(
        group({
          machineId: null,
          key: "bridge:http1",
          label: "http1",
          runtimeId: "http1",
          view: {
            runtimeId: "http1",
            mode: "configured",
            label: "http1",
            loadState: "ready",
            capabilityState: "ready",
            hasSnapshot: true,
          },
        }),
      ),
    ).toBeNull();
  });
});

describe("MachineDisableFlow", () => {
  const menu: MachineDisableMenuTarget = { machineId: "farm1", label: "farm1", x: 40, y: 60 };

  it("opens the menu, and cancel never disables", async () => {
    const onDisable = vi.fn(async () => {});
    renderFlow(menu, onDisable);
    expect(menuItem()?.textContent).toBe("Отключить подключение");
    await click(menuItem()!);
    expect(document.body.textContent).toContain("Отключить farm1?");
    await click(cancelButton()!);
    expect(onDisable).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("Отключить farm1?");
  });

  it("confirms with the machine id and closes after success", async () => {
    const onDisable = vi.fn(async () => {});
    renderFlow(menu, onDisable);
    await click(menuItem()!);
    await click(confirmButton()!);
    expect(onDisable).toHaveBeenCalledExactlyOnceWith("farm1");
    expect(document.body.textContent).not.toContain("Отключить farm1?");
  });

  it("keeps the dialog open with the error visible on failure", async () => {
    const onDisable = vi.fn(async () => {
      throw new Error("machine disable failed (502)");
    });
    renderFlow(menu, onDisable);
    await click(menuItem()!);
    await click(confirmButton()!);
    expect(document.body.querySelector('[role="alert"]')?.textContent).toBe(
      "machine disable failed (502)",
    );
    // The dialog is still up: the machine is only dropped after the refreshed list.
    expect(document.body.textContent).toContain("Отключить farm1?");
  });

  it("locks submit and cancel while the request is in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const onDisable = vi.fn(() => gate);
    renderFlow(menu, onDisable);
    await click(menuItem()!);
    await click(confirmButton()!);
    expect(confirmButton()!.disabled).toBe(true);
    await click(cancelButton()!);
    expect(document.body.textContent).toContain("Отключить farm1?");
    await act(async () => {
      release();
      await gate;
    });
  });
});

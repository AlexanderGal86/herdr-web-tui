/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MachineAddDialog } from "./MachineAddDialog";

const roots: Root[] = [];

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) {
      root.unmount();
    }
  });
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("MachineAddDialog", () => {
  it("submits the trimmed target and omits blank optional fields", async () => {
    const { container, onSubmit } = await renderDialog();

    await setValue(labeledInput(container, "SSH target"), " root@10.0.0.250 ");
    await setValue(labeledInput(container, "Machine label (optional)"), " farm ");
    await act(async () => {
      submitButton(container).click();
    });

    expect(onSubmit).toHaveBeenCalledWith({
      target: "root@10.0.0.250",
      label: "farm",
      session: undefined,
    });
  });

  it("keeps the submit disabled while the target is blank and blocks while busy", async () => {
    const { container, onSubmit, root } = await renderDialog();
    const submit = submitButton(container);

    expect(submit.disabled).toBe(true);
    await act(async () => {
      submit.click();
    });
    expect(onSubmit).not.toHaveBeenCalled();

    await setValue(labeledInput(container, "SSH target"), "root@host");
    expect(submitButton(container).disabled).toBe(false);

    await act(async () => {
      root.render(
        <MachineAddDialog
          busy
          error={null}
          onCancel={vi.fn()}
          onSubmit={onSubmit}
        />,
      );
    });
    expect(submitButton(container).disabled).toBe(true);
  });

  it("cancels on Escape and ignores Escape while busy", async () => {
    const onCancel = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);

    await act(async () => {
      root.render(
        <MachineAddDialog busy={false} error={null} onCancel={onCancel} onSubmit={vi.fn()} />,
      );
    });
    await press(dialog(container), "Escape");
    expect(onCancel).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.render(
        <MachineAddDialog busy error={null} onCancel={onCancel} onSubmit={vi.fn()} />,
      );
    });
    await press(dialog(container), "Escape");
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("exposes a labelled modal with an alert region wired to the submit button", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);

    await act(async () => {
      root.render(
        <MachineAddDialog
          busy={false}
          error="machine add failed: ssh refused"
          onCancel={vi.fn()}
          onSubmit={vi.fn()}
        />,
      );
    });

    const dialogElement = dialog(container);
    expect(dialogElement.getAttribute("aria-modal")).toBe("true");
    expect(dialogElement.getAttribute("aria-labelledby")).toBe(
      requiredElement(container, ".modal-title").id,
    );
    for (const label of ["SSH target", "Machine label (optional)", "Remote session (optional)"]) {
      expect(labeledInput(container, label)).toBeInstanceOf(HTMLInputElement);
    }
    const alert = requiredElement(container, '[role="alert"]');
    expect(alert.textContent).toBe("machine add failed: ssh refused");
    expect(submitButton(container).getAttribute("aria-describedby")).toBe(alert.id);
  });

  it("contains modal focus and restores the opener", async () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const { container, root } = await renderDialog();
    const dialogElement = dialog(container);
    const target = labeledInput(container, "SSH target");
    const submit = submitButton(container);

    expect(document.activeElement).toBe(target);
    submit.focus();
    await press(submit, "Tab");
    expect(
      dialogElement.contains(document.activeElement) || document.activeElement === dialogElement,
    ).toBe(true);

    await act(async () => root.render(null));
    expect(document.activeElement).toBe(opener);
  });
});

async function renderDialog() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  const onSubmit = vi.fn();

  await act(async () => {
    root.render(
      <MachineAddDialog busy={false} error={null} onCancel={vi.fn()} onSubmit={onSubmit} />,
    );
  });

  return { container, onSubmit, root };
}

function dialog(container: HTMLElement) {
  return requiredElement<HTMLFormElement>(container, '[role="dialog"]');
}

function labeledInput(container: ParentNode, label: string) {
  return requiredElement<HTMLInputElement>(container, `[aria-label="${label}"]`);
}

function submitButton(container: HTMLElement) {
  const button = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
    (candidate) => candidate.textContent === "Add machine",
  );
  if (!button) {
    throw new Error("missing add machine submit button");
  }
  return button;
}

async function setValue(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")
      ?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function press(target: HTMLElement, key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", {
    ...init,
    key,
    bubbles: true,
    cancelable: true,
  });
  await act(async () => target.dispatchEvent(event));
  return event;
}

function requiredElement<T extends Element = HTMLElement>(container: ParentNode, selector: string) {
  const element = container.querySelector<T>(selector);
  if (!element) {
    throw new Error(`missing element: ${selector}`);
  }
  return element;
}

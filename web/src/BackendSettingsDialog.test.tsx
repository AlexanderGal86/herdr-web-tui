/**
 * @vitest-environment jsdom
 */
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackendSettingsDialog } from "./BackendSettingsDialog";

const bridge = vi.hoisted(() => ({
  store: {
    backends: [],
    enabledBridgeIds: [],
  },
  lastSelectedBridgeId: null,
  sameOriginAvailable: true,
  addBackend: vi.fn(),
  deleteBackend: vi.fn(),
  probeBackend: vi.fn(),
  setBridgeEnabled: vi.fn(),
  updateBackend: vi.fn(),
}));

vi.mock("./bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./bridge")>();
  return {
    ...actual,
    // Mirror the real provider (a new context value whenever the store is
    // replaced): each render sees the store as it exists at that render, so
    // closures from earlier renders stay stale like they do in the app.
    useBridge: () => ({ ...bridge, store: bridge.store }),
  };
});

const roots: Root[] = [];

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) {
      root.unmount();
    }
  });
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("BackendSettingsDialog terminal accessibility", () => {
  it("offers appearance as the first setting in Display", async () => {
    const { container } = await render(<BackendSettingsDialog {...settingsProps()} />);
    const displayTab = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
      .find((button) => button.textContent === "Display");
    expect(displayTab).toBeDefined();
    await act(async () => displayTab!.click());

    const firstRow = container.querySelector('.settings-panel .settings-row');
    expect(firstRow?.textContent).toContain("Appearance");
    const buttons = Array.from(firstRow?.querySelectorAll("button") ?? []);
    expect(buttons.map((button) => button.textContent)).toEqual(["Herdr TUI", "Web"]);
    expect(buttons[0]?.getAttribute("aria-pressed")).toBe("true");
  });

  it("offers mobile refocus independently of expanding input", async () => {
    const onFocusChange = vi.fn();
    const { container } = await render(
      <BackendSettingsDialog {...settingsProps()} showMobileTerminalSettings={true}
        mobileCommandExpandingInput={false} onMobileCommandFocusAfterSubmit={onFocusChange} />,
    );
    const tab = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
      .find((button) => button.textContent?.includes("Mobile"));
    expect(tab).toBeDefined();
    await act(async () => tab!.click());
    const group = requiredElement<HTMLElement>(container,
      '[role="group"][aria-label="Focus command input after Send"]');
    const [off, on] = Array.from(group.querySelectorAll<HTMLButtonElement>("button"));
    expect(off.getAttribute("aria-pressed")).toBe("true");
    await act(async () => on.click());
    expect(onFocusChange).toHaveBeenCalledWith(true);
  });

  it("exposes a persisted-style opt-in control in the Terminal area", async () => {
    const onChange = vi.fn();
    const { container } = await render(<SettingsHarness onChange={onChange} />);
    const terminalTab = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    ).find((button) => button.textContent?.includes("Terminal"));
    if (!terminalTab) {
      throw new Error("missing Terminal settings tab");
    }

    await act(async () => terminalTab.click());
    const group = requiredElement<HTMLElement>(
      container,
      '[role="group"][aria-label="Terminal screen-reader text"]',
    );
    const [off, on] = Array.from(group.querySelectorAll<HTMLButtonElement>("button"));
    expect(off?.getAttribute("aria-pressed")).toBe("true");
    expect(on?.getAttribute("aria-pressed")).toBe("false");

    await act(async () => on?.click());
    expect(onChange).toHaveBeenCalledWith(true);
    expect(off?.getAttribute("aria-pressed")).toBe("false");
    expect(on?.getAttribute("aria-pressed")).toBe("true");
  });

  it("allows automatic conflict renaming to be disabled in the Terminal area", async () => {
    const onChange = vi.fn();
    const { container } = await render(<UploadSettingsHarness onChange={onChange} />);
    const terminalTab = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    ).find((button) => button.textContent?.includes("Terminal"));
    if (!terminalTab) {
      throw new Error("missing Terminal settings tab");
    }

    await act(async () => terminalTab.click());
    const group = requiredElement<HTMLElement>(
      container,
      '[role="group"][aria-label="Automatically rename conflicting uploads"]',
    );
    const [off, on] = Array.from(group.querySelectorAll<HTMLButtonElement>("button"));
    expect(off?.getAttribute("aria-pressed")).toBe("false");
    expect(on?.getAttribute("aria-pressed")).toBe("true");

    await act(async () => off?.click());
    expect(onChange).toHaveBeenCalledWith(false);
    expect(off?.getAttribute("aria-pressed")).toBe("true");
    expect(on?.getAttribute("aria-pressed")).toBe("false");
  });

  it("offers desktop command composer settings in the Terminal area", async () => {
    const onComposerChange = vi.fn();
    const onEnterNewlineChange = vi.fn();
    const { container } = await render(
      <ComposerSettingsHarness
        onComposerChange={onComposerChange}
        onEnterNewlineChange={onEnterNewlineChange}
      />,
    );
    const terminalTab = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    ).find((button) => button.textContent?.includes("Terminal"));
    if (!terminalTab) {
      throw new Error("missing Terminal settings tab");
    }

    await act(async () => terminalTab.click());
    const composerGroup = requiredElement<HTMLElement>(
      container,
      '[role="group"][aria-label="Command composer"]',
    );
    const [composerOff, composerOn] = Array.from(
      composerGroup.querySelectorAll<HTMLButtonElement>("button"),
    );
    expect(composerOff?.getAttribute("aria-pressed")).toBe("true");

    await act(async () => composerOn?.click());
    expect(onComposerChange).toHaveBeenCalledWith(true);
    expect(composerOn?.getAttribute("aria-pressed")).toBe("true");

    const newlineGroup = requiredElement<HTMLElement>(
      container,
      '[role="group"][aria-label="Desktop composer Enter inserts newline"]',
    );
    const [newlineOff, newlineOn] = Array.from(
      newlineGroup.querySelectorAll<HTMLButtonElement>("button"),
    );
    expect(newlineOn?.getAttribute("aria-pressed")).toBe("true");

    await act(async () => newlineOff?.click());
    expect(onEnterNewlineChange).toHaveBeenCalledWith(false);
    expect(newlineOff?.getAttribute("aria-pressed")).toBe("true");
  });

  it("allows cursor blinking to be enabled in the Terminal area", async () => {
    const onChange = vi.fn();
    const { container } = await render(<CursorBlinkSettingsHarness onChange={onChange} />);
    const terminalTab = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    ).find((button) => button.textContent?.includes("Terminal"));
    if (!terminalTab) {
      throw new Error("missing Terminal settings tab");
    }

    await act(async () => terminalTab.click());
    const group = requiredElement<HTMLElement>(
      container,
      '[role="group"][aria-label="Terminal cursor blink"]',
    );
    const [off, on] = Array.from(group.querySelectorAll<HTMLButtonElement>("button"));
    expect(off?.getAttribute("aria-pressed")).toBe("true");

    await act(async () => on?.click());
    expect(onChange).toHaveBeenCalledWith(true);
    expect(on?.getAttribute("aria-pressed")).toBe("true");
  });
});

function CursorBlinkSettingsHarness({ onChange }: { onChange: (enabled: boolean) => void }) {
  const [terminalCursorBlink, setTerminalCursorBlink] = useState(false);
  return (
    <BackendSettingsDialog
      {...settingsProps()}
      showMobileTerminalSettings={false}
      terminalCursorBlink={terminalCursorBlink}
      onTerminalCursorBlink={(enabled) => {
        onChange(enabled);
        setTerminalCursorBlink(enabled);
      }}
    />
  );
}

function SettingsHarness({ onChange }: { onChange: (enabled: boolean) => void }) {
  const [terminalScreenReaderText, setTerminalScreenReaderText] = useState(false);
  return (
    <BackendSettingsDialog
      {...settingsProps()}
      terminalScreenReaderText={terminalScreenReaderText}
      onTerminalScreenReaderText={(enabled) => {
        onChange(enabled);
        setTerminalScreenReaderText(enabled);
      }}
    />
  );
}

function UploadSettingsHarness({ onChange }: { onChange: (enabled: boolean) => void }) {
  const [autoRenameUploadConflicts, setAutoRenameUploadConflicts] = useState(true);
  return (
    <BackendSettingsDialog
      {...settingsProps()}
      autoRenameUploadConflicts={autoRenameUploadConflicts}
      onAutoRenameUploadConflicts={(enabled) => {
        onChange(enabled);
        setAutoRenameUploadConflicts(enabled);
      }}
    />
  );
}

function ComposerSettingsHarness({
  onComposerChange,
  onEnterNewlineChange,
}: {
  onComposerChange: (enabled: boolean) => void;
  onEnterNewlineChange: (enabled: boolean) => void;
}) {
  const [desktopCommandComposer, setDesktopCommandComposer] = useState(false);
  const [desktopCommandEnterNewline, setDesktopCommandEnterNewline] = useState(true);
  return (
    <BackendSettingsDialog
      {...settingsProps()}
      showMobileTerminalSettings={false}
      desktopCommandComposer={desktopCommandComposer}
      onDesktopCommandComposer={(enabled) => {
        onComposerChange(enabled);
        setDesktopCommandComposer(enabled);
      }}
      desktopCommandEnterNewline={desktopCommandEnterNewline}
      onDesktopCommandEnterNewline={(enabled) => {
        onEnterNewlineChange(enabled);
        setDesktopCommandEnterNewline(enabled);
      }}
    />
  );
}

function settingsProps() {
  return {
    showMobileTerminalSettings: true,
    notesEnabled: true,
    onNotesEnabled: vi.fn(),
    navigationSyncMode: "shared" as const,
    onNavigationSyncMode: vi.fn(),
    agentFeaturesInTabs: true,
    onAgentFeaturesInTabs: vi.fn(),
    combineMatchingWorkspaceNames: false,
    onCombineMatchingWorkspaceNames: vi.fn(),
    multiHostSpaceSelection: true,
    onMultiHostSpaceSelection: vi.fn(),
    terminalFontSizePx: 13,
    onTerminalFontSizePx: vi.fn(),
    terminalCursorBlink: false,
    onTerminalCursorBlink: vi.fn(),
    desktopCommandComposer: false,
    onDesktopCommandComposer: vi.fn(),
    desktopCommandEnterNewline: true,
    onDesktopCommandEnterNewline: vi.fn(),
    terminalScreenReaderText: false,
    onTerminalScreenReaderText: vi.fn(),
    autoRenameUploadConflicts: true,
    onAutoRenameUploadConflicts: vi.fn(),
    terminalInputTransport: "json" as const,
    onTerminalInputTransport: vi.fn(),
    terminalInputBatchDelayMs: 0,
    onTerminalInputBatchDelayMs: vi.fn(),
    terminalOutputCoalesceMs: 16,
    onTerminalOutputCoalesceMs: vi.fn(),
    contentInsetTopPx: 0,
    onContentInsetTopPx: vi.fn(),
    contentInsetBottomPx: 0,
    onContentInsetBottomPx: vi.fn(),
    mobileControlsScalePercent: 100,
    onMobileControlsScalePercent: vi.fn(),
    mobileTerminalTapTarget: "command-input" as const,
    onMobileTerminalTapTarget: vi.fn(),
    mobileLongPressBehavior: "off" as const,
    onMobileLongPressBehavior: vi.fn(),
    mobileTouchSelectionEndpointTimeoutMs: 1500 as const,
    onMobileTouchSelectionEndpointTimeoutMs: vi.fn(),
    mobileCommandExpandingInput: true,
    onMobileCommandExpandingInput: vi.fn(),
    mobileCommandEnterNewline: false,
    mobileCommandFocusAfterSubmit: false,
    onMobileCommandFocusAfterSubmit: vi.fn(),
    onMobileCommandEnterNewline: vi.fn(),
    showMobileKeyboardHideRefit: true,
    mobileKeyboardHideRefit: true,
    onMobileKeyboardHideRefit: vi.fn(),
    onClose: vi.fn(),
  };
}

async function render(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(node));
  return { container, root };
}

function requiredElement<T extends Element = HTMLElement>(
  container: ParentNode,
  selector: string,
) {
  const element = container.querySelector<T>(selector);
  if (!element) {
    throw new Error(`missing element: ${selector}`);
  }
  return element;
}

describe("BackendSettingsDialog save race", () => {
  afterEach(() => {
    (bridge.store as { backends: import("./bridge").BridgeBackendProfile[] }).backends = [];
    bridge.store.enabledBridgeIds = [];
    (bridge as { lastSelectedBridgeId: string | null }).lastSelectedBridgeId = null;
  });

  it("does not clobber a mode switch made while a save is in flight", async () => {
    (bridge.store as { backends: import("./bridge").BridgeBackendProfile[] }).backends = [
      { id: "b1", name: "Host", baseUrl: "http://host:1", color: "#112233" },
    ];
    (bridge as { lastSelectedBridgeId: string | null }).lastSelectedBridgeId = "b1";

    const probe = deferred<void>();
    const update = deferred<import("./bridge").BridgeBackendProfile>();
    bridge.probeBackend.mockImplementation(() => probe.promise);
    bridge.updateBackend.mockImplementation(() => update.promise);

    const { container } = await render(<BackendSettingsDialog {...settingsProps()} />);
    const urlInput = requiredElement<HTMLInputElement>(
      container,
      'input[placeholder^="https://herd.example"]',
    );
    expect(urlInput.value).toBe("http://host:1");

    await act(async () =>
      requiredElement<HTMLButtonElement>(container, ".modal-actions .btn-primary").click(),
    );
    // While the save request is still pending, the user starts adding a new bridge.
    await act(async () =>
      requiredElement<HTMLButtonElement>(container, ".backend-row-action").click(),
    );

    await act(async () => {
      probe.resolve(undefined);
      update.resolve({ id: "b1", name: "Host", baseUrl: "http://host:1", color: "#112233" });
    });

    expect(urlInput.value).toBe("");
    expect(
      requiredElement<HTMLButtonElement>(container, ".backend-row-action").dataset.active,
    ).toBe("true");
  });

  it("keeps edits made after leaving and returning to the same backend", async () => {
    (bridge.store as { backends: import("./bridge").BridgeBackendProfile[] }).backends = [
      { id: "b1", name: "Host", baseUrl: "http://host:1", color: "#112233" },
    ];
    (bridge as { lastSelectedBridgeId: string | null }).lastSelectedBridgeId = "b1";

    const probe = deferred<void>();
    const update = deferred<import("./bridge").BridgeBackendProfile>();
    bridge.probeBackend.mockImplementation(() => probe.promise);
    bridge.updateBackend.mockImplementation(() => update.promise);

    const { container } = await render(<BackendSettingsDialog {...settingsProps()} />);
    await act(async () =>
      requiredElement<HTMLButtonElement>(container, ".modal-actions .btn-primary").click(),
    );

    // Leave the backend (start adding a new one) and come back to the same
    // backend, so id/baseUrl/selection mode match the in-flight save again.
    await act(async () =>
      requiredElement<HTMLButtonElement>(container, ".backend-row-action").click(),
    );
    const hostRow = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".backend-row-main"),
    ).find((button) => button.textContent?.includes("Host"));
    if (!hostRow) {
      throw new Error("missing backend row for Host");
    }
    await act(async () => hostRow.click());
    const nameInput = requiredElement<HTMLInputElement>(
      container,
      'input[placeholder="Home workstation"]',
    );
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      setter?.call(nameInput, "MyHost");
      nameInput.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await act(async () => {
      probe.resolve(undefined);
      update.resolve({ id: "b1", name: "Host", baseUrl: "http://host:1", color: "#112233" });
    });

    expect(nameInput.value).toBe("MyHost");
  });

  it("lets the later of two overlapping saves win", async () => {
    (bridge.store as { backends: import("./bridge").BridgeBackendProfile[] }).backends = [
      { id: "b1", name: "Host", baseUrl: "http://host:1", color: "#112233" },
    ];
    (bridge as { lastSelectedBridgeId: string | null }).lastSelectedBridgeId = "b1";

    const probe1 = deferred<void>();
    const probe2 = deferred<void>();
    bridge.probeBackend
      .mockImplementationOnce(() => probe1.promise)
      .mockImplementationOnce(() => probe2.promise);
    // Stateful mock: each update writes through to the saved profile so the
    // final store payload can be asserted, not just the call order.
    const savedProfiles: Record<string, import("./bridge").BridgeBackendProfile> = {
      b1: { id: "b1", name: "Host", baseUrl: "http://host:1", color: "#112233" },
    };
    bridge.updateBackend.mockImplementation(
      (id: string, patch: import("./bridge").BackendInput) => {
        savedProfiles[id] = { ...savedProfiles[id], ...patch };
        return Promise.resolve(savedProfiles[id]);
      },
    );

    const { container } = await render(<BackendSettingsDialog {...settingsProps()} />);
    const nameInput = requiredElement<HTMLInputElement>(
      container,
      'input[placeholder="Home workstation"]',
    );

    // Save #1 under one name via the Save button; save #2 under a new name via
    // form submit while busy.
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      setter?.call(nameInput, "First Save");
      nameInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () =>
      requiredElement<HTMLButtonElement>(container, ".modal-actions .btn-primary").click(),
    );
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      setter?.call(nameInput, "Second Save");
      nameInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () =>
      requiredElement<HTMLFormElement>(container, "form.modal").dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      ),
    );

    // The first save is slow: its probe finishes after the second save's, so
    // without serialization the stale first save writes to the store last.
    await act(async () => {
      probe2.resolve(undefined);
    });
    await act(async () => {
      probe1.resolve(undefined);
    });

    // Store mutations must follow save start order: the last updateBackend
    // call carries the second save's payload, not the slow first save's.
    expect(
      bridge.updateBackend.mock.calls.map(([, patch]) => patch.name),
    ).toEqual(["First Save", "Second Save"]);
    // And the saved profile itself ends up with the second save's name: the
    // slow first save never overwrites it after the fact.
    expect(savedProfiles.b1?.name).toBe("Second Save");
  });

  it("does not add a duplicate when two queued saves create the same new backend", async () => {
    const probe1 = deferred<void>();
    bridge.probeBackend.mockImplementationOnce(() => probe1.promise);
    // Stateful mock with the real bridge's immutable store semantics: addBackend
    // replaces the store object (setStore does the same), so only a render that
    // happens after the save observes the created backend.
    bridge.addBackend.mockImplementation((input: import("./bridge").BackendInput) => {
      const created: import("./bridge").BridgeBackendProfile = {
        id: "new-1",
        name: input.name ?? "",
        baseUrl: input.baseUrl,
        color: input.color ?? "#112233",
      };
      (bridge as unknown as {
        store: { backends: import("./bridge").BridgeBackendProfile[] };
      }).store = {
        ...bridge.store,
        backends: [...bridge.store.backends, created],
      };
      return Promise.resolve(created);
    });

    const { container } = await render(<BackendSettingsDialog {...settingsProps()} />);
    // An empty store starts on the same-origin panel; switch to adding a new bridge.
    await act(async () =>
      requiredElement<HTMLButtonElement>(container, ".backend-row-action").click(),
    );
    const nameInput = requiredElement<HTMLInputElement>(
      container,
      'input[placeholder="Home workstation"]',
    );
    const urlInput = requiredElement<HTMLInputElement>(
      container,
      'input[placeholder^="https://herd.example"]',
    );

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      setter?.call(nameInput, "First Add");
      nameInput.dispatchEvent(new Event("input", { bubbles: true }));
      setter?.call(urlInput, "http://host:9");
      urlInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () =>
      requiredElement<HTMLButtonElement>(container, ".modal-actions .btn-primary").click(),
    );
    // Queue a second save of the same new backend (form.id is null in both
    // saves) under a different name while the first save is still probing.
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      setter?.call(nameInput, "Second Add");
      nameInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () =>
      requiredElement<HTMLFormElement>(container, "form.modal").dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      ),
    );

    await act(async () => {
      probe1.resolve(undefined);
    });
    await act(async () => {});

    // The first save creates the backend; the second save must read the live
    // store when it executes, see the just-created URL, and stop at the
    // duplicate branch instead of adding a second profile.
    expect(bridge.addBackend).toHaveBeenCalledTimes(1);
    expect(bridge.addBackend.mock.calls[0]?.[0].name).toBe("First Add");
    expect(
      (bridge.store as { backends: import("./bridge").BridgeBackendProfile[] }).backends.filter(
        (backend) => backend.baseUrl === "http://host:9",
      ),
    ).toHaveLength(1);
    expect(container.textContent).toContain("This URL is already saved as First Add.");
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

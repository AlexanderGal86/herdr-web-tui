/**
 * @vitest-environment jsdom
 */
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CommandDraftContext, createCommandDraftStore } from "./commandDrafts";
import type { TerminalRenderer, TerminalSize } from "./terminalRenderer";
import { TerminalView } from "./TerminalView";
import type { PaneInfo } from "./types";
import { setAppearance } from "./appearance";
import { TERMINAL_CONNECTION_LOST_EVENT } from "./terminalConnectionStatus";

const MOUNTED_TERMINAL_SIZE: TerminalSize = { cols: 80, rows: 24 };
const REFRESHED_TERMINAL_SIZE: TerminalSize = { cols: 120, rows: 48 };

class FakeTerminalRenderer implements TerminalRenderer {
  readonly refreshedSizes: TerminalSize[] = [];
  private pendingMountCompletion: (() => void) | null = null;
  selection = "";

  readonly input = document.createElement("textarea");
  readonly childEvents = vi.fn();

  mount(host: HTMLElement) {
    host.appendChild(this.input);
    for (const type of ["mousedown", "mouseup", "pointerdown", "pointerup", "contextmenu", "keydown", "keyup"]) {
      this.input.addEventListener(type, this.childEvents, { capture: true });
    }
    return new Promise<TerminalSize>((resolve) => {
      this.pendingMountCompletion = () => resolve(MOUNTED_TERMINAL_SIZE);
    });
  }

  completeMount() {
    const complete = this.pendingMountCompletion;
    if (!complete) {
      throw new Error("Fake terminal renderer has no pending mount");
    }
    this.pendingMountCompletion = null;
    complete();
  }

  write() {}

  setAccessibleScreenListener() {}

  setMouseCapture(enabled: boolean) {
    this.mouseCapture = enabled;
  }

  setMousePassthrough(enabled: boolean) {
    this.mousePassthrough = enabled;
  }

  mouseCapture = false;
  mousePassthrough = false;

  hasActiveMouseTracking() {
    return this.mouseCapture;
  }

  onMouse() {
    return () => {};
  }

  onInput() {
    return () => {};
  }

  onScroll() {
    return () => {};
  }

  setTapFocusHandler() {}

  setMobileTouchSelection() {}

  fit() {
    return MOUNTED_TERMINAL_SIZE;
  }

  refreshMetrics() {
    this.refreshedSizes.push(REFRESHED_TERMINAL_SIZE);
    return REFRESHED_TERMINAL_SIZE;
  }

  setFontSize() {
    return null;
  }

  focus() {}

  focusTextInput() {}

  clearSelection = vi.fn();

  getSelection() {
    return this.selection;
  }

  paste = vi.fn();

  setScrollSensitivity() {}

  dispose() {}
}

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static readonly instances: FakeWebSocket[] = [];

  readonly sent: string[] = [];
  readonly url: string;
  binaryType: BinaryType = "blob";
  readyState = FakeWebSocket.CONNECTING;

  constructor(url: string) {
    super();
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  open() {
    if (this.readyState !== FakeWebSocket.CONNECTING) {
      throw new Error("Fake WebSocket can only open while connecting");
    }
    this.readyState = FakeWebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  send(data: string) {
    if (this.readyState !== FakeWebSocket.OPEN) {
      throw new Error("Fake WebSocket cannot send before opening");
    }
    this.sent.push(data);
  }

  close() {
    if (this.readyState === FakeWebSocket.CLOSED) {
      return;
    }
    this.readyState = FakeWebSocket.CLOSING;
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }
}

const terminalUrl = (path: string) => path;
const roots: Root[] = [];
const terminalRenderers: FakeTerminalRenderer[] = [];

function createFakeTerminalRenderer() {
  const renderer = new FakeTerminalRenderer();
  terminalRenderers.push(renderer);
  return renderer;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(performance.now()), 16),
  );
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => window.clearTimeout(handle));

  FakeWebSocket.instances.length = 0;
  terminalRenderers.length = 0;
  setAppearance("tui");
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) {
      root.unmount();
    }
  });
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("TerminalView mobile refitting", () => {
  it("updates theme metrics without replacing the renderer or terminal connection", async () => {
    const drafts = createCommandDraftStore();
    await renderTerminalView(testPane("terminal-1"), drafts);
    const renderer = terminalRenderers[0]!;
    await act(async () => renderer.completeMount());
    const socket = FakeWebSocket.instances.at(-1)!;
    await act(async () => {
      socket.open();
      await vi.advanceTimersByTimeAsync(600);
    });
    const priorRefreshes = renderer.refreshedSizes.length;
    await act(async () => setAppearance("web"));
    expect(terminalRenderers).toEqual([renderer]);
    expect(FakeWebSocket.instances).toEqual([socket]);
    expect(socket.readyState).toBe(FakeWebSocket.OPEN);
    expect(renderer.refreshedSizes).toHaveLength(priorRefreshes + 1);
    expect(socket.sent.at(-1)).toBe(JSON.stringify({ type: "resize", cols: 120, rows: 48 }));
  });

  it("starts refit retries only after the current terminal renderer mounts", async () => {
    const drafts = createCommandDraftStore();
    const root = await renderTerminalView(testPane("terminal-1"), drafts);
    const firstRenderer = terminalRenderers[0];
    if (!firstRenderer) {
      throw new Error("Expected the first terminal renderer");
    }

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(firstRenderer.refreshedSizes).toEqual([]);

    await renderPane(root, testPane("terminal-2"), drafts);
    expect(terminalRenderers).toHaveLength(2);
    const currentRenderer = terminalRenderers[1];
    if (!currentRenderer) {
      throw new Error("Expected the current terminal renderer");
    }

    await act(async () => {
      firstRenderer.completeMount();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(firstRenderer.refreshedSizes).toEqual([]);
    expect(currentRenderer.refreshedSizes).toEqual([]);

    await act(async () => {
      currentRenderer.completeMount();
      await Promise.resolve();
    });
    const currentSocket = FakeWebSocket.instances.at(-1);
    if (!currentSocket) {
      throw new Error("Expected a terminal WebSocket");
    }
    expect(currentSocket.readyState).toBe(FakeWebSocket.CONNECTING);
    expect(currentSocket.sent).toEqual([]);
    expect(currentRenderer.refreshedSizes).toEqual([]);

    await act(async () => {
      currentSocket.open();
      await Promise.resolve();
    });
    expect(currentRenderer.refreshedSizes).toEqual([]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(16);
    });
    expect(currentRenderer.refreshedSizes).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(520);
    });
    expect(currentRenderer.refreshedSizes).toHaveLength(4);
    expect(currentSocket.sent.at(-1)).toBe(JSON.stringify({ type: "resize", cols: 120, rows: 48 }));
  });

  it("does not schedule replacement refits from stale terminal readiness", async () => {
    const requestAnimationFrameSpy = vi.spyOn(window, "requestAnimationFrame");
    const setTimeoutSpy = vi.spyOn(window, "setTimeout");
    const retryTimerDelays = () =>
      setTimeoutSpy.mock.calls
        .map(([, delay]) => delay)
        .filter((delay) => delay === 80 || delay === 280 || delay === 520);
    const drafts = createCommandDraftStore();
    const root = await renderTerminalView(testPane("terminal-1"), drafts);
    const firstRenderer = terminalRenderers[0];
    if (!firstRenderer) {
      throw new Error("Expected the first terminal renderer");
    }

    await act(async () => {
      firstRenderer.completeMount();
      await Promise.resolve();
    });
    expect(requestAnimationFrameSpy).toHaveBeenCalledTimes(1);
    expect(retryTimerDelays()).toEqual([80, 280, 520]);

    await renderPane(root, testPane("terminal-2"), drafts);
    const currentRenderer = terminalRenderers[1];
    if (!currentRenderer) {
      throw new Error("Expected the current terminal renderer");
    }

    expect(requestAnimationFrameSpy).toHaveBeenCalledTimes(1);
    expect(retryTimerDelays()).toEqual([80, 280, 520]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(currentRenderer.refreshedSizes).toEqual([]);

    await act(async () => {
      currentRenderer.completeMount();
      await Promise.resolve();
    });
    expect(requestAnimationFrameSpy).toHaveBeenCalledTimes(2);
    expect(retryTimerDelays()).toEqual([80, 280, 520, 80, 280, 520]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(16);
    });
    expect(currentRenderer.refreshedSizes).toHaveLength(1);
  });
});

async function renderTerminalView(
  pane: PaneInfo,
  drafts: ReturnType<typeof createCommandDraftStore>,
  overrides: Partial<ComponentProps<typeof TerminalView>> = {},
) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await renderPane(root, pane, drafts, overrides);
  return root;
}

async function renderPane(
  root: Root,
  pane: PaneInfo,
  drafts: ReturnType<typeof createCommandDraftStore>,
  overrides: Partial<ComponentProps<typeof TerminalView>> = {},
) {
  await act(async () => {
    root.render(
      <CommandDraftContext.Provider value={drafts}>
        <TerminalView
          bridgeId="bridge-1"
          pane={pane}
          connectionKey="test-connection"
          resumeToken={0}
          httpUrl={terminalUrl}
          wsUrl={terminalUrl}
          autoFocus={false}
          mobileControls
          terminalOutputCoalesceMs={0}
          selected
          createTerminalRenderer={createFakeTerminalRenderer}
          {...overrides}
        />
      </CommandDraftContext.Provider>,
    );
  });
}

function testPane(terminalId: string): PaneInfo {
  return {
    pane_id: "pane-1",
    terminal_id: terminalId,
    workspace_id: "workspace-1",
    tab_id: "tab-1",
    focused: true,
    agent_status: "idle",
    revision: 1,
  };
}


describe("TerminalView connection-lost signaling", () => {
  it("signals herdr-web:terminal-connection-lost when the socket closes unexpectedly", async () => {
    const drafts = createCommandDraftStore();
    await renderTerminalView(testPane("terminal-lost"), drafts);
    const renderer = terminalRenderers[0];
    if (!renderer) {
      throw new Error("Expected the terminal renderer");
    }
    await act(async () => {
      renderer.completeMount();
      await Promise.resolve();
    });
    const socket = FakeWebSocket.instances.at(-1);
    if (!socket) {
      throw new Error("Expected a terminal WebSocket");
    }
    await act(async () => {
      socket.open();
      await vi.advanceTimersByTimeAsync(600);
    });
    const lostEvents: Event[] = [];
    const listener = (event: Event) => lostEvents.push(event);
    window.addEventListener(TERMINAL_CONNECTION_LOST_EVENT, listener);
    await act(async () => {
      socket.close();
      await vi.advanceTimersByTimeAsync(50);
    });
    window.removeEventListener(TERMINAL_CONNECTION_LOST_EVENT, listener);
    expect(lostEvents).toHaveLength(1);
  });
});

describe("TerminalView context menu capture", () => {
  async function mountMenu(rightClickPassthrough = false) {
    const onContextMenu = vi.fn();
    const onActivate = vi.fn();
    const drafts = createCommandDraftStore();
    const pane = testPane("terminal-menu");
    const root = await renderTerminalView(pane, drafts, { onContextMenu, onActivate, rightClickPassthrough });
    const renderer = terminalRenderers[0]!;
    await act(async () => renderer.completeMount());
    const socket = FakeWebSocket.instances.at(-1)!;
    await act(async () => socket.open());
    return { onContextMenu, onActivate, renderer, socket, root, drafts, pane };
  }

  function mouse(input: HTMLElement, type: string, init: MouseEventInit = {}) {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 2, clientX: 91, clientY: 72, ...init });
    input.dispatchEvent(event);
    return event;
  }

  it("pastes middle-click clipboard text once and intercepts native mouse input", async () => {
    const readText = vi.fn().mockResolvedValue("one\ntwo");
    vi.stubGlobal("navigator", { clipboard: { readText } });
    const { renderer, onContextMenu, onActivate } = await mountMenu();
    await act(async () => {
      for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "auxclick"]) {
        expect(mouse(renderer.input, type, { button: 1 }).defaultPrevented).toBe(true);
      }
    });
    expect(readText).toHaveBeenCalledOnce();
    expect(renderer.paste).toHaveBeenCalledExactlyOnceWith("one\ntwo");
    expect(onActivate).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(renderer.input);
    expect(renderer.childEvents).not.toHaveBeenCalled();
    expect(onContextMenu).not.toHaveBeenCalled();
  });

  it("does not paste after the target terminal is replaced while clipboard access is pending", async () => {
    let resolveRead!: (text: string) => void;
    vi.stubGlobal("navigator", { clipboard: { readText: () => new Promise<string>(resolve => { resolveRead = resolve; }) } });
    const { renderer, root, drafts } = await mountMenu();
    await act(async () => { mouse(renderer.input, "mousedown", { button: 1 }); });
    await renderPane(root, testPane("replacement"), drafts);
    await act(async () => resolveRead("do not send"));
    expect(renderer.paste).not.toHaveBeenCalled();
    expect(terminalRenderers.at(-1)!.paste).not.toHaveBeenCalled();
  });

  it("reports denied clipboard access without sending input", async () => {
    vi.stubGlobal("navigator", { clipboard: { readText: vi.fn().mockRejectedValue(new Error("denied")) } });
    const { renderer } = await mountMenu();
    await act(async () => { mouse(renderer.input, "mousedown", { button: 1 }); });
    expect(renderer.paste).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Clipboard unavailable");
  });

  it("blocks right mouse and pointer input before native child capture, preserves focus target and connection", async () => {
    const { onContextMenu, renderer, socket, root, drafts, pane } = await mountMenu();
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "contextmenu"]) {
      expect(mouse(renderer.input, type).defaultPrevented).toBe(true);
    }
    expect(renderer.childEvents).not.toHaveBeenCalled();
    expect(onContextMenu).toHaveBeenCalledExactlyOnceWith(91, 72);
    expect(document.activeElement).toBe(renderer.input);
    await renderPane(root, pane, drafts, { onContextMenu: vi.fn(), rightClickPassthrough: true });
    expect(terminalRenderers).toEqual([renderer]);
    expect(FakeWebSocket.instances).toEqual([socket]);
    expect(socket.sent.filter((frame) => JSON.parse(frame).type === "input")).toEqual([]);
  });

  it("opens the Herdr menu in passthrough mode when no pane app tracks the mouse", async () => {
    const { renderer, onContextMenu } = await mountMenu(true);
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "contextmenu"]) {
      expect(mouse(renderer.input, type).defaultPrevented).toBe(true);
    }
    expect(renderer.childEvents).not.toHaveBeenCalled();
    expect(onContextMenu).toHaveBeenCalledExactlyOnceWith(91, 72);
  });

  it("opens Shift right-click even without a browser contextmenu event and does not open twice", async () => {
    const { renderer, onContextMenu } = await mountMenu(true);
    for (const type of ["pointerdown", "mousedown", "contextmenu", "pointerup", "mouseup"]) {
      expect(mouse(renderer.input, type, { shiftKey: true }).defaultPrevented).toBe(true);
    }
    expect(renderer.childEvents).not.toHaveBeenCalled();
    expect(onContextMenu).toHaveBeenCalledExactlyOnceWith(91, 72);
  });

  it("copies the selection on right-click instead of opening the menu", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const { renderer, onContextMenu } = await mountMenu();
    renderer.clearSelection.mockClear();
    renderer.selection = "build output\n";
    await act(async () => {
      for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "contextmenu"]) {
        expect(mouse(renderer.input, type).defaultPrevented).toBe(true);
      }
    });
    expect(writeText).toHaveBeenCalledExactlyOnceWith("build output");
    expect(renderer.clearSelection).toHaveBeenCalledOnce();
    expect(renderer.childEvents).not.toHaveBeenCalled();
    expect(onContextMenu).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Copied selection");
  });

  it("keeps the selection and opens the menu on Shift right-click even with a selection", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const { renderer, onContextMenu } = await mountMenu();
    renderer.clearSelection.mockClear();
    renderer.selection = "keep me";
    await act(async () => {
      for (const type of ["pointerdown", "mousedown", "contextmenu", "pointerup", "mouseup"]) {
        expect(mouse(renderer.input, type, { shiftKey: true }).defaultPrevented).toBe(true);
      }
    });
    expect(writeText).not.toHaveBeenCalled();
    expect(renderer.clearSelection).not.toHaveBeenCalled();
    expect(onContextMenu).toHaveBeenCalledExactlyOnceWith(91, 72);
  });

  it("copies the selection on right-click in passthrough mode without forwarding the click", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const { renderer, onContextMenu } = await mountMenu(true);
    renderer.clearSelection.mockClear();
    renderer.selection = "copy through";
    await act(async () => {
      for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "contextmenu"]) {
        expect(mouse(renderer.input, type).defaultPrevented).toBe(true);
      }
    });
    expect(writeText).toHaveBeenCalledExactlyOnceWith("copy through");
    expect(renderer.clearSelection).toHaveBeenCalledOnce();
    expect(renderer.childEvents).not.toHaveBeenCalled();
    expect(onContextMenu).not.toHaveBeenCalled();
  });

  it("keeps the selection when the right-click clipboard copy fails", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
    const { renderer, onContextMenu } = await mountMenu();
    renderer.clearSelection.mockClear();
    renderer.selection = "still selected";
    await act(async () => {
      mouse(renderer.input, "pointerdown");
      mouse(renderer.input, "contextmenu");
    });
    expect(renderer.clearSelection).not.toHaveBeenCalled();
    expect(renderer.childEvents).not.toHaveBeenCalled();
    expect(onContextMenu).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Copy failed");
  });

  it.each([{ key: "ContextMenu" }, { key: "F10", shiftKey: true }])("captures keyboard menu shortcut $key in passthrough mode", async (shortcut) => {
    const { renderer, onContextMenu } = await mountMenu(true);
    for (const type of ["keydown", "keyup"]) {
      const event = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...shortcut });
      renderer.input.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    }
    expect(renderer.childEvents).not.toHaveBeenCalled();
    expect(onContextMenu).toHaveBeenCalledTimes(1);
  });

  it("consumes F10 release even when Shift was released first", async () => {
    const { renderer, onContextMenu } = await mountMenu(true);
    renderer.input.dispatchEvent(new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true }));
    const release = new KeyboardEvent("keyup", { key: "F10", bubbles: true, cancelable: true });
    renderer.input.dispatchEvent(release);
    expect(release.defaultPrevented).toBe(true);
    expect(renderer.childEvents).not.toHaveBeenCalled();
    expect(onContextMenu).toHaveBeenCalledTimes(1);
  });

  it("preserves left clicks, normal keys and editable controls outside the terminal host", async () => {
    const { renderer, onContextMenu } = await mountMenu();
    expect(mouse(renderer.input, "mousedown", { button: 0 }).defaultPrevented).toBe(false);
    renderer.input.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    expect(renderer.childEvents).toHaveBeenCalledTimes(2);
    const fileInput = document.querySelector<HTMLInputElement>(".terminal-file-input")!;
    expect(mouse(fileInput, "contextmenu").defaultPrevented).toBe(false);
    expect(onContextMenu).not.toHaveBeenCalled();
  });

  it("leaves touch context menus to the existing mobile selection behavior", async () => {
    const { renderer, onContextMenu } = await mountMenu();
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
    Object.defineProperty(event, "pointerType", { value: "touch" });
    renderer.input.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(renderer.childEvents).toHaveBeenCalledTimes(1);
    expect(onContextMenu).not.toHaveBeenCalled();
  });

  // Panes whose app tracks the mouse (agent TUIs, TTT) keep the Herdr
  // right-click gestures unless the pane opted into passthrough (seeded for
  // TTT panes at launch; the explicit menu toggle still wins).
  it("opens the Herdr menu on right-click while the pane app tracks the mouse", async () => {
    const { renderer, onContextMenu } = await mountMenu();
    renderer.setMouseCapture(true);
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "contextmenu"]) {
      expect(mouse(renderer.input, type).defaultPrevented).toBe(true);
    }
    expect(renderer.childEvents).not.toHaveBeenCalled();
    expect(onContextMenu).toHaveBeenCalledExactlyOnceWith(91, 72);
  });

  it("copies the selection on right-click while the pane app tracks the mouse", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const { renderer, onContextMenu } = await mountMenu();
    renderer.setMouseCapture(true);
    renderer.clearSelection.mockClear();
    renderer.selection = "tracked output";
    await act(async () => {
      for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "contextmenu"]) {
        expect(mouse(renderer.input, type).defaultPrevented).toBe(true);
      }
    });
    expect(writeText).toHaveBeenCalledExactlyOnceWith("tracked output");
    expect(renderer.clearSelection).toHaveBeenCalledOnce();
    expect(renderer.childEvents).not.toHaveBeenCalled();
    expect(onContextMenu).not.toHaveBeenCalled();
  });

  it("pastes middle-click clipboard while the pane app tracks the mouse", async () => {
    const readText = vi.fn().mockResolvedValue("middle text");
    vi.stubGlobal("navigator", { clipboard: { readText } });
    const { renderer } = await mountMenu();
    renderer.setMouseCapture(true);
    await act(async () => {
      for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "auxclick"]) {
        expect(mouse(renderer.input, type, { button: 1 }).defaultPrevented).toBe(true);
      }
    });
    expect(readText).toHaveBeenCalledOnce();
    expect(renderer.paste).toHaveBeenCalledExactlyOnceWith("middle text");
    expect(renderer.childEvents).not.toHaveBeenCalled();
  });

  it("forwards right and middle clicks to the tracked pane app in passthrough mode", async () => {
    const readText = vi.fn();
    vi.stubGlobal("navigator", { clipboard: { readText } });
    const { renderer, onContextMenu } = await mountMenu(true);
    renderer.setMouseCapture(true);
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
      expect(mouse(renderer.input, type).defaultPrevented).toBe(false);
    }
    expect(mouse(renderer.input, "contextmenu").defaultPrevented).toBe(true);
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "auxclick"]) {
      expect(mouse(renderer.input, type, { button: 1 }).defaultPrevented).toBe(false);
    }
    expect(renderer.childEvents).toHaveBeenCalledTimes(8);
    expect(onContextMenu).not.toHaveBeenCalled();
    expect(readText).not.toHaveBeenCalled();
    expect(renderer.paste).not.toHaveBeenCalled();
  });

  it("leaves the renderer mouse-passthrough gate off for normal panes", async () => {
    const { renderer } = await mountMenu();
    expect(renderer.mousePassthrough).toBe(false);
  });

  it("turns the renderer mouse-passthrough gate on for opted-in panes", async () => {
    const { renderer } = await mountMenu(true);
    expect(renderer.mousePassthrough).toBe(true);
  });

  it("seeds the renderer mouse-passthrough gate from mouse_mode frames", async () => {
    const { renderer, socket } = await mountMenu(true);
    renderer.mousePassthrough = false;
    await act(async () => {
      socket.dispatchEvent(new MessageEvent("message", { data: '{"type":"mouse_mode","enabled":true}' }));
    });
    expect(renderer.mouseCapture).toBe(true);
    expect(renderer.mousePassthrough).toBe(true);
  });

  it("keeps the whole gesture owned by the pane app when Shift appears mid-gesture", async () => {
    const readText = vi.fn();
    vi.stubGlobal("navigator", { clipboard: { readText } });
    const { renderer, onContextMenu } = await mountMenu(true);
    renderer.setMouseCapture(true);
    await act(async () => {
      // Right press starts in the pane app's hands...
      expect(mouse(renderer.input, "pointerdown").defaultPrevented).toBe(false);
      // ...Shift appears before release: the release and context menu stay consumed,
      // the Herdr menu must not pop over the app's gesture.
      expect(mouse(renderer.input, "pointerup", { shiftKey: true }).defaultPrevented).toBe(true);
      expect(mouse(renderer.input, "contextmenu", { shiftKey: true }).defaultPrevented).toBe(true);
      // Same for a middle-click gesture whose release loses Shift.
      expect(mouse(renderer.input, "pointerdown", { button: 1 }).defaultPrevented).toBe(false);
      expect(mouse(renderer.input, "mouseup", { button: 1, shiftKey: true }).defaultPrevented).toBe(true);
    });
    expect(onContextMenu).not.toHaveBeenCalled();
    expect(readText).not.toHaveBeenCalled();
    expect(renderer.paste).not.toHaveBeenCalled();
  });

  it("releases a stale pane-app gesture latch on the next press", async () => {
    const readText = vi.fn().mockResolvedValue("later paste");
    vi.stubGlobal("navigator", { clipboard: { readText } });
    const { renderer } = await mountMenu(true);
    renderer.setMouseCapture(true);
    await act(async () => {
      expect(mouse(renderer.input, "pointerdown").defaultPrevented).toBe(false);
    });
    renderer.setMouseCapture(false);
    await act(async () => {
      expect(mouse(renderer.input, "mousedown", { button: 1 }).defaultPrevented).toBe(true);
    });
    expect(readText).toHaveBeenCalledExactlyOnceWith();
    expect(renderer.paste).toHaveBeenCalledExactlyOnceWith("later paste");
  });

  function insertKey(input: HTMLElement, type: string, init: KeyboardEventInit = {}) {
    const event = new KeyboardEvent(type, {
      key: "Insert",
      bubbles: true,
      cancelable: true,
      shiftKey: true,
      ...init,
    });
    input.dispatchEvent(event);
    return event;
  }

  it("pastes on Shift+Insert without leaking the key to the pane app", async () => {
    const readText = vi.fn().mockResolvedValue("insert paste");
    vi.stubGlobal("navigator", { clipboard: { readText } });
    const { renderer } = await mountMenu();
    renderer.setMouseCapture(true);
    await act(async () => {
      expect(insertKey(renderer.input, "keydown").defaultPrevented).toBe(true);
      expect(insertKey(renderer.input, "keyup").defaultPrevented).toBe(true);
    });
    expect(readText).toHaveBeenCalledOnce();
    expect(renderer.paste).toHaveBeenCalledExactlyOnceWith("insert paste");
    expect(renderer.childEvents).not.toHaveBeenCalled();
  });

  it("intercepts but does not repeat-paste on held Shift+Insert", async () => {
    const readText = vi.fn().mockResolvedValue("once");
    vi.stubGlobal("navigator", { clipboard: { readText } });
    const { renderer } = await mountMenu();
    await act(async () => {
      expect(insertKey(renderer.input, "keydown").defaultPrevented).toBe(true);
      expect(insertKey(renderer.input, "keydown", { repeat: true }).defaultPrevented).toBe(true);
    });
    expect(readText).toHaveBeenCalledOnce();
    expect(renderer.paste).toHaveBeenCalledExactlyOnceWith("once");
  });

  it("consumes the Insert release even when Shift was released first", async () => {
    const readText = vi.fn().mockResolvedValue("insert paste");
    vi.stubGlobal("navigator", { clipboard: { readText } });
    const { renderer } = await mountMenu();
    await act(async () => {
      expect(insertKey(renderer.input, "keydown").defaultPrevented).toBe(true);
      expect(insertKey(renderer.input, "keyup", { shiftKey: false }).defaultPrevented).toBe(true);
    });
    expect(readText).toHaveBeenCalledOnce();
    expect(renderer.paste).toHaveBeenCalledExactlyOnceWith("insert paste");
    expect(renderer.childEvents).not.toHaveBeenCalled();
  });

  it("ignores Shift+Insert variants so they keep flowing to the pane app", async () => {
    const readText = vi.fn();
    vi.stubGlobal("navigator", { clipboard: { readText } });
    const { renderer } = await mountMenu();
    await act(async () => {
      expect(insertKey(renderer.input, "keydown", { ctrlKey: true }).defaultPrevented).toBe(false);
      expect(insertKey(renderer.input, "keydown", { altKey: true }).defaultPrevented).toBe(false);
      expect(insertKey(renderer.input, "keydown", { metaKey: true }).defaultPrevented).toBe(false);
      expect(insertKey(renderer.input, "keydown", { key: "Delete" }).defaultPrevented).toBe(false);
    });
    expect(readText).not.toHaveBeenCalled();
    expect(renderer.paste).not.toHaveBeenCalled();
    expect(renderer.childEvents).toHaveBeenCalledTimes(4);
  });
});

describe("TerminalView uploads gating", () => {
  it("disables the upload button when uploads are not supported", async () => {
    const drafts = createCommandDraftStore();
    await renderTerminalView(testPane("terminal-uploads-off"), drafts, {
      mobileControls: false,
      uploadsEnabled: false,
    });
    const button = document.querySelector(
      'button[aria-label="Upload file"]',
    ) as HTMLButtonElement | null;
    expect(button).not.toBeNull();
    expect(button?.disabled).toBe(true);
  });

  it("keeps the upload button enabled by default", async () => {
    const drafts = createCommandDraftStore();
    await renderTerminalView(testPane("terminal-uploads-on"), drafts, {
      mobileControls: false,
    });
    const button = document.querySelector(
      'button[aria-label="Upload file"]',
    ) as HTMLButtonElement | null;
    expect(button).not.toBeNull();
    expect(button?.disabled).toBe(false);
  });
});

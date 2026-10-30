/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import {
  disableGhosttySelectionClipboardWrites,
  handleTerminalCustomKeyEvent,
  installMouseDragReporting,
  installTerminalInteractionRendering,
  normalizeWheelLines,
  renderGhosttyTerminalFrame,
  refreshTerminalFontRendering,
  shouldUseEventDrivenTerminalRendering,
  suspendGhosttyIdleRenderLoop,
} from "./terminalRenderer";

describe("normalizeWheelLines", () => {
  const pixelWheel = (deltaY: number) => ({ deltaY, deltaMode: 0 });

  it("accumulates sub-line pixel deltas until they cross a whole line", () => {
    let remainder = 0;
    for (let i = 0; i < 3; i += 1) {
      const result = normalizeWheelLines(pixelWheel(4), 24, 1, remainder);
      expect(result.lines).toBe(0);
      remainder = result.remainder;
    }
    expect(normalizeWheelLines(pixelWheel(4), 24, 1, remainder)).toEqual({
      lines: 1,
      remainder: 0,
    });
  });

  it("scrolls whole lines immediately and keeps the fractional remainder", () => {
    expect(normalizeWheelLines(pixelWheel(40), 24, 1, 0)).toEqual({
      lines: 2,
      remainder: 0.5,
    });
  });

  it("carries the remainder across events in both directions", () => {
    const first = normalizeWheelLines(pixelWheel(-40), 24, 1, 0);
    expect(first).toEqual({ lines: -2, remainder: -0.5 });
    expect(normalizeWheelLines(pixelWheel(-8), 24, 1, first.remainder)).toEqual({
      lines: -1,
      remainder: 0,
    });
  });

  it("keeps page and line delta modes on the same accumulation path", () => {
    expect(normalizeWheelLines({ deltaY: 0.5, deltaMode: 1 }, 24, 1, 0)).toEqual({
      lines: 0,
      remainder: 0.5,
    });
    expect(normalizeWheelLines({ deltaY: 1, deltaMode: 2 }, 24, 1, 0)).toEqual({
      lines: 24,
      remainder: 0,
    });
  });
});

describe("terminal event-driven rendering", () => {
  it("redraws idle selections and scrolling and removes the hooks on disposal", () => {
    const originalRequestRender = vi.fn();
    const selectionManager = {
      requestRender: originalRequestRender,
      getSelectionCoords: vi.fn(),
      getDirtySelectionRows: vi.fn(),
    };
    let onScroll: (() => void) | undefined;
    const dispose = vi.fn();
    const terminal = {
      selectionManager,
      onScroll: (callback: () => void) => {
        onScroll = callback;
        return { dispose };
      },
    } as never;
    const redraw = vi.fn();
    const cleanup = installTerminalInteractionRendering(terminal, redraw);
    selectionManager.requestRender();
    onScroll?.();
    expect(redraw).toHaveBeenCalledTimes(2);
    expect(originalRequestRender).not.toHaveBeenCalled();
    cleanup();
    expect(dispose).toHaveBeenCalledOnce();
    expect(selectionManager.requestRender).toBe(originalRequestRender);
  });

  it("only enables the idle-loop workaround for a non-blinking Windows terminal", () => {
    expect(shouldUseEventDrivenTerminalRendering(false, "Win32")).toBe(true);
    expect(shouldUseEventDrivenTerminalRendering(true, "Win32")).toBe(false);
    expect(shouldUseEventDrivenTerminalRendering(false, "MacIntel")).toBe(false);
    expect(shouldUseEventDrivenTerminalRendering(false, "Linux armv8l")).toBe(false);
  });

  it("cancels ghostty-web's pending idle frame", () => {
    const cancelFrame = vi.fn();
    const terminal = { animationFrameId: 42 } as never;

    expect(suspendGhosttyIdleRenderLoop(terminal, cancelFrame)).toBe(true);
    expect(cancelFrame).toHaveBeenCalledWith(42);
    expect(terminal).not.toHaveProperty("animationFrameId");
    expect(suspendGhosttyIdleRenderLoop(terminal, cancelFrame)).toBe(false);
  });

  it("renders the current viewport with ghostty's scrollbar state", () => {
    const renderer = { render: vi.fn() };
    const wasmTerm = {};
    const terminal = {
      renderer,
      wasmTerm,
      viewportY: 8,
      scrollbarOpacity: 0.4,
    } as never;

    expect(renderGhosttyTerminalFrame(terminal)).toBe(true);
    expect(renderer.render).toHaveBeenCalledWith(wasmTerm, false, 8, terminal, 0.4);
  });
});

describe("terminal mouse drag reporting", () => {
  it("ends a normal drag: drag listeners removed from the document and up reported", () => {
    const container = document.createElement("div");
    const state = dragForwarding();
    const cleanup = installMouseDragReporting(container, state.forwarding);
    const removeSpy = vi.spyOn(document, "removeEventListener");

    container.dispatchEvent(new MouseEvent("mousedown", { button: 0, cancelable: true }));
    document.dispatchEvent(new MouseEvent("mouseup", { button: 0 }));

    expect(state.sent).toEqual([
      { kind: "down", button: "left" },
      { kind: "up", button: "left" },
    ]);
    expect(removeSpy).toHaveBeenCalledWith("mousemove", expect.any(Function), true);
    expect(removeSpy).toHaveBeenCalledWith("mouseup", expect.any(Function), true);
    removeSpy.mockRestore();
    cleanup();
  });

  it("removes the drag listeners when mouse capture was reset mid-drag", () => {
    const container = document.createElement("div");
    const state = dragForwarding();
    const cleanup = installMouseDragReporting(container, state.forwarding);

    container.dispatchEvent(new MouseEvent("mousedown", { button: 0, cancelable: true }));
    // setMouseCapture(false) mid-drag resets the drag state without ending the drag.
    state.forwarding.setDragButton(null);
    const removeSpy = vi.spyOn(document, "removeEventListener");
    document.dispatchEvent(new MouseEvent("mouseup", { button: 0 }));

    expect(removeSpy).toHaveBeenCalledWith("mousemove", expect.any(Function), true);
    expect(removeSpy).toHaveBeenCalledWith("mouseup", expect.any(Function), true);
    removeSpy.mockRestore();
    cleanup();
  });

  it("does not report phantom moves after capture is re-enabled following an interrupted drag", () => {
    const container = document.createElement("div");
    const state = dragForwarding();
    const cleanup = installMouseDragReporting(container, state.forwarding);

    container.dispatchEvent(new MouseEvent("mousedown", { button: 0, cancelable: true }));
    state.forwarding.setDragButton(null);
    document.dispatchEvent(new MouseEvent("mouseup", { button: 0 }));
    // Capture comes back later, without a new drag: plain document moves must stay silent.
    document.dispatchEvent(new MouseEvent("mousemove", { button: 0 }));

    expect(state.sent).toEqual([{ kind: "down", button: "left" }]);
    cleanup();
  });

  it("starts a clean new drag after an interrupted one", () => {
    const container = document.createElement("div");
    const state = dragForwarding();
    const cleanup = installMouseDragReporting(container, state.forwarding);

    container.dispatchEvent(new MouseEvent("mousedown", { button: 0, cancelable: true }));
    state.forwarding.setDragButton(null);
    document.dispatchEvent(new MouseEvent("mouseup", { button: 0 }));

    container.dispatchEvent(new MouseEvent("mousedown", { button: 0, cancelable: true }));
    document.dispatchEvent(new MouseEvent("mousemove", { button: 0 }));
    document.dispatchEvent(new MouseEvent("mouseup", { button: 0 }));

    expect(state.sent).toEqual([
      { kind: "down", button: "left" },
      { kind: "down", button: "left" },
      { kind: "drag", button: "left" },
      { kind: "up", button: "left" },
    ]);
    cleanup();
  });
});

function dragForwarding() {
  let dragButton: number | null = null;
  const sent: Array<{ kind: string; button: string | null }> = [];
  const forwarding = {
    appMouseActive: () => true,
    isCurrentTerminal: () => true,
    focusTextInput: vi.fn(),
    sendMouse: (kind: string, button: string | null) => {
      sent.push({ kind, button });
    },
    dragButton: () => dragButton,
    setDragButton: (button: number | null) => {
      dragButton = button;
    },
  };
  return { forwarding, sent };
}

describe("terminal renderer font refresh", () => {
  it("forces the current viewport to redraw when font settings are unchanged", () => {
    const calls: string[] = [];
    const wasmTerm = {};
    const renderer = {
      remeasureFont: vi.fn(() => calls.push("remeasure")),
      render: vi.fn(() => calls.push("render")),
    };
    const terminal = {
      options: {
        fontFamily: "same font",
        fontSize: 14,
      },
      renderer,
      viewportY: 7,
      wasmTerm,
    } as unknown as Parameters<typeof refreshTerminalFontRendering>[0];
    const fit = vi.fn(() => {
      calls.push("fit");
      return { cols: 120, rows: 40 };
    });

    expect(refreshTerminalFontRendering(terminal, "same font", 14, fit)).toEqual({
      cols: 120,
      rows: 40,
    });
    expect(terminal.options.fontFamily).toBe("same font");
    expect(terminal.options.fontSize).toBe(14);
    expect(renderer.render).toHaveBeenCalledWith(wasmTerm, true, 7, terminal, 0);
    expect(calls).toEqual(["remeasure", "fit", "render"]);
  });
});

describe("terminal selection copy shortcuts", () => {
  it("consumes Windows/Linux Ctrl+C when canonical terminal selection text exists", () => {
    const terminal = terminalInput("selected terminal text");

    expect(dispatchCtrlC(keyEvent({ ctrlKey: true }), terminal, "Win32")).toBe(true);
    expect(terminal.getSelection).toHaveBeenCalledOnce();
    expect(terminal.input).not.toHaveBeenCalled();
  });

  it("delegates Windows/Linux Ctrl+C to Ghostty for PTY ^C when selection is empty", () => {
    const terminal = terminalInput("");

    expect(dispatchCtrlC(keyEvent({ ctrlKey: true }), terminal, "Linux x86_64")).toBe(false);
    expect(terminal.input).toHaveBeenCalledOnce();
    expect(terminal.input).toHaveBeenCalledWith("\x03", true);
  });

  it("consumes macOS Cmd+C when canonical terminal selection text exists", () => {
    const terminal = terminalInput("selected terminal text");

    expect(dispatchCtrlC(keyEvent({ metaKey: true }), terminal, "MacIntel")).toBe(true);
    expect(terminal.input).not.toHaveBeenCalled();
  });

  it("delegates macOS Ctrl+C to Ghostty for PTY interrupt even with a selection", () => {
    const terminal = terminalInput("selected terminal text");

    expect(dispatchCtrlC(keyEvent({ ctrlKey: true }), terminal, "MacIntel")).toBe(false);
    expect(terminal.input).toHaveBeenCalledOnce();
    expect(terminal.input).toHaveBeenCalledWith("\x03", true);
  });
});

describe("terminal selection clipboard suppression", () => {
  it("replaces the ghostty selection clipboard write with a no-op and restores it on cleanup", () => {
    const originalCopy = vi.fn();
    const selectionManager = {
      getSelectionCoords: vi.fn(),
      getDirtySelectionRows: vi.fn(() => new Set<number>()),
      requestRender: vi.fn(),
      copyToClipboard: originalCopy,
    };
    const terminal = { selectionManager } as never;

    const cleanup = disableGhosttySelectionClipboardWrites(terminal);

    expect(selectionManager.copyToClipboard).not.toBe(originalCopy);
    selectionManager.copyToClipboard?.("copied text");
    expect(originalCopy).not.toHaveBeenCalled();

    cleanup();
    expect(selectionManager.copyToClipboard).toBe(originalCopy);
  });

  it("leaves terminals without a usable selection manager untouched", () => {
    const cleanup = disableGhosttySelectionClipboardWrites({} as never);

    expect(() => cleanup()).not.toThrow();
  });

  it("ignores selection managers that do not expose copyToClipboard", () => {
    const selectionManager = {
      getSelectionCoords: vi.fn(),
      getDirtySelectionRows: vi.fn(() => new Set<number>()),
      requestRender: vi.fn(),
    };
    const terminal = { selectionManager } as never;

    const cleanup = disableGhosttySelectionClipboardWrites(terminal);

    expect((selectionManager as { copyToClipboard?: unknown }).copyToClipboard)
      .toBeUndefined();
    expect(() => cleanup()).not.toThrow();
  });
});

function keyEvent(overrides: Partial<KeyboardEvent> = {}) {
  return {
    altKey: false,
    code: "KeyC",
    ctrlKey: false,
    isComposing: false,
    key: "c",
    keyCode: 67,
    metaKey: false,
    shiftKey: false,
    stopImmediatePropagation: vi.fn(),
    stopPropagation: vi.fn(),
    ...overrides,
  } as unknown as KeyboardEvent;
}

function terminalInput(selection: string) {
  return {
    getSelection: vi.fn(() => selection),
    input: vi.fn(),
  };
}

function dispatchCtrlC(
  event: KeyboardEvent,
  terminal: ReturnType<typeof terminalInput>,
  platform: string,
) {
  const handled = handleTerminalCustomKeyEvent(event, terminal, platform);
  if (!handled) {
    // This is Ghostty's existing default Ctrl+C encoding path.
    terminal.input("\x03", true);
  }
  return handled;
}

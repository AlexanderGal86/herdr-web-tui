/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppearance, useAppearanceRefit } from "./appearance";

type ProbeProps = {
  rendererReady: unknown;
  resizeTerminal: (mode?: "fit" | "refresh") => void;
};

function Probe({ rendererReady, resizeTerminal }: ProbeProps) {
  useAppearanceRefit({ rendererReady, resizeTerminal });
  return null;
}

describe("useAppearanceRefit", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  const resizeTerminal = vi.fn();

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    resizeTerminal.mockClear();
    setAppearance("tui");
  });

  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    root = null;
    setAppearance("tui");
  });

  it("does not refit on mount", () => {
    act(() => {
      root = createRoot(container);
      root.render(
        <Probe rendererReady={{ terminalId: 1 }} resizeTerminal={resizeTerminal} />,
      );
    });
    expect(resizeTerminal).not.toHaveBeenCalled();
  });

  it("refits once when the theme changes with a ready renderer", () => {
    act(() => {
      root = createRoot(container);
      root.render(
        <Probe rendererReady={{ terminalId: 1 }} resizeTerminal={resizeTerminal} />,
      );
    });
    resizeTerminal.mockClear();
    act(() => {
      setAppearance("web");
    });
    expect(resizeTerminal).toHaveBeenCalledWith("refresh");
    expect(resizeTerminal).toHaveBeenCalledTimes(1);
  });

  it("skips the refit when no renderer is ready", () => {
    act(() => {
      root = createRoot(container);
      root.render(
        <Probe rendererReady={null} resizeTerminal={resizeTerminal} />,
      );
    });
    resizeTerminal.mockClear();
    act(() => {
      setAppearance("web");
    });
    expect(resizeTerminal).not.toHaveBeenCalled();
  });
});

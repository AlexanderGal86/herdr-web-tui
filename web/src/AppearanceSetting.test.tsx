/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const STORAGE_KEY = "herdr.web.appearance.v1";
let container: HTMLDivElement;
let root: Root;
let stopAppearance: (() => void) | undefined;

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.localStorage.clear();
  delete document.documentElement.dataset.appearance;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  stopAppearance?.();
  stopAppearance = undefined;
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("AppearanceSetting", () => {
  it.each([null, "tui", "unexpected"])("applies TUI before rendering for stored %s", async (saved) => {
    if (saved !== null) window.localStorage.setItem(STORAGE_KEY, saved);
    await initialize();
    expect(document.documentElement.dataset.appearance).toBe("tui");
    expect(container.children).toHaveLength(0);
  });

  it("applies saved Web before rendering", async () => {
    window.localStorage.setItem(STORAGE_KEY, "web");
    await initialize();
    expect(document.documentElement.dataset.appearance).toBe("web");
  });

  it("switches the page and every mounted selector without replacing display preferences", async () => {
    window.localStorage.setItem("herdr.mobileWeb.displayPrefs.v2", '{"sidebarWidth":310}');
    const { AppearanceSetting } = await import("./AppearanceSetting");
    await act(async () => root.render(<><AppearanceSetting /><AppearanceSetting /></>));
    const [tui, web, secondTui, secondWeb] = buttons();

    await act(async () => web.click());
    expect(document.documentElement.dataset.appearance).toBe("web");
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("web");
    expect(web.getAttribute("aria-pressed")).toBe("true");
    expect(secondWeb.getAttribute("aria-pressed")).toBe("true");

    await act(async () => tui.click());
    expect(document.documentElement.dataset.appearance).toBe("tui");
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("tui");
    expect(secondTui.getAttribute("aria-pressed")).toBe("true");
    expect(secondWeb.getAttribute("aria-pressed")).toBe("false");
    expect(window.localStorage.getItem("herdr.mobileWeb.displayPrefs.v2"))
      .toBe('{"sidebarWidth":310}');
  });

  it("restores Web after a reload", async () => {
    window.localStorage.setItem(STORAGE_KEY, "web");
    const { AppearanceSetting } = await import("./AppearanceSetting");
    await act(async () => root.render(<AppearanceSetting />));
    expect(buttons()[1].getAttribute("aria-pressed")).toBe("true");
  });

  it("keeps switching when local storage is inaccessible", async () => {
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new DOMException("Storage blocked", "SecurityError");
    });
    await initialize();
    const { AppearanceSetting } = await import("./AppearanceSetting");
    await act(async () => root.render(<AppearanceSetting />));
    expect(buttons()[0].getAttribute("aria-pressed")).toBe("true");
    await act(async () => buttons()[1].click());
    expect(buttons()[1].getAttribute("aria-pressed")).toBe("true");
    expect(document.documentElement.dataset.appearance).toBe("web");
  });

  it("synchronizes the mounted selector and page with changes from another tab", async () => {
    await initialize();
    const { AppearanceSetting } = await import("./AppearanceSetting");
    await act(async () => root.render(<AppearanceSetting />));

    await act(async () => storageEvent(STORAGE_KEY, "web"));
    expect(document.documentElement.dataset.appearance).toBe("web");
    expect(buttons()[1].getAttribute("aria-pressed")).toBe("true");
    await act(async () => storageEvent(STORAGE_KEY, "tui"));
    expect(document.documentElement.dataset.appearance).toBe("tui");
    expect(buttons()[0].getAttribute("aria-pressed")).toBe("true");
  });

  it("synchronizes the page when the settings selector is unmounted", async () => {
    await initialize();
    storageEvent(STORAGE_KEY, "web");
    expect(document.documentElement.dataset.appearance).toBe("web");
  });

  it.each([STORAGE_KEY, null])("resets to TUI when storage is cleared with key %s", async (key) => {
    window.localStorage.setItem(STORAGE_KEY, "web");
    await initialize();
    const { AppearanceSetting } = await import("./AppearanceSetting");
    await act(async () => root.render(<AppearanceSetting />));

    await act(async () => storageEvent(key, null));
    expect(document.documentElement.dataset.appearance).toBe("tui");
    expect(buttons()[0].getAttribute("aria-pressed")).toBe("true");
  });

  it("ignores other preferences and session storage events", async () => {
    window.localStorage.setItem(STORAGE_KEY, "web");
    await initialize();
    storageEvent("herdr.mobileWeb.displayPrefs.v2", null);
    storageEvent(STORAGE_KEY, "tui", window.sessionStorage);
    expect(document.documentElement.dataset.appearance).toBe("web");
  });
});

async function initialize() {
  const { initializeAppearance } = await import("./appearance");
  stopAppearance = initializeAppearance();
}

function storageEvent(key: string | null, newValue: string | null, storageArea = window.localStorage) {
  window.dispatchEvent(new StorageEvent("storage", { key, newValue, storageArea }));
}

function buttons() {
  return Array.from(container.querySelectorAll<HTMLButtonElement>("button"));
}

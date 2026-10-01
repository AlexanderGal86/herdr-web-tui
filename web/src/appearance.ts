import { useEffect, useRef, useSyncExternalStore } from "react";

export type Appearance = "tui" | "web";
export const APPEARANCE_STORAGE_KEY = "herdr.web.appearance.v1";

let appearance = readStoredAppearance();
const listeners = new Set<() => void>();

function readStoredAppearance(): Appearance {
  try {
    return window.localStorage.getItem(APPEARANCE_STORAGE_KEY) === "web" ? "web" : "tui";
  } catch {
    return "tui";
  }
}

export function readAppearance(): Appearance {
  return appearance;
}

export function initializeAppearance() {
  applyAppearance(readStoredAppearance());
  const onStorage = (event: StorageEvent) => {
    if (event.key !== APPEARANCE_STORAGE_KEY && event.key !== null) return;
    try {
      if (event.storageArea && event.storageArea !== window.localStorage) return;
    } catch {
      return;
    }
    applyAppearance(event.key !== null && event.newValue === "web" ? "web" : "tui");
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}

function applyAppearance(value: Appearance) {
  appearance = value;
  document.documentElement.dataset.appearance = value;
  listeners.forEach((listener) => listener());
}

export function setAppearance(value: Appearance) {
  applyAppearance(value);
  try {
    window.localStorage.setItem(APPEARANCE_STORAGE_KEY, value);
  } catch {
    // Keep the preference for this session when browser storage is unavailable.
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useAppearance(): Appearance {
  return useSyncExternalStore(subscribe, readAppearance);
}

export function defaultDisplayScope(fallback: "space" | "all"): "space" | "all" {
  return readAppearance() === "tui" ? "all" : fallback;
}

export function defaultSidebarWidth(fallback: number): number {
  return readAppearance() === "tui" ? 240 : fallback;
}

// WHY: a theme change remeasures the live renderer without
// detaching the session; under tui it also waits for the mono
// webfont before the second measure.
export function useAppearanceRefit(options: {
  rendererReady: unknown;
  resizeTerminal: (mode?: "fit" | "refresh") => void;
}) {
  const appearance = useAppearance();
  const previousAppearanceRef = useRef(appearance);
  useEffect(() => {
    if (previousAppearanceRef.current === appearance) return;
    previousAppearanceRef.current = appearance;
    if (!options.rendererReady) return;
    let cancelled = false;
    options.resizeTerminal("refresh");
    if (appearance === "tui") {
      void document.fonts
        ?.load('13px "Herdr Mono"')
        .then(() => {
          if (!cancelled) options.resizeTerminal("refresh");
        })
        .catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
  }, [appearance, options.rendererReady, options.resizeTerminal]);
}

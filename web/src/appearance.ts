import { useSyncExternalStore } from "react";

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

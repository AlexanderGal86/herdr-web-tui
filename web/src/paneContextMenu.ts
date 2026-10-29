import type { MenuItem } from "./overlays";
import type { PaneInfo } from "./types";

export type TerminalMenuTarget = { id: string; terminalId: string; connectionKey: string };
type PaneMenuOptions = {
  pane?: PaneInfo;
  source?: PaneInfo;
  commands: readonly string[];
  zoomed: boolean;
  passthrough: boolean;
  extras: readonly MenuItem[];
};

export function terminalPreferenceKey(bridgeId: string, connectionKey: string, terminalId: string): string {
  return JSON.stringify([bridgeId, connectionKey, terminalId]);
}

export const RIGHT_CLICK_PASSTHROUGH_STORAGE_KEY = "herdr.web.rightClickPassthrough.v1";

export function parseRightClickPassthroughKeys(raw: string | null): ReadonlySet<string> {
  try {
    const parsed = raw === null ? undefined : JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((entry): entry is string => typeof entry === "string"));
  } catch {
    return new Set();
  }
}

export function seedRightClickPassthrough(
  current: ReadonlySet<string>,
  panes: readonly PaneInfo[],
  bridgeId: string,
  connectionKey: string,
  paneId: string | undefined,
): ReadonlySet<string> {
  const terminalId = paneId === undefined ? undefined : panes.find(pane => pane.pane_id === paneId)?.terminal_id;
  if (!terminalId) return current;
  const key = terminalPreferenceKey(bridgeId, connectionKey, terminalId);
  if (current.has(key)) return current;
  return new Set(current).add(key);
}

export function terminalMenuTarget(target: TerminalMenuTarget, connectionKey: string, panes: readonly PaneInfo[]): PaneInfo | undefined {
  if (target.connectionKey !== connectionKey) return undefined;
  return panes.find(pane => pane.pane_id === target.id && pane.terminal_id === target.terminalId);
}

export function terminalPaneMenuItems({ pane, source, commands, zoomed, passthrough, extras }: PaneMenuOptions): MenuItem[] {
  if (!pane) return [];
  const items: MenuItem[] = [];
  if (commands.includes("pane.rename")) {
    items.push({ key: "rename", label: "Rename pane" });
    if (pane.label != null) items.push({ key: "clear_name", label: "Clear pane name" });
  }
  if (commands.includes("pane.swap") && source && source.pane_id !== pane.pane_id &&
      source.workspace_id === pane.workspace_id && source.tab_id === pane.tab_id) {
    items.push({ key: "swap", label: "Swap with focused pane" });
  }
  if (commands.includes("pane.split")) {
    items.push({ key: "split_right", label: "Split right" }, { key: "split_down", label: "Split down" });
  }
  items.push({ key: "paste", label: "Paste" });
  if (commands.includes("pane.zoom") && zoomed) {
    items.push({ key: "zoom", label: "Restore split layout" });
  }
  items.push({ key: "toggle_right_click", label: passthrough ? "Use Herdr right-click menu" : "Send right-clicks to pane" });
  items.push(...extras.filter(item => item.key !== "rename" && item.key !== "close"));
  if (commands.includes("pane.close")) items.push({ key: "close", label: "Close pane", danger: true });
  return items;
}

import { describe, expect, it } from "vitest";
import { terminalPaneMenuItems, terminalPreferenceKey, terminalMenuTarget, seedRightClickPassthrough, parseRightClickPassthroughKeys } from "./paneContextMenu";
import type { PaneInfo } from "./types";

const pane: PaneInfo = {
  pane_id: "pane-clicked", terminal_id: "terminal-2", workspace_id: "space-1",
  tab_id: "tab-1", focused: false, label: "Review", agent_status: "idle", revision: 1,
};
const source = { ...pane, pane_id: "pane-active", terminal_id: "terminal-1", focused: true };
const commands = ["pane.rename", "pane.split", "pane.zoom", "pane.swap", "pane.close"];

describe("terminal pane context menu", () => {
  it("offers native actions for the clicked pane and preserves web extras", () => {
    const items = terminalPaneMenuItems({ pane, source, commands, zoomed: false, passthrough: false,
      extras: [{ key: "pin", label: "Pin pane" }, { key: "rename", label: "Rename" }, { key: "close", label: "Close pane" }],
    });
    expect(items.map(item => item.label)).toEqual([
      "Rename pane", "Clear pane name", "Swap with focused pane", "Split right", "Split down", "Paste",
      "Send right-clicks to pane", "Pin pane", "Close pane",
    ]);
    expect(items.map(item => item.key)).not.toContain("zoom");
  });
  it("does not offer unsupported operations, nonexistent targets or cross-tab swaps", () => {
    expect(terminalPaneMenuItems({ pane: undefined, commands, zoomed: false, passthrough: false, extras: [] })).toEqual([]);
    const items = terminalPaneMenuItems({ pane: { ...pane, label: undefined }, source: { ...source, tab_id: "other-tab" },
      commands: ["pane.rename", "pane.swap"], zoomed: false, passthrough: false, extras: [] });
    expect(items.map(item => item.key)).toEqual(["rename", "paste", "toggle_right_click"]);
  });
  it("offers recovery from zoom and right-click passthrough without swapping with itself", () => {
    const items = terminalPaneMenuItems({ pane, source: pane, commands, zoomed: true, passthrough: true, extras: [] });
    expect(items.map(item => item.label)).toContain("Restore split layout");
    expect(items.map(item => item.label)).toContain("Use Herdr right-click menu");
    expect(items.map(item => item.key)).not.toContain("swap");
  });
  it("rejects stale terminal and connection identities instead of retargeting a reused pane id", () => {
    const target = { id: pane.pane_id, terminalId: pane.terminal_id, connectionKey: "connection-1" };
    expect(terminalMenuTarget(target, "connection-1", [pane])).toBe(pane);
    expect(terminalMenuTarget(target, "connection-2", [pane])).toBeUndefined();
    expect(terminalMenuTarget(target, "connection-1", [{ ...pane, terminal_id: "replacement" }])).toBeUndefined();
    expect(terminalMenuTarget(target, "connection-1", [])).toBeUndefined();
  });
  it("scopes passthrough to bridge, connection and terminal without key collisions", () => {
    const key = terminalPreferenceKey("bridge", "connection", "terminal");
    expect(key).not.toBe(terminalPreferenceKey("other", "connection", "terminal"));
    expect(key).not.toBe(terminalPreferenceKey("bridge", "reconnected", "terminal"));
    expect(key).not.toBe(terminalPreferenceKey("bridge", "connection", "new-terminal"));
    expect(terminalPreferenceKey("a:b", "c", "d")).not.toBe(terminalPreferenceKey("a", "b:c", "d"));
  });
  it("seeds the right-click passthrough preference for a launched pane's terminal", () => {
    expect(seedRightClickPassthrough(new Set(), [pane], "bridge", "connection-1", "pane-clicked"))
      .toEqual(new Set([terminalPreferenceKey("bridge", "connection-1", "terminal-2")]));
    const seeded = new Set([terminalPreferenceKey("bridge", "connection-1", "terminal-2")]);
    expect(seedRightClickPassthrough(seeded, [pane], "bridge", "connection-1", "pane-clicked")).toBe(seeded);
    expect(seedRightClickPassthrough(new Set(), [], "bridge", "connection-1", "pane-clicked")).toEqual(new Set());
    expect(seedRightClickPassthrough(new Set(), [pane], "bridge", "connection-1", "pane-missing")).toEqual(new Set());
    expect(seedRightClickPassthrough(new Set(), [pane], "bridge", "connection-1", undefined)).toEqual(new Set());
  });
  it("parses persisted passthrough keys defensively", () => {
    expect(parseRightClickPassthroughKeys(null)).toEqual(new Set());
    expect(parseRightClickPassthroughKeys("")).toEqual(new Set());
    expect(parseRightClickPassthroughKeys("[\"bridge|connection|terminal\"]"))
      .toEqual(new Set(["bridge|connection|terminal"]));
    expect(parseRightClickPassthroughKeys("[1, null, \"ok\"]")).toEqual(new Set(["ok"]));
    expect(parseRightClickPassthroughKeys("{\"not\":\"an array\"}")).toEqual(new Set());
    expect(parseRightClickPassthroughKeys("not json")).toEqual(new Set());
  });
});

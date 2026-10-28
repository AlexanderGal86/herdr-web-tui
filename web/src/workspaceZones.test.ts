import { describe, expect, it } from "vitest";
import {
  bridgeZone,
  parseWorkspaceZonesMode,
  splitByZone,
  zoneHeadersVisible,
} from "./workspaceZones";

describe("parseWorkspaceZonesMode", () => {
  it("accepts known modes and rejects everything else", () => {
    expect(parseWorkspaceZonesMode("local_remote")).toBe("local_remote");
    expect(parseWorkspaceZonesMode("off")).toBe("off");
    expect(parseWorkspaceZonesMode("zones")).toBeNull();
    expect(parseWorkspaceZonesMode(null)).toBeNull();
    expect(parseWorkspaceZonesMode(1)).toBeNull();
  });
});

describe("bridgeZone", () => {
  it("treats the serving bridge as local and configured backends as remote", () => {
    expect(bridgeZone("same-origin", "same-origin", "same-origin")).toBe("local");
    expect(bridgeZone("b2", "configured", "same-origin")).toBe("remote");
  });
});

describe("zoneHeadersVisible", () => {
  it("requires the split mode and at least one remote entry", () => {
    expect(zoneHeadersVisible("local_remote", 0)).toBe(false);
    expect(zoneHeadersVisible("local_remote", 2)).toBe(true);
    expect(zoneHeadersVisible("off", 2)).toBe(false);
  });
});

describe("splitByZone", () => {
  it("partitions entries and preserves relative order inside each zone", () => {
    const split = splitByZone(
      [
        { id: "w6", zone: "local" },
        { id: "w8", zone: "remote" },
        { id: "w9", zone: "local" },
        { id: "wA", zone: "remote" },
      ] as const,
      (item) => item.zone,
    );
    expect(split.local.map((item) => item.id)).toEqual(["w6", "w9"]);
    expect(split.remote.map((item) => item.id)).toEqual(["w8", "wA"]);
  });
});

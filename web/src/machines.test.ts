import { describe, expect, it, vi } from "vitest";
import {
  buildMachineGroups,
  buildMachineHttpPath,
  buildMachineWsUrl,
  entriesForGroup,
  machineGroupStatus,
  machineRuntimeId,
  machinesGroupingActive,
  parseMachinesList,
  type MachineGroupView,
} from "./machines";

const farm = { id: "0123456789abcdef0123456789abcdef", label: "farm", kind: "ssh" } as const;
const localMachine = { id: "local", label: "Local", kind: "local" } as const;

describe("parseMachinesList", () => {
  it("parses a server machines list and keeps server order", () => {
    const parsed = parseMachinesList({
      version: 1,
      machines: [localMachine, farm],
    });
    expect(parsed).toEqual({
      version: 1,
      machines: [localMachine, farm],
    });
  });

  it("drops malformed entries and rejects non-object payloads", () => {
    expect(
      parseMachinesList({
        version: 1,
        machines: [
          localMachine,
          { id: "x", label: "no kind" },
          { id: 5, label: "bad id", kind: "ssh" },
          { id: "y", label: "bad kind", kind: "vm" },
          "junk",
        ],
      }),
    ).toEqual({ version: 1, machines: [localMachine] });
    expect(parseMachinesList(null)).toBeNull();
    expect(parseMachinesList("nope")).toBeNull();
    expect(parseMachinesList({ version: 1 })).toBeNull();
  });
});

describe("machine runtime ids", () => {
  it("round-trips machine ids through runtime ids", () => {
    const runtimeId = machineRuntimeId("0123456789abcdef0123456789abcdef");
    expect(runtimeId).toBe("machine:0123456789abcdef0123456789abcdef");
    expect(runtimeId).not.toBe("0123456789abcdef0123456789abcdef");
  });
});

describe("machine URL builders", () => {
  it("rewrites api paths under the machine route prefix", () => {
    expect(buildMachineHttpPath("abc", "/api/snapshot")).toBe("/api/machines/abc/snapshot");
    expect(buildMachineHttpPath("abc", "/api/command")).toBe("/api/machines/abc/command");
    const query = new URLSearchParams({ terminal_id: "t1" });
    expect(buildMachineHttpPath("abc", "/api/snapshot", query)).toBe(
      "/api/machines/abc/snapshot?terminal_id=t1",
    );
  });

  it("rewrites websocket paths under the machine route prefix", () => {
    expect(buildMachineHttpPath("abc", "/ws/events")).toBe("/api/machines/abc/ws/events");
  });

  it("builds absolute machine websocket URLs on the serving origin", () => {
    vi.stubGlobal("location", { protocol: "https:", host: "bridge.local:8787" });
    expect(buildMachineWsUrl("abc", "/ws/terminal")).toBe(
      "wss://bridge.local:8787/api/machines/abc/ws/terminal",
    );
    vi.unstubAllGlobals();
  });
});

describe("machinesGroupingActive", () => {
  it("requires the split mode and at least one ssh machine", () => {
    expect(machinesGroupingActive("local_remote", [localMachine, farm])).toBe(true);
    expect(machinesGroupingActive("local_remote", [localMachine])).toBe(false);
    expect(machinesGroupingActive("off", [localMachine, farm])).toBe(false);
    expect(machinesGroupingActive("local_remote", [])).toBe(false);
  });
});

function view(overrides: Partial<MachineGroupView> & { runtimeId: string }): MachineGroupView {
  return {
    mode: "machine",
    label: "farm",
    loadState: "ready",
    capabilityState: "ready",
    hasSnapshot: true,
    ...overrides,
  };
}

describe("machineGroupStatus", () => {
  it("maps view state to a connection status", () => {
    expect(machineGroupStatus(view({ runtimeId: "machine:farm" }))).toBe("connected");
    expect(
      machineGroupStatus(view({ runtimeId: "machine:farm", hasSnapshot: false })),
    ).toBe("connecting");
    expect(
      machineGroupStatus(view({ runtimeId: "machine:farm", loadState: "loading" })),
    ).toBe("connected");
    expect(
      machineGroupStatus(
        view({ runtimeId: "machine:farm", loadState: "loading", hasSnapshot: false }),
      ),
    ).toBe("connecting");
    expect(
      machineGroupStatus(view({ runtimeId: "machine:farm", capabilityState: "error" })),
    ).toBe("unavailable");
    expect(
      machineGroupStatus(view({ runtimeId: "machine:farm", loadState: "error" })),
    ).toBe("unavailable");
  });
});

describe("buildMachineGroups", () => {
  const sameOrigin = view({
    runtimeId: "same-origin",
    mode: "same-origin",
    label: "Same origin",
  });
  const farmView = view({ runtimeId: "machine:0123456789abcdef0123456789abcdef" });
  const backend = view({
    runtimeId: "b2",
    mode: "configured",
    label: "Attic bridge",
    hasSnapshot: true,
  });

  it("shows Local and farm groups with one serving bridge", () => {
    const groups = buildMachineGroups([localMachine, farm], [sameOrigin, farmView], "same-origin");
    expect(groups.map((group) => group.label)).toEqual(["Local", "farm"]);
    expect(groups.map((group) => group.machineId)).toEqual(["local", farm.id]);
    expect(groups.map((group) => group.status)).toEqual(["connected", "connected"]);
    expect(groups.map((group) => group.runtimeId)).toEqual(["same-origin", farmView.runtimeId]);
  });

  it("keeps configured bridge backends as separate groups after machines", () => {
    const groups = buildMachineGroups(
      [localMachine, farm],
      [sameOrigin, farmView, backend],
      "same-origin",
    );
    expect(groups.map((group) => group.label)).toEqual(["Local", "farm", "Attic bridge"]);
    expect(groups[2].machineId).toBeNull();
    expect(groups[2].runtimeId).toBe("b2");
  });

  it("drops stale machine runtimes that the server list no longer has", () => {
    const stale = view({ runtimeId: "machine:deadbeefdeadbeefdeadbeefdeadbeef" });
    const groups = buildMachineGroups([localMachine, farm], [sameOrigin, farmView, stale], "same-origin");
    expect(groups.map((group) => group.runtimeId)).toEqual(["same-origin", farmView.runtimeId]);
  });

  it("reports unavailable machines without falling back to local data", () => {
    const down = view({
      runtimeId: "machine:0123456789abcdef0123456789abcdef",
      capabilityState: "error",
      hasSnapshot: false,
      loadState: "ready",
    });
    const groups = buildMachineGroups([localMachine, farm], [sameOrigin, down], "same-origin");
    expect(groups.map((group) => [group.label, group.status])).toEqual([
      ["Local", "connected"],
      ["farm", "unavailable"],
    ]);
  });
});

describe("entriesForGroup", () => {
  it("scopes workspace entries to the group machine so colliding ids never mix", () => {
    const entries = [
      { entryId: "local:w1", runtimeId: "same-origin", workspaceId: "w1" },
      { entryId: "farm:w1", runtimeId: "machine:0123456789abcdef0123456789abcdef", workspaceId: "w1" },
      { entryId: "farm:w2", runtimeId: "machine:0123456789abcdef0123456789abcdef", workspaceId: "w2" },
    ];
    const groups = buildMachineGroups(
      [localMachine, farm],
      [
        view({ runtimeId: "same-origin", mode: "same-origin" }),
        view({ runtimeId: "machine:0123456789abcdef0123456789abcdef" }),
      ],
      "same-origin",
    );
    expect(entriesForGroup(entries, groups[0]).map((entry) => entry.entryId)).toEqual(["local:w1"]);
    expect(entriesForGroup(entries, groups[1]).map((entry) => entry.entryId)).toEqual([
      "farm:w1",
      "farm:w2",
    ]);
  });
});

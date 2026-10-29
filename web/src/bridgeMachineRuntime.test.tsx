/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BridgeProvider,
  SAME_ORIGIN_BRIDGE_ID,
  useBridge,
  type BridgeManager,
} from "./bridge";
import { resolveInitialSelectedBridgeId } from "./App";

const STORE_KEY = "herdrWeb.bridgeBackends.v2";
const FARM_MACHINE_RUNTIME_ID = "machine:farm1";

const SSH_CAPABLE_CAPABILITIES = {
  commands: [],
  machines: { version: 1 },
  web_compat: 1,
};

let latestManager: BridgeManager | null = null;

function BridgeManagerCapture() {
  latestManager = useBridge();
  return null;
}

let container: HTMLDivElement;
let root: Root;

function jsonResponse(payload: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
  };
}

function requestPath(input: RequestInfo | URL): string {
  const raw = typeof input === "string" ? input : input.toString();
  try {
    return new URL(raw, window.location.href).pathname;
  } catch {
    return raw;
  }
}

function installBridgeFetch({
  capabilities,
  machinesList,
}: {
  capabilities: unknown;
  machinesList?: unknown;
}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const path = requestPath(input);
    if (path === "/api/machines") {
      return jsonResponse(machinesList ?? { machines: [] });
    }
    if (path === "/api/machines/farm1/api/capabilities") {
      return jsonResponse({ commands: [] });
    }
    return jsonResponse(capabilities);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function renderProvider() {
  await act(async () => {
    root.render(
      <BridgeProvider>
        <BridgeManagerCapture />
      </BridgeProvider>,
    );
  });
}

async function waitForManager(predicate: (manager: BridgeManager) => boolean) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    });
    if (latestManager && predicate(latestManager)) {
      return latestManager;
    }
  }
  throw new Error("bridge manager condition was not reached");
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.localStorage.clear();
  latestManager = null;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("BridgeProvider machine runtime selection", () => {
  it("keeps a selected SSH machine runtime selectable through App normalization", async () => {
    installBridgeFetch({
      capabilities: SSH_CAPABLE_CAPABILITIES,
      machinesList: {
        machines: [
          { id: "local", label: "Local", kind: "local" },
          { id: "farm1", label: "farm1", kind: "ssh" },
        ],
      },
    });
    await renderProvider();

    const manager = await waitForManager(
      (current) =>
        current.machinesLoaded &&
        current.availableRuntimes.some((runtime) => runtime.id === FARM_MACHINE_RUNTIME_ID),
    );

    expect(manager.enabledRuntimes.map((runtime) => runtime.id)).toEqual([
      SAME_ORIGIN_BRIDGE_ID,
      FARM_MACHINE_RUNTIME_ID,
    ]);

    await act(async () => {
      manager.setLastSelectedBridgeId(FARM_MACHINE_RUNTIME_ID);
    });
    // The provider re-renders a new manager object; read the fresh snapshot.
    const updated = latestManager;
    if (!updated) {
      throw new Error("bridge manager snapshot missing after selection");
    }
    expect(updated.lastSelectedBridgeId).toBe(FARM_MACHINE_RUNTIME_ID);

    // Mirror the App storeLoaded normalization effect (App.tsx 1644-1652).
    const normalized = resolveInitialSelectedBridgeId(
      FARM_MACHINE_RUNTIME_ID,
      updated.enabledBridgeIds,
      updated.lastSelectedBridgeId,
    );
    expect(normalized).toBe(FARM_MACHINE_RUNTIME_ID);

    // Consistency: public enabled ids must cover every enabled runtime.
    expect(updated.enabledBridgeIds).toContain(FARM_MACHINE_RUNTIME_ID);
    expect(updated.enabledBridgeIds).toHaveLength(2);

    // Machine selection stays session-only; nothing leaks into the store.
    const rawStore = window.localStorage.getItem(STORE_KEY);
    expect(rawStore).not.toContain("machine:");
  });

  it("keeps legacy enabled ids when the bridge serves no machines", async () => {
    installBridgeFetch({ capabilities: { commands: [] } });
    await renderProvider();

    const manager = await waitForManager(
      (current) =>
        current.storeLoaded &&
        current.enabledRuntimes.some(
          (runtime) =>
            runtime.id === SAME_ORIGIN_BRIDGE_ID && runtime.capabilityState === "ready",
        ),
    );

    expect(manager.enabledBridgeIds).toEqual([SAME_ORIGIN_BRIDGE_ID]);
    expect(manager.enabledRuntimes.map((runtime) => runtime.id)).toEqual([SAME_ORIGIN_BRIDGE_ID]);
    expect(manager.enabledBridgeIds.some((id) => id.startsWith("machine:"))).toBe(false);
  });

  it("preserves persisted enabled order, appends machine ids, and skips non-SSH machines", async () => {
    window.localStorage.setItem(
      STORE_KEY,
      JSON.stringify({
        version: 2,
        enabledBridgeIds: ["cfg-b", "cfg-a", SAME_ORIGIN_BRIDGE_ID],
        lastSelectedBridgeId: "cfg-a",
        backends: [
          { id: "cfg-a", name: "A", baseUrl: "http://a.example" },
          { id: "cfg-b", name: "B", baseUrl: "http://b.example" },
        ],
      }),
    );
    installBridgeFetch({
      capabilities: SSH_CAPABLE_CAPABILITIES,
      machinesList: {
        machines: [
          { id: "local", label: "Local", kind: "local" },
          { id: "secondary", label: "Secondary", kind: "local" },
          { id: "farm1", label: "farm1", kind: "ssh" },
          { id: "broken", label: "Broken" },
        ],
      },
    });
    await renderProvider();

    const manager = await waitForManager(
      (current) =>
        current.machinesLoaded &&
        current.availableRuntimes.some((runtime) => runtime.id === FARM_MACHINE_RUNTIME_ID),
    );

    expect(manager.enabledBridgeIds).toEqual([
      "cfg-b",
      "cfg-a",
      SAME_ORIGIN_BRIDGE_ID,
      FARM_MACHINE_RUNTIME_ID,
    ]);
    expect(manager.enabledRuntimes.map((runtime) => runtime.id)).toEqual([
      SAME_ORIGIN_BRIDGE_ID,
      "cfg-a",
      "cfg-b",
      FARM_MACHINE_RUNTIME_ID,
    ]);
    expect(
      manager.enabledRuntimes.some(
        (runtime) => runtime.id === "machine:secondary" || runtime.id === "machine:broken",
      ),
    ).toBe(false);
  });

  it("registers a machine through the bridge route and refreshes the machine tree", async () => {
    const initialList = {
      version: 1,
      machines: [
        { id: "local", label: "Local", kind: "local" },
        { id: "farm1", label: "farm1", kind: "ssh" },
      ],
    };
    const addedList = {
      version: 1,
      machines: [
        { id: "local", label: "Local", kind: "local" },
        { id: "farm1", label: "farm1", kind: "ssh" },
        { id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", label: "gpu2", kind: "ssh" },
      ],
    };
    let machinesSeen = 0;
    const addBodies: unknown[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(input);
      if (path === "/api/machines/add") {
        addBodies.push(JSON.parse(String(init?.body)));
        return jsonResponse(addedList);
      }
      if (path === "/api/machines") {
        machinesSeen += 1;
        return jsonResponse(machinesSeen === 1 ? initialList : addedList);
      }
      if (path === "/api/machines/farm1/api/capabilities") {
        return jsonResponse({ commands: [] });
      }
      return jsonResponse(SSH_CAPABLE_CAPABILITIES);
    });
    vi.stubGlobal("fetch", fetchMock);
    await renderProvider();

    const manager = await waitForManager(
      (current) =>
        current.machinesLoaded &&
        current.availableRuntimes.some((runtime) => runtime.id === FARM_MACHINE_RUNTIME_ID),
    );

    await act(async () => {
      await manager.addMachine({ target: "root@10.0.0.250", label: "gpu2" });
    });

    expect(addBodies).toEqual([{ target: "root@10.0.0.250", label: "gpu2" }]);
    const addedRuntimeId = "machine:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const updated = await waitForManager((current) =>
      current.availableRuntimes.some((runtime) => runtime.id === addedRuntimeId),
    );
    expect(updated.enabledRuntimes.map((runtime) => runtime.id)).toContain(addedRuntimeId);
    expect(machinesSeen).toBeGreaterThanOrEqual(2);

    // Machine registration never touches browser-persisted store state.
    const rawStore = window.localStorage.getItem(STORE_KEY);
    expect(rawStore).not.toContain("aaaaaaaa");
  });

  it("surfaces the bridge's machine add error to the caller", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(input);
      if (path === "/api/machines/add") {
        void init;
        return {
          ok: false,
          status: 502,
          json: async () => ({ error: "machine add failed: ssh refused" }),
        };
      }
      if (path === "/api/machines") {
        return jsonResponse({ version: 1, machines: [] });
      }
      return jsonResponse(SSH_CAPABLE_CAPABILITIES);
    });
    vi.stubGlobal("fetch", fetchMock);
    await renderProvider();

    const manager = await waitForManager((current) => current.machinesLoaded);
    let failure: unknown = null;
    await act(async () => {
      failure = await manager.addMachine({ target: "root@10.0.0.250" }).then(
        () => null,
        (error: unknown) => error,
      );
    });

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("machine add failed: ssh refused");
  });

  it("disables a machine through the bridge route and refreshes the machine tree", async () => {
    const initialList = {
      version: 1,
      machines: [
        { id: "local", label: "Local", kind: "local" },
        { id: "farm1", label: "farm1", kind: "ssh" },
      ],
    };
    const disabledList = {
      version: 1,
      machines: [{ id: "local", label: "Local", kind: "local" }],
    };
    let machinesSeen = 0;
    const disableCalls: { path: string; body: unknown }[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestPath(input);
      if (path === "/api/machines/farm1/disable") {
        disableCalls.push({ path, body: init?.body });
        return jsonResponse(disabledList);
      }
      if (path === "/api/machines") {
        machinesSeen += 1;
        return jsonResponse(machinesSeen === 1 ? initialList : disabledList);
      }
      if (path === "/api/machines/farm1/api/capabilities") {
        return jsonResponse({ commands: [] });
      }
      return jsonResponse(SSH_CAPABLE_CAPABILITIES);
    });
    vi.stubGlobal("fetch", fetchMock);
    await renderProvider();

    const manager = await waitForManager(
      (current) =>
        current.machinesLoaded &&
        current.availableRuntimes.some((runtime) => runtime.id === FARM_MACHINE_RUNTIME_ID),
    );

    await act(async () => {
      await manager.disableMachine("farm1");
    });

    // Native route, no request body.
    expect(disableCalls).toEqual([{ path: "/api/machines/farm1/disable", body: undefined }]);
    const updated = await waitForManager(
      (current) =>
        current.machinesLoaded &&
        !current.availableRuntimes.some((runtime) => runtime.id === FARM_MACHINE_RUNTIME_ID),
    );
    expect(updated.machines.map((machine) => machine.id)).toEqual(["local"]);
    expect(machinesSeen).toBeGreaterThanOrEqual(2);
  });

  it("surfaces the bridge's machine disable error to the caller", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = requestPath(input);
      if (path === "/api/machines/farm1/disable") {
        return {
          ok: false,
          status: 503,
          json: async () => ({ error: "machine disable is unavailable: catalog relocated" }),
        };
      }
      if (path === "/api/machines") {
        return jsonResponse({ version: 1, machines: [] });
      }
      return jsonResponse(SSH_CAPABLE_CAPABILITIES);
    });
    vi.stubGlobal("fetch", fetchMock);
    await renderProvider();

    const manager = await waitForManager((current) => current.machinesLoaded);
    let failure: unknown = null;
    await act(async () => {
      failure = await manager.disableMachine("farm1").then(
        () => null,
        (error: unknown) => error,
      );
    });

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      "machine disable is unavailable: catalog relocated",
    );
  });
});

/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BridgeProvider,
  useBridge,
  type BridgeBackendProfile,
  type BridgeManager,
} from "./bridge";

let latestManager: BridgeManager | null = null;

function BridgeManagerCapture() {
  latestManager = useBridge();
  return null;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.localStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ commands: [] }),
    })),
  );
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

async function renderProvider() {
  await act(async () => {
    root.render(
      <BridgeProvider>
        <BridgeManagerCapture />
      </BridgeProvider>,
    );
  });
}

function managerOrFail(): BridgeManager {
  if (!latestManager) {
    throw new Error("bridge manager was not captured");
  }
  return latestManager;
}

function backendsWithUrl(manager: BridgeManager, baseUrl: string): BridgeBackendProfile[] {
  return manager.store.backends.filter((backend) => backend.baseUrl === baseUrl);
}

describe("BridgeProvider addBackend idempotency", () => {
  it("resolves same-tick duplicate adds to one backend profile", async () => {
    await renderProvider();
    const manager = managerOrFail();
    const adds: Array<Promise<BridgeBackendProfile>> = [];

    await act(async () => {
      adds.push(manager.addBackend({ name: "Alpha", baseUrl: "http://192.168.1.20:4000" }));
      adds.push(manager.addBackend({ name: "Beta", baseUrl: "192.168.1.20:4000" }));
    });
    const [first, second] = await Promise.all(adds);

    expect(second.id).toBe(first.id);
    expect(backendsWithUrl(managerOrFail(), "http://192.168.1.20:4000")).toHaveLength(1);
  });

  it("returns the saved profile when the URL was added earlier", async () => {
    await renderProvider();
    const manager = managerOrFail();

    let first: BridgeBackendProfile | undefined;
    await act(async () => {
      first = await manager.addBackend({ name: "Alpha", baseUrl: "http://192.168.1.20:4000" });
    });
    let second: BridgeBackendProfile | undefined;
    await act(async () => {
      second = await manager.addBackend({ name: "Beta", baseUrl: "http://192.168.1.20:4000" });
    });

    expect(second?.id).toBe(first?.id);
    expect(backendsWithUrl(managerOrFail(), "http://192.168.1.20:4000")).toHaveLength(1);
  });

  it("re-adds a URL freshly after its backend is deleted or renamed away", async () => {
    await renderProvider();

    let added: BridgeBackendProfile | undefined;
    await act(async () => {
      added = await managerOrFail().addBackend({ name: "Alpha", baseUrl: "http://192.168.1.20:4000" });
    });
    await act(async () => {
      await managerOrFail().updateBackend(added!.id, { name: "Alpha", baseUrl: "http://10.0.0.5:4000" });
    });
    let renamedBack: BridgeBackendProfile | undefined;
    await act(async () => {
      renamedBack = await managerOrFail().addBackend({ name: "Gamma", baseUrl: "http://192.168.1.20:4000" });
    });
    expect(renamedBack?.id).not.toBe(added!.id);
    expect(backendsWithUrl(managerOrFail(), "http://192.168.1.20:4000")).toHaveLength(1);

    await act(async () => {
      managerOrFail().deleteBackend(renamedBack!.id);
    });
    let reAdded: BridgeBackendProfile | undefined;
    await act(async () => {
      reAdded = await managerOrFail().addBackend({ name: "Delta", baseUrl: "http://192.168.1.20:4000" });
    });
    expect(reAdded?.id).not.toBe(renamedBack!.id);
    expect(backendsWithUrl(managerOrFail(), "http://192.168.1.20:4000")).toHaveLength(1);
  });
});

import { describe, expect, it, vi } from "vitest";
import { createPreviewStorage, createThemePreviewFixture } from "./themePreviewFixture";

const origin = "http://127.0.0.1:5173";

describe("theme preview isolation", () => {
  it("rejects unknown APIs and configured bridges without forwarding a request", async () => {
    const fixture = createThemePreviewFixture(origin);
    for (const url of ["/api/command", "/api/uploads", "/unexpected", "https://live.example/api/snapshot", "/bridge/api/snapshot"]) {
      const response = await fixture.fetch(url);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: expect.stringContaining("Theme preview") });
    }
  });

  it("serves sample sessions and keeps pane, tab, and workspace selection local", async () => {
    const fixture = createThemePreviewFixture(origin);
    const snapshot = await (await fixture.fetch("/api/snapshot")).json();
    expect(snapshot.workspaces.map((workspace: { label: string }) => workspace.label)).toEqual([
      "herdr", "web-dashboard", "data-pipeline",
    ]);
    expect(snapshot.panes.filter((pane: { agent?: string }) => pane.agent)).toHaveLength(4);
    expect(snapshot.selected_pane_id).toBe("preview-claude");
    const selected = await fixture.fetch("/api/selection", {
      method: "POST", body: JSON.stringify({ pane_id: "preview-opencode" }),
    });
    expect(selected.ok).toBe(true);
    const next = await (await fixture.fetch("/api/snapshot")).json();
    expect(next.selected_pane_id).toBe("preview-opencode");
    expect(next.workspaces[0].active_tab_id).toBe("preview-tab-opencode");
    expect((await fixture.fetch("/api/selection", {
      method: "POST", body: JSON.stringify({ pane_id: "live-pane" }),
    })).status).toBe(400);
    expect((await fixture.fetch("/api/command", {
      method: "POST", body: JSON.stringify({ method: "workspace.close", params: {} }),
    })).status).toBe(403);
    const capabilities = await (await fixture.fetch("/api/capabilities")).json();
    expect(capabilities.commands).toEqual(["workspace.focus", "tab.focus"]);
    for (const [method, params, selectedPane] of [
      ["workspace.focus", { workspace_id: "preview-pipeline" }, "preview-codex"],
      ["tab.focus", { tab_id: "preview-tab-herdr" }, "preview-claude"],
    ]) {
      expect((await fixture.fetch("/api/command", {
        method: "POST", body: JSON.stringify({ method, params }),
      })).ok).toBe(true);
      expect(await (await fixture.fetch("/api/snapshot")).json()).toMatchObject({ selected_pane_id: selectedPane });
    }
  });

  it("never reads or overwrites existing app preferences and persists its own values", () => {
    const values = new Map([["herdr.web.appearance.v1", "web"], ["herdrWeb.bridgeBackends.v2", "live bridge"]]);
    const backing = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };
    const preview = createPreviewStorage(backing);
    expect(preview.getItem("herdrWeb.bridgeBackends.v2")).toBeNull();
    expect(preview.getItem("herdr.web.appearance.v1")).toBeNull();
    preview.setItem("herdr.web.appearance.v1", "tui");
    expect(values.get("herdr.web.appearance.v1")).toBe("web");
    expect(createPreviewStorage(backing).getItem("herdr.web.appearance.v1")).toBe("tui");
    preview.clear();
    expect(values.get("herdrWeb.bridgeBackends.v2")).toBe("live bridge");
  });

  it("emits local binary terminal output, redraws on resize, and refuses input", async () => {
    const notice = vi.fn();
    const fixture = createThemePreviewFixture(origin, notice);
    const socket = new fixture.WebSocket("ws://127.0.0.1:5173/ws/terminal?terminal_id=preview-terminal-claude&cols=80&rows=24");
    const output: ArrayBuffer[] = [];
    socket.addEventListener("message", (event) => { output.push((event as MessageEvent).data); });
    await new Promise<void>((resolve) => socket.addEventListener("open", () => resolve()));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(socket.readyState).toBe(fixture.WebSocket.OPEN);
    expect(output[0]).toBeInstanceOf(ArrayBuffer);
    expect(new TextDecoder().decode(output[0])).toContain("Claude Code");
    socket.send(JSON.stringify({ type: "resize", cols: 100, rows: 30 }));
    expect(output).toHaveLength(2);
    socket.send(JSON.stringify({ type: "input", data: "rm -rf /\r" }));
    expect(notice).toHaveBeenCalledWith(expect.stringContaining("input is disabled"));
    expect(new TextDecoder().decode(output.at(-1))).toContain("input is disabled");
    socket.close();
    expect(socket.readyState).toBe(fixture.WebSocket.CLOSED);
    expect(() => new fixture.WebSocket("wss://live.example/ws/terminal?terminal_id=preview-terminal-claude"))
      .toThrow("Theme preview");
  });
});

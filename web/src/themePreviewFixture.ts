import type { AgentStatus, LayoutSnapshot, PaneInfo, Snapshot, TabInfo, WorkspaceInfo } from "./types";

// This module is only imported by theme-preview.html. Never import it from main.tsx.
const STORAGE_KEY = "herdr.theme-preview.storage.v1";
const INPUT_DISABLED = "Theme preview: terminal input is disabled; no command was sent.";

export function createPreviewStorage(backing: Pick<Storage, "getItem" | "setItem"> | null): Storage {
  const values = new Map<string, string>();
  try {
    const saved: unknown = JSON.parse(backing?.getItem(STORAGE_KEY) ?? "null");
    if (saved && typeof saved === "object" && !Array.isArray(saved)) {
      for (const [key, value] of Object.entries(saved)) {
        if (typeof value === "string") values.set(key, value);
      }
    }
  } catch { /* Storage restrictions only disable reload persistence. */ }
  const save = () => {
    try { backing?.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(values))); }
    catch { /* The in-memory preview still works. */ }
  };
  return {
    get length() { return values.size; },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(String(key)) ?? null,
    setItem(key, value) { values.set(String(key), String(value)); save(); },
    removeItem(key) { values.delete(String(key)); save(); },
    clear() { values.clear(); save(); },
  };
}

function sampleSnapshot(): Snapshot {
  const workspace = (id: string, number: number, label: string, activeTab: string, status: AgentStatus, paneCount = 1, tabCount = 1): WorkspaceInfo => ({
    workspace_id: id, number, label, focused: number === 1,
    pane_count: paneCount, tab_count: tabCount, active_tab_id: activeTab, agent_status: status,
  });
  const tab = (id: string, workspaceId: string, number: number, label: string, status: AgentStatus, paneCount = 1): TabInfo => ({
    tab_id: id, workspace_id: workspaceId, number, label, focused: id === "preview-tab-herdr",
    pane_count: paneCount, agent_status: status,
  });
  const pane = (id: string, workspaceId: string, tabId: string, agent: string | undefined, status: AgentStatus, cwd: string): PaneInfo => ({
    pane_id: `preview-${id}`, terminal_id: `preview-terminal-${id}`, workspace_id: workspaceId,
    tab_id: tabId, focused: id === "claude", agent, display_agent: agent,
    label: agent ?? "shell", agent_status: status, cwd, revision: 1,
  });
  const panes = [
    pane("claude", "preview-herdr", "preview-tab-herdr", "claude", "working", "~/code/herdr"),
    pane("shell", "preview-herdr", "preview-tab-herdr", undefined, "unknown", "~/code/herdr"),
    pane("opencode", "preview-herdr", "preview-tab-opencode", "opencode", "idle", "~/code/herdr"),
    pane("blocked", "preview-dashboard", "preview-tab-dashboard", "claude", "blocked", "~/code/web-dashboard"),
    pane("codex", "preview-pipeline", "preview-tab-pipeline", "codex", "done", "~/code/data-pipeline"),
  ];
  const tabs = [
    tab("preview-tab-opencode", "preview-herdr", 1, "opencode", "idle"),
    tab("preview-tab-herdr", "preview-herdr", 2, "herdr", "working", 2),
    tab("preview-tab-dashboard", "preview-dashboard", 1, "claude", "blocked"),
    tab("preview-tab-pipeline", "preview-pipeline", 1, "codex", "done"),
  ];
  const area = { x: 0, y: 0, width: 120, height: 40 };
  const layouts: LayoutSnapshot[] = tabs.map((item) => {
    const tabPanes = panes.filter((candidate) => candidate.tab_id === item.tab_id);
    return {
      workspace_id: item.workspace_id, tab_id: item.tab_id, zoomed: false,
      area, focused_pane_id: tabPanes[0].pane_id,
      panes: tabPanes.map((candidate, index) => ({
        pane_id: candidate.pane_id, focused: index === 0,
        rect: { x: index * 60, y: 0, width: tabPanes.length === 2 ? 60 : 120, height: 40 },
      })),
      splits: tabPanes.length === 2 ? [{ id: "preview-split", direction: "right", ratio: 0.5, rect: area }] : [],
    };
  });
  return {
    workspaces: [
      workspace("preview-herdr", 1, "herdr", "preview-tab-herdr", "working", 3, 2),
      workspace("preview-dashboard", 2, "web-dashboard", "preview-tab-dashboard", "blocked"),
      workspace("preview-pipeline", 3, "data-pipeline", "preview-tab-pipeline", "done"),
    ], tabs, panes, layouts, selected_pane_id: "preview-claude",
  };
}

export function createThemePreviewFixture(origin: string, onNotice: (message: string) => void = () => {}): {
  fetch: typeof fetch;
  WebSocket: typeof WebSocket;
} {
  const baseUrl = new URL(origin);
  const snapshot = sampleSnapshot();
  const sockets = new Set<PreviewWebSocket>();
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json" },
  });
  const denied = () => reply({ error: "Theme preview: this action is disabled; no live request was sent." }, 403);
  const selectPane = (paneId: unknown) => {
    const selected = snapshot.panes.find((item) => item.pane_id === paneId);
    if (!selected) return false;
    snapshot.selected_pane_id = selected.pane_id;
    for (const item of snapshot.workspaces) {
      item.focused = item.workspace_id === selected.workspace_id;
      if (item.focused) item.active_tab_id = selected.tab_id;
    }
    for (const item of snapshot.tabs) item.focused = item.tab_id === selected.tab_id;
    for (const item of snapshot.panes) {
      if (item.tab_id === selected.tab_id) item.focused = item.pane_id === selected.pane_id;
    }
    const layout = snapshot.layouts.find((item) => item.tab_id === selected.tab_id);
    if (layout) {
      layout.focused_pane_id = selected.pane_id;
      for (const item of layout.panes) item.focused = item.pane_id === selected.pane_id;
    }
    for (const socket of sockets) {
      if (socket.path === "/ws/ui-events") {
        socket.message(JSON.stringify({ type: "herdr_web.selection_changed", pane_id: selected.pane_id }));
      }
    }
    return true;
  };
  const previewFetch: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : null;
    const url = new URL(request?.url ?? String(input), baseUrl);
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    if (url.origin !== baseUrl.origin || url.username || url.password) return denied();
    if (method === "GET" && url.pathname === "/api/capabilities") {
      // Show the real pane menu; mutation requests below remain refused.
      return reply({ commands: ["workspace.focus", "tab.focus", "pane.rename", "pane.split", "pane.zoom", "pane.swap", "pane.close"], web_compat: 1, bridge_version: "theme-preview" });
    }
    if (method === "GET" && url.pathname === "/api/snapshot") return reply(snapshot);
    if (method === "POST" && ["/api/selection", "/api/command"].includes(url.pathname)) {
      let body: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(typeof init?.body === "string" ? init.body : await request?.text() ?? "{}");
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid request");
        body = parsed as Record<string, unknown>;
      } catch { return reply({ error: "Theme preview: invalid request." }, 400); }
      if (url.pathname === "/api/selection") {
        return selectPane(body.pane_id) ? reply({ selected_pane_id: snapshot.selected_pane_id })
          : reply({ error: "Theme preview: unknown sample pane." }, 400);
      }
      const params = body.params as Record<string, unknown> | undefined;
      let tabId = params?.tab_id;
      if (body.method === "workspace.focus") {
        tabId = snapshot.workspaces.find((item) => item.workspace_id === params?.workspace_id)?.active_tab_id;
      } else if (body.method !== "tab.focus") return denied();
      const candidates = snapshot.panes.filter((item) => item.tab_id === tabId);
      const selected = candidates.find((item) => item.focused) ?? candidates[0];
      return selected && selectPane(selected.pane_id) ? reply({ pane_id: selected.pane_id })
        : reply({ error: "Theme preview: unknown sample tab or workspace." }, 400);
    }
    return denied();
  };

  class PreviewWebSocket extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSING = 2;
    readonly CLOSED = 3;
    readonly url: string;
    readonly path: string;
    readyState = PreviewWebSocket.CONNECTING;
    binaryType: BinaryType = "arraybuffer";
    bufferedAmount = 0;
    extensions = "";
    protocol = "";
    private terminalId: string | null;
    private cols: number;
    private rows: number;

    constructor(input: string | URL) {
      super();
      const url = new URL(input, baseUrl);
      this.url = url.href;
      this.path = url.pathname;
      this.terminalId = url.searchParams.get("terminal_id");
      this.cols = dimension(url.searchParams.get("cols"), 80);
      this.rows = dimension(url.searchParams.get("rows"), 24);
      if (url.host !== baseUrl.host || url.protocol !== (baseUrl.protocol === "https:" ? "wss:" : "ws:") ||
          url.username || url.password ||
          !["/ws/terminal", "/ws/events", "/ws/ui-events", "/ws/activity"].includes(this.path) ||
          (this.path === "/ws/terminal" && !snapshot.panes.some((item) => item.terminal_id === this.terminalId))) {
        throw new Error("Theme preview: live and unknown WebSocket connections are disabled.");
      }
      sockets.add(this);
      queueMicrotask(() => {
        if (this.readyState !== PreviewWebSocket.CONNECTING) return;
        this.readyState = PreviewWebSocket.OPEN;
        this.dispatchEvent(new Event("open"));
        this.redraw();
      });
    }

    message(data: string | ArrayBuffer) {
      if (this.readyState === PreviewWebSocket.OPEN) this.dispatchEvent(new MessageEvent("message", { data }));
    }

    private redraw() {
      if (this.path === "/ws/terminal") {
        this.message(new TextEncoder().encode(terminalSample(this.terminalId, this.cols, this.rows)).buffer);
      }
    }

    send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
      if (this.readyState !== PreviewWebSocket.OPEN) throw new Error("Theme preview: socket is closed.");
      if (typeof data === "string") {
        try {
          const parsed = JSON.parse(data) as { type?: string; cols?: number; rows?: number };
          if (this.path === "/ws/terminal" && parsed.type === "resize") {
            this.cols = dimension(parsed.cols, this.cols);
            this.rows = dimension(parsed.rows, this.rows);
            this.redraw();
            return;
          }
        } catch { /* Non-JSON frames are refused below. */ }
      }
      onNotice(INPUT_DISABLED);
      this.message(new TextEncoder().encode(`\r\n\u001b[33m${INPUT_DISABLED}\u001b[0m\r\n`).buffer);
    }

    close() {
      if (this.readyState === PreviewWebSocket.CLOSED) return;
      this.readyState = PreviewWebSocket.CLOSED;
      sockets.delete(this);
      this.dispatchEvent(new Event("close"));
    }
  }

  return { fetch: previewFetch, WebSocket: PreviewWebSocket as unknown as typeof WebSocket };
}

function dimension(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.min(500, Math.floor(number)) : fallback;
}

function terminalSample(terminalId: string | null, cols: number, rows: number) {
  type Line = [color: number, text: string];
  const samples: Record<string, Line[]> = {
    "preview-terminal-claude": [
      [35, "✻ Claude Code"], [90, "  ~/code/herdr"], [37, ""],
      [37, "> Build a focused terminal workspace UI."], [37, ""],
      [37, "I'll refine the workspace list and split panes."],
      [37, "The active session should be easy to follow."], [37, ""],
      [32, "● Read  src/workspace.rs"], [90, "  Reviewed focus and pane layout state"], [37, ""],
      [32, "● Update  src/ui/sidebar.rs"], [90, "  Added status colors and active workspace edge"], [37, ""],
      [33, "✻ Building terminal UI…"], [90, "  Checking pane borders and keyboard focus"], [37, ""],
      [90, "  Sample output · visual review only"],
    ],
    "preview-terminal-shell": [
      [32, "~/code/herdr"], [37, "$ npm run dev"], [37, ""],
      [37, "> herdr-web dev"], [37, "> vite --host 127.0.0.1"], [37, ""],
      [32, "  VITE  ready in 148 ms"], [37, ""],
      [36, "  ➜  Local: http://127.0.0.1:5173/"],
      [90, "  ➜  Sample development server output"], [37, ""],
      [90, "16:24:08  [vite] page updated"], [90, "16:24:09  [vite] theme stylesheet updated"],
    ],
    "preview-terminal-opencode": [
      [36, "OpenCode"], [90, "~/code/herdr"], [37, ""],
      [37, "Workspace navigation review is ready."], [37, ""],
      [90, "Waiting for the next task."], [37, ""], [37, "> "],
    ],
    "preview-terminal-blocked": [
      [35, "✻ Claude Code"], [90, "~/code/web-dashboard"], [37, ""],
      [37, "The dashboard layout is ready for review."], [37, ""],
      [33, "! Waiting for a design decision"],
      [37, "Choose which charts belong on the overview."], [37, ""],
      [90, "Sample blocked session · no action required"],
    ],
    "preview-terminal-codex": [
      [36, "Codex"], [90, "~/code/data-pipeline"], [37, ""],
      [32, "✓ Pipeline validation complete"], [37, ""],
      [37, "Added input validation and clearer summaries."],
      [32, "12 checks passed"], [37, ""], [90, "Sample completed session"],
    ],
  };
  return "\u001b[?25l\u001b[2J\u001b[H" + (samples[terminalId ?? ""] ?? [])
    .slice(0, Math.max(1, rows - 1))
    .map(([color, text]) => `\u001b[${color}m ${text.slice(0, Math.max(1, cols - 2))}\u001b[0m`)
    .join("\r\n");
}

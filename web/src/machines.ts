/** Saved-machine helpers shared by the bridge provider and the sidebar. */

export type MachineKind = "local" | "ssh";

export type MachineInfo = {
  id: string;
  label: string;
  kind: MachineKind;
};

export type MachinesList = {
  version: number;
  machines: MachineInfo[];
};

export type MachineGroupStatus = "connected" | "connecting" | "unavailable";

/** Browser input for the bridge's native machine registration route. */
export type MachineAddInput = {
  target: string;
  label?: string;
  session?: string;
};

/**
 * The bridge advertises saved-machine discovery; the same capability covers
 * machine registration, so this gates the sidebar's add-machine affordance
 * even when no SSH machine exists yet.
 */
export function supportsMachines(
  capabilities: { machines?: { version: number } } | null | undefined,
): boolean {
  return capabilities?.machines?.version === 1;
}

export type MachineGroupView = {
  runtimeId: string;
  mode: string;
  label: string;
  loadState: string;
  capabilityState: string;
  hasSnapshot: boolean;
};

export type MachineGroup<T extends MachineGroupView = MachineGroupView> = {
  key: string;
  machineId: string | null;
  label: string;
  runtimeId: string;
  status: MachineGroupStatus;
  view: T;
};

export const LOCAL_MACHINE_ID = "local";
const MACHINE_KINDS: readonly MachineKind[] = ["local", "ssh"];

/**
 * Parses the bridge's saved-machine list. Malformed entries are dropped so a
 * partial server response can never invent a machine; a non-object payload
 * yields null so callers keep their previous (or empty) list.
 */
export function parseMachinesList(value: unknown): MachinesList | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const rawList = (value as { machines?: unknown }).machines;
  if (!Array.isArray(rawList)) {
    return null;
  }
  const machines: MachineInfo[] = [];
  for (const entry of rawList) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const { id, label, kind } = entry as Record<string, unknown>;
    if (typeof id !== "string" || !id || typeof label !== "string" || !label) {
      continue;
    }
    if (typeof kind !== "string" || !MACHINE_KINDS.includes(kind as MachineKind)) {
      continue;
    }
    machines.push({ id, label, kind: kind as MachineKind });
  }
  return { version: 1, machines };
}

/** Runtime id for a saved machine; distinct from every backend bridge id. */
export function machineRuntimeId(machineId: string): string {
  return `machine:${machineId}`;
}

/**
 * Rewrites a bridge endpoint path onto the machine-scoped route prefix on the
 * serving bridge: `/api/x` → `/api/machines/{id}/x`, `/ws/x` →
 * `/api/machines/{id}/ws/x`.
 */
export function buildMachineHttpPath(
  machineId: string,
  path: string,
  query?: URLSearchParams,
): string {
  const suffix = query && query.toString() ? `?${query.toString()}` : "";
  return `${machinePathPrefix(machineId, path)}${suffix}`;
}

/** Absolute websocket URL for a machine route on the serving origin. */
export function buildMachineWsUrl(
  machineId: string,
  path: string,
  query?: URLSearchParams,
): string {
  const location = globalThis.location;
  const protocol = location?.protocol === "https:" ? "wss:" : "ws:";
  const host = location?.host || "localhost";
  return `${protocol}//${host}${buildMachineHttpPath(machineId, path, query)}`;
}

function machinePathPrefix(machineId: string, path: string): string {
  if (path.startsWith("/api/")) {
    return `/api/machines/${encodeURIComponent(machineId)}/${path.slice("/api/".length)}`;
  }
  if (path.startsWith("/ws/")) {
    return `/api/machines/${encodeURIComponent(machineId)}/${path.slice(1)}`;
  }
  return `/api/machines/${encodeURIComponent(machineId)}/${path.replace(/^\//, "")}`;
}

/**
 * CLI parity: the machine tree replaces the bridge-origin zone split whenever
 * the split is on and the bridge actually serves saved SSH machines.
 */
export function machinesGroupingActive(
  mode: string,
  machines: readonly MachineInfo[],
): boolean {
  return mode === "local_remote" && machines.some((machine) => machine.kind === "ssh");
}

/** Connection indicator for a machine group, mirroring the CLI status badge. */
export function machineGroupStatus(view: MachineGroupView): MachineGroupStatus {
  if (view.capabilityState === "error" || view.loadState === "error") {
    return "unavailable";
  }
  if (view.hasSnapshot) {
    return "connected";
  }
  return "connecting";
}

/**
 * Sidebar machine groups: the local machine first, then saved SSH machines in
 * server order, then configured HTTP bridge backends as their own groups so
 * multi-bridge support stays intact without masquerading as machines. Stale
 * machine runtimes that the server list no longer carries are dropped.
 */
export function buildMachineGroups<T extends MachineGroupView>(
  machines: readonly MachineInfo[],
  views: readonly T[],
  sameOriginRuntimeId: string,
): MachineGroup<T>[] {
  const groups: MachineGroup<T>[] = [];
  const claimed = new Set<string>();
  const viewByRuntimeId = new Map(views.map((view) => [view.runtimeId, view]));
  for (const machine of machines) {
    const runtimeId = machine.kind === "local" ? sameOriginRuntimeId : machineRuntimeId(machine.id);
    const view = viewByRuntimeId.get(runtimeId);
    if (!view) {
      continue;
    }
    claimed.add(runtimeId);
    groups.push({
      key: `machine:${machine.id}`,
      machineId: machine.id,
      label: machine.label,
      runtimeId,
      status: machineGroupStatus(view),
      view,
    });
  }
  for (const view of views) {
    if (claimed.has(view.runtimeId) || view.mode === "machine") {
      continue;
    }
    groups.push({
      key: `bridge:${view.runtimeId}`,
      machineId: null,
      label: view.label,
      runtimeId: view.runtimeId,
      status: machineGroupStatus(view),
      view,
    });
  }
  return groups;
}

/**
 * Workspace entries below one machine group. Filtering by runtime id is what
 * keeps colliding workspace ids on different machines under the right machine.
 */
export function entriesForGroup<T extends { runtimeId: string }>(
  entries: readonly T[],
  group: MachineGroup,
): T[] {
  return entries.filter((entry) => entry.runtimeId === group.runtimeId);
}

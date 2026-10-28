export type WorkspaceZonesMode = "local_remote" | "off";

export type WorkspaceZone = "local" | "remote";

/** Parses a persisted or server-provided zone mode; null for unknown values. */
export function parseWorkspaceZonesMode(value: unknown): WorkspaceZonesMode | null {
  return value === "local_remote" || value === "off" ? value : null;
}

/**
 * Zone of a bridge endpoint, mirroring the CLI sidebar: the bridge that serves
 * the page is the local endpoint; every configured backend is remote.
 */
export function bridgeZone(
  bridgeId: string,
  bridgeMode: string,
  sameOriginBridgeId: string,
): WorkspaceZone {
  return bridgeId === sameOriginBridgeId || bridgeMode === "same-origin" ? "local" : "remote";
}

/**
 * CLI parity: zone headers only appear when the split is on and at least one
 * remote entry exists — a lone local endpoint keeps its header hidden, exactly
 * like the CLI hides the "Local" machine label when no remote machines do.
 */
export function zoneHeadersVisible(mode: WorkspaceZonesMode, remoteCount: number): boolean {
  return mode === "local_remote" && remoteCount > 0;
}

export function splitByZone<T>(
  items: readonly T[],
  zoneOf: (item: T) => WorkspaceZone,
): { local: T[]; remote: T[] } {
  const local: T[] = [];
  const remote: T[] = [];
  for (const item of items) {
    (zoneOf(item) === "local" ? local : remote).push(item);
  }
  return { local, remote };
}

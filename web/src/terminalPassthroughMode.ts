/**
 * Bridge-driven right-click passthrough (contract C). The bridge owns the
 * per-terminal mode and transports it over the terminal websocket:
 *
 *   bridge → client: {"type":"right_click_passthrough","mode":"auto"|"off","revision":N[,"requestId":N]}
 *   client → bridge: {"type":"set_right_click_passthrough","mode":"auto"|"off","requestId":N}
 *   bridge → client: {"type":"right_click_passthrough_error","requestId":N,"error":"…"}
 */

export type TerminalPassthroughMode = "auto" | "off";

/** App → TerminalView command to change a pane's mode over its terminal socket. */
export type TerminalPassthroughRequest = {
  bridgeId: string;
  connectionKey: string;
  terminalId: string;
  mode: TerminalPassthroughMode;
  token: number;
};

export type RightClickPassthroughFrame = {
  mode: TerminalPassthroughMode;
  revision: number;
  requestId?: number;
};

export type RightClickPassthroughErrorFrame = {
  requestId: number;
  error: string;
};

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Parses the bridge's right_click_passthrough control frame; null for any
 * other or malformed text frame (mouse_mode, close reasons, garbage).
 */
export function parseRightClickPassthroughFrame(text: string): RightClickPassthroughFrame | null {
  try {
    const value = JSON.parse(text) as {
      type?: unknown;
      mode?: unknown;
      revision?: unknown;
      requestId?: unknown;
    };
    if (value?.type !== "right_click_passthrough") return null;
    if (value.mode !== "auto" && value.mode !== "off") return null;
    if (!isNonNegativeInteger(value.revision)) return null;
    const frame: RightClickPassthroughFrame = { mode: value.mode, revision: value.revision };
    if (value.requestId !== undefined) {
      if (!isNonNegativeInteger(value.requestId)) return null;
      frame.requestId = value.requestId;
    }
    return frame;
  } catch {
    return null;
  }
}

/** Parses the bridge's rejection frame for a set_right_click_passthrough request. */
export function parseRightClickPassthroughErrorFrame(
  text: string,
): RightClickPassthroughErrorFrame | null {
  try {
    const value = JSON.parse(text) as { type?: unknown; requestId?: unknown; error?: unknown };
    if (value?.type !== "right_click_passthrough_error") return null;
    if (!isNonNegativeInteger(value.requestId)) return null;
    if (typeof value.error !== "string") return null;
    return { requestId: value.requestId, error: value.error };
  } catch {
    return null;
  }
}

/**
 * The bridge is the source of truth: right/middle clicks reach the pane app
 * only while it tracks the mouse AND the mode is not "off". A null mode
 * (no frame from this bridge yet) keeps forwarding off — safe default.
 */
export function isForwardingActive(
  mouseMode: boolean,
  passthroughMode: TerminalPassthroughMode | null,
): boolean {
  return mouseMode && passthroughMode !== null && passthroughMode !== "off";
}

/**
 * Revision monotonicity is tracked per websocket connection: a restarted
 * bridge restarts counting at 0, so lower revisions from an old connection
 * must not win. An equal revision is the broadcast+personal-ack duplicate
 * of one change and is dropped.
 */
export function shouldApplyRevision(lastSeen: number | null, incoming: number): boolean {
  return lastSeen === null || incoming > lastSeen;
}

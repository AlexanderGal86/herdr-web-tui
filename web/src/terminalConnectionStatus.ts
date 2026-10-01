export type TerminalConnectionState = "idle" | "connecting" | "attached" | "closed" | "error";

export const TERMINAL_CONNECTION_OVERLAY_DELAY_MS = 500;

/**
 * Dispatched on `window` when a terminal websocket closes without a close
 * reason (the bridge does this when the herdr server goes away, e.g. a
 * restart). The app listens and resnapshots immediately so panes remount on
 * the rotated terminal_id instead of waiting for the periodic poll.
 */
export const TERMINAL_CONNECTION_LOST_EVENT = "herdr-web:terminal-connection-lost";

export function parseTerminalCloseReason(message: string) {
  try {
    const parsed = JSON.parse(message) as { type?: unknown; reason?: unknown };
    return parsed.type === "closed" && typeof parsed.reason === "string" ? parsed.reason : null;
  } catch {
    return null;
  }
}

/**
 * "Already attached" rejections are usually transient — a bridge restart or
 * reattach can race the daemon's cleanup of the previous connection — so the
 * client retries them a few times before treating them as a genuine external
 * attach conflict.
 */
export const MAX_TERMINAL_ATTACH_CONFLICT_RETRIES = 3;

export function isTerminalAttachConflictClose(reason: string | null) {
  return reason !== null && reason.includes("already has an attached client");
}

export function isNonRetryableTerminalClose(reason: string | null) {
  return (
    reason !== null &&
    (isTerminalAttachConflictClose(reason) ||
      reason.includes("terminal attach taken over") ||
      reason.includes("terminal attach failed: terminal"))
  );
}

export function terminalConnectionCopy(
  state: TerminalConnectionState,
  reason: string | null,
  hasAttachedForTerminal = false,
) {
  if (reason?.includes("already has an attached client")) {
    return "Attached elsewhere";
  }
  if (reason?.includes("terminal attach taken over")) {
    return "Detached elsewhere";
  }
  switch (state) {
    case "connecting":
      return hasAttachedForTerminal ? "Reconnecting" : "Connecting";
    case "closed":
      return "Detached";
    case "error":
      return "Connection failed";
    case "idle":
    case "attached":
      return "";
  }
}

export function terminalConnectionOverlayDelayMs(
  state: TerminalConnectionState,
  delayConnecting: boolean,
) {
  return state === "connecting" && delayConnecting ? TERMINAL_CONNECTION_OVERLAY_DELAY_MS : 0;
}

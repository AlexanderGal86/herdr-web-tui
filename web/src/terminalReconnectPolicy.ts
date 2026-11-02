export type TerminalReconnectMode = "normal" | "foreground";

export type TerminalReconnectPolicyInput = {
  attempt: number;
  mode: TerminalReconnectMode;
  immediate: boolean;
  foregroundFastAttemptsRemaining: number;
};

export type TerminalReconnectPolicy = {
  delayMs: number;
  connectTimeoutMs: number;
  nextAttempt: number;
  nextForegroundFastAttemptsRemaining: number;
};

export const TERMINAL_RECONNECT_BASE_DELAY_MS = 500;
// A restarting bridge can take several seconds to complete the terminal
// socket's HTTP upgrade; a 10s ceiling lets such attempts finish instead of
// burning and re-scheduling against a bridge that is already coming up.
export const TERMINAL_RECONNECT_MAX_DELAY_MS = 3000;
export const TERMINAL_CONNECT_TIMEOUT_MS = 10000;
export const TERMINAL_FOREGROUND_CONNECT_TIMEOUT_MS = 1200;
export const TERMINAL_FOREGROUND_FAST_ATTEMPTS = 2;
export const TERMINAL_FOREGROUND_SIGNAL_COALESCE_MS = 400;
// Wake jitter for bridge-back signals, so every terminal pane of a bridge
// does not reconnect in the same instant the app announces recovery.
export const TERMINAL_BRIDGE_BACK_JITTER_MAX_MS = 300;

export function terminalReconnectPolicy({
  attempt,
  mode,
  immediate,
  foregroundFastAttemptsRemaining,
}: TerminalReconnectPolicyInput): TerminalReconnectPolicy {
  const foregroundFastAttempt = mode === "foreground" && foregroundFastAttemptsRemaining > 0;
  return {
    delayMs: immediate
      ? 0
      : Math.min(TERMINAL_RECONNECT_BASE_DELAY_MS * 2 ** attempt, TERMINAL_RECONNECT_MAX_DELAY_MS),
    connectTimeoutMs: foregroundFastAttempt
      ? TERMINAL_FOREGROUND_CONNECT_TIMEOUT_MS
      : TERMINAL_CONNECT_TIMEOUT_MS,
    nextAttempt: immediate ? attempt : attempt + 1,
    nextForegroundFastAttemptsRemaining: foregroundFastAttempt
      ? foregroundFastAttemptsRemaining - 1
      : foregroundFastAttemptsRemaining,
  };
}

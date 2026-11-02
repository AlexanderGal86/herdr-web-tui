import { describe, expect, it } from "vitest";
import {
  TERMINAL_CONNECT_TIMEOUT_MS,
  TERMINAL_RECONNECT_BASE_DELAY_MS,
  TERMINAL_RECONNECT_MAX_DELAY_MS,
  terminalReconnectPolicy,
} from "./terminalReconnectPolicy";

describe("terminalReconnectPolicy", () => {
  it("connects immediately without advancing normal backoff attempts", () => {
    expect(
      terminalReconnectPolicy({
        attempt: 0,
        immediate: true,
      }),
    ).toEqual({
      delayMs: 0,
      connectTimeoutMs: TERMINAL_CONNECT_TIMEOUT_MS,
      nextAttempt: 0,
    });
  });

  it("uses capped exponential delay for normal reconnects", () => {
    expect(
      terminalReconnectPolicy({
        attempt: 0,
        immediate: false,
      }).delayMs,
    ).toBe(500);
    expect(
      terminalReconnectPolicy({
        attempt: 4,
        immediate: false,
      }).delayMs,
    ).toBe(TERMINAL_RECONNECT_MAX_DELAY_MS);
  });

  // Wave-8 measurement: a restarting bridge left the terminal dead ~23s
  // because attempts burned on 3.5s connect timeouts against a slow HTTP
  // upgrade and the 5s backoff cap stretched the gaps.
  it("keeps every new connect attempt alive for 10s against a slow upgrade", () => {
    expect(TERMINAL_CONNECT_TIMEOUT_MS).toBe(10000);
    // Foreground (signal-started) attempts follow the same short-delay
    // cadence but must not lose the full timeout: the 1.2s foreground fast
    // timeout killed slow upgrades exactly when the bridge was coming back.
    expect(
      terminalReconnectPolicy({ attempt: 0, immediate: true }).connectTimeoutMs,
    ).toBe(TERMINAL_CONNECT_TIMEOUT_MS);
    expect(
      terminalReconnectPolicy({ attempt: 0, immediate: false }).connectTimeoutMs,
    ).toBe(TERMINAL_CONNECT_TIMEOUT_MS);
  });

  it("caps normal reconnect backoff at 3s", () => {
    const delays: number[] = [];
    let attempt = 0;
    for (let i = 0; i < 6; i += 1) {
      const policy = terminalReconnectPolicy({
        attempt,
        immediate: false,
      });
      delays.push(policy.delayMs);
      attempt = policy.nextAttempt;
    }
    expect(delays).toEqual([500, 1000, 2000, 3000, 3000, 3000]);
  });

  it("keeps short retry delays after a foreground signal without a fast timeout", () => {
    const first = terminalReconnectPolicy({ attempt: 0, immediate: true });
    expect(first.delayMs).toBe(0);
    expect(first.nextAttempt).toBe(0);

    const second = terminalReconnectPolicy({
      attempt: first.nextAttempt,
      immediate: false,
    });
    expect(second.delayMs).toBe(TERMINAL_RECONNECT_BASE_DELAY_MS);
    expect(second.connectTimeoutMs).toBe(TERMINAL_CONNECT_TIMEOUT_MS);
  });
});

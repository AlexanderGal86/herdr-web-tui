export type TerminalInputTransport = "json" | "binary";
export type TerminalInputBatch = {
  parts: string[];
  bytes: number;
};

export const DEFAULT_TERMINAL_INPUT_TRANSPORT: TerminalInputTransport = "json";
export const DEFAULT_TERMINAL_INPUT_BATCH_DELAY_MS = 0;
export const TERMINAL_INPUT_BATCH_MAX_BYTES = 32;
// Widen to readonly number[] so Array.includes can check unknown prefs without a cast.
export const TERMINAL_INPUT_BATCH_DELAY_OPTIONS_MS: readonly number[] = [0, 32, 64, 128, 256];

export function parseTerminalInputTransport(value: unknown): TerminalInputTransport {
  return value === "binary" || value === "json" ? value : DEFAULT_TERMINAL_INPUT_TRANSPORT;
}

export function parseTerminalInputBatchDelayMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_TERMINAL_INPUT_BATCH_DELAY_MS;
  }
  return TERMINAL_INPUT_BATCH_DELAY_OPTIONS_MS.includes(value)
    ? value
    : DEFAULT_TERMINAL_INPUT_BATCH_DELAY_MS;
}

export function emptyTerminalInputBatch(): TerminalInputBatch {
  return { parts: [], bytes: 0 };
}

export function shouldSendTerminalInputImmediately(bytes: number, delayMs: number): boolean {
  return delayMs <= 0 || bytes >= TERMINAL_INPUT_BATCH_MAX_BYTES;
}

export function appendTerminalInputBatch(
  batch: TerminalInputBatch,
  data: string,
  bytes: number,
): { batch: TerminalInputBatch; shouldFlush: boolean } {
  const next = {
    parts: [...batch.parts, data],
    bytes: batch.bytes + bytes,
  };
  return {
    batch: next,
    shouldFlush: next.bytes >= TERMINAL_INPUT_BATCH_MAX_BYTES,
  };
}

export function drainTerminalInputBatch(batch: TerminalInputBatch): {
  data: string | null;
  batch: TerminalInputBatch;
} {
  return {
    data: batch.parts.length === 0 ? null : batch.parts.join(""),
    batch: emptyTerminalInputBatch(),
  };
}

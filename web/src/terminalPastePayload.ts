/**
 * Paste payload builder for the terminal paste dialog.
 *
 * The daemon's TerminalAnsi stream may not forward DEC mode 2004, so the
 * browser VT cannot always know whether the pane app supports bracketed
 * paste. The dialog lets the user pick the send mode explicitly.
 */

export type PasteSendMode = "auto" | "bracketed" | "flatten";

export type PastePayloadResult =
  | { ok: true; data: string; sanitized: boolean }
  | { ok: false; reason: "empty" | "too_large" };

/** Keep pastes well below the bridge's 8 MiB input backlog budget. */
export const PASTE_MAX_BYTES = 1024 * 1024;

const BRACKET_START = "\x1b[200~";
const BRACKET_END = "\x1b[201~";

/** Newlines arrive as CRLF or CR depending on the source; normalize to LF. */
export function normalizePasteText(text: string): string {
  return text.replace(/\r\n?/gu, "\n");
}

/**
 * Strip characters that could terminate the bracketed region early (ESC) or
 * that apps treat as control input. Keeps tabs and newlines: tabs are data,
 * newlines are the reason the dialog exists.
 */
export function sanitizePasteText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/gu, "");
}

/** Collapse newline runs (with surrounding spaces) into single spaces. */
export function flattenPasteText(text: string): string {
  return text.replace(/[ \t]*\n+[ \t]*/gu, " ").trim();
}

export function countPasteLines(text: string): number {
  if (text.length === 0) return 0;
  return text.split("\n").length;
}

export function pastePayloadBytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Multiline text (or a size overflow) needs the mode dialog; plain short
 * single-line text can go straight to the renderer like Ctrl+V always did. */
export function needsPasteDialog(text: string): boolean {
  return /[\r\n]/u.test(text) || pastePayloadBytes(text) > PASTE_MAX_BYTES;
}

/**
 * Build the exact string to hand to the renderer for the chosen mode.
 * - auto: normalized text; the renderer's mode-aware paste decides the framing.
 * - bracketed: wrapped in ESC[200~/ESC[201~ with control characters stripped.
 * - flatten: newlines collapsed to spaces for single-line inputs.
 */
export function buildPastePayload(rawText: string, mode: PasteSendMode): PastePayloadResult {
  const normalized = normalizePasteText(rawText);
  // Whitespace-only text is a stray keypress, not a paste.
  if (normalized.trim().length === 0) {
    return { ok: false, reason: "empty" };
  }
  if (mode === "flatten") {
    const flattened = flattenPasteText(normalized);
    if (flattened.length === 0) {
      return { ok: false, reason: "empty" };
    }
    const data = sanitizePasteText(flattened);
    return finish(data, data !== flattened);
  }
  if (mode === "bracketed") {
    const sanitized = sanitizePasteText(normalized);
    if (sanitized.length === 0) {
      return { ok: false, reason: "empty" };
    }
    return finish(BRACKET_START + sanitized + BRACKET_END, sanitized !== normalized);
  }
  return finish(normalized, false);
}

function finish(data: string, sanitized: boolean): PastePayloadResult {
  if (pastePayloadBytes(data) > PASTE_MAX_BYTES) {
    return { ok: false, reason: "too_large" };
  }
  return { ok: true, data, sanitized };
}

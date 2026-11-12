import { describe, expect, it } from "vitest";
import {
  buildPastePayload,
  countPasteLines,
  flattenPasteText,
  needsPasteDialog,
  normalizePasteText,
  PASTE_MAX_BYTES,
  pastePayloadBytes,
  sanitizePasteText,
} from "./terminalPastePayload";

describe("terminalPastePayload", () => {
  it("normalizes CRLF and lone CR to LF", () => {
    expect(normalizePasteText("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
  });

  it("counts lines", () => {
    expect(countPasteLines("one\ntwo\nthree")).toBe(3);
    expect(countPasteLines("")).toBe(0);
    expect(countPasteLines("single")).toBe(1);
  });

  it("rejects empty payloads", () => {
    expect(buildPastePayload("", "auto")).toEqual({ ok: false, reason: "empty" });
    expect(buildPastePayload("\r\n", "auto")).toEqual({ ok: false, reason: "empty" });
  });

  it("auto mode returns normalized text without framing", () => {
    const result = buildPastePayload("x\r\ny", "auto");
    expect(result).toEqual({ ok: true, data: "x\ny", sanitized: false });
  });

  it("bracketed mode wraps with 200~/201~ markers", () => {
    const result = buildPastePayload("a\nb", "bracketed");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toBe("\x1b[200~a\nb\x1b[201~");
    }
  });

  it("bracketed mode strips embedded bracket terminators and other controls", () => {
    const evil = "a\x1b[201~b\x07c\td";
    const result = buildPastePayload(evil, "bracketed");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toBe("\x1b[200~a[201~bc\td\x1b[201~");
      expect(result.sanitized).toBe(true);
      // The payload must contain exactly one bracket end marker.
      expect(result.data.split("\x1b[201~")).toHaveLength(2);
    }
  });

  it("sanitize keeps tabs and newlines, drops ESC and C0 controls", () => {
    expect(sanitizePasteText("a\tb\nc\x1bd\x00e\x7ff")).toBe("a\tb\ncdef");
  });

  it("flatten mode collapses newlines to single spaces", () => {
    expect(flattenPasteText("a\n\nb \n c")).toBe("a b c");
    const result = buildPastePayload("a\nb", "flatten");
    expect(result).toEqual({ ok: true, data: "a b", sanitized: false });
  });

  it("flatten mode rejects whitespace-only text", () => {
    expect(buildPastePayload("\n \n", "flatten")).toEqual({ ok: false, reason: "empty" });
  });

  it("rejects payloads above the byte ceiling and allows the ceiling itself", () => {
    expect(buildPastePayload("x".repeat(PASTE_MAX_BYTES + 1), "auto")).toEqual({
      ok: false,
      reason: "too_large",
    });
    expect(buildPastePayload("x".repeat(PASTE_MAX_BYTES), "auto").ok).toBe(true);
  });

  it("measures UTF-8 bytes, not code units", () => {
    expect(pastePayloadBytes("π")).toBe(2);
  });

  it("routes multiline or oversized text to the dialog", () => {
    expect(needsPasteDialog("one line")).toBe(false);
    expect(needsPasteDialog("a\nb")).toBe(true);
    expect(needsPasteDialog("a\rb")).toBe(true);
    expect(needsPasteDialog("x".repeat(PASTE_MAX_BYTES + 1))).toBe(true);
    expect(needsPasteDialog("x".repeat(PASTE_MAX_BYTES))).toBe(false);
  });
});

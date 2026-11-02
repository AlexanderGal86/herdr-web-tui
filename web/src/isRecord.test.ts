import { describe, expect, it } from "vitest";
import { isRecord } from "./isRecord";

describe("isRecord", () => {
  it("accepts plain objects", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ version: 1 })).toBe(true);
  });

  it("rejects arrays and other non-records", () => {
    expect(isRecord([])).toBe(false);
    expect(isRecord([{ version: 1 }])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord("object")).toBe(false);
    expect(isRecord(42)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
  });
});

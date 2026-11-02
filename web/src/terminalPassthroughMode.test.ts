import { describe, expect, it } from "vitest";
import {
  isForwardingActive,
  parseRightClickPassthroughErrorFrame,
  parseRightClickPassthroughFrame,
  shouldApplyRevision,
} from "./terminalPassthroughMode";

describe("parseRightClickPassthroughFrame", () => {
  it("parses broadcast and personal-ack frames", () => {
    expect(
      parseRightClickPassthroughFrame('{"type":"right_click_passthrough","mode":"auto","revision":0}'),
    ).toEqual({ mode: "auto", revision: 0 });
    expect(
      parseRightClickPassthroughFrame('{"type":"right_click_passthrough","mode":"off","revision":3,"requestId":7}'),
    ).toEqual({ mode: "off", revision: 3, requestId: 7 });
  });

  it("rejects malformed and unrelated frames", () => {
    expect(parseRightClickPassthroughFrame('{"type":"mouse_mode","enabled":true}')).toBeNull();
    expect(parseRightClickPassthroughFrame('{"type":"right_click_passthrough","mode":"always","revision":0}')).toBeNull();
    expect(parseRightClickPassthroughFrame('{"type":"right_click_passthrough","mode":"auto"}')).toBeNull();
    expect(parseRightClickPassthroughFrame('{"type":"right_click_passthrough","mode":"auto","revision":-1}')).toBeNull();
    expect(parseRightClickPassthroughFrame('{"type":"right_click_passthrough","mode":"auto","revision":1.5}')).toBeNull();
    expect(parseRightClickPassthroughFrame('{"type":"right_click_passthrough","mode":"auto","revision":1,"requestId":"2"}')).toBeNull();
    expect(parseRightClickPassthroughFrame("not json")).toBeNull();
    expect(parseRightClickPassthroughFrame('{"type":"terminal_closed"}')).toBeNull();
  });
});

describe("parseRightClickPassthroughErrorFrame", () => {
  it("parses rejections and rejects anything else", () => {
    expect(
      parseRightClickPassthroughErrorFrame('{"type":"right_click_passthrough_error","requestId":2,"error":"store unavailable"}'),
    ).toEqual({ requestId: 2, error: "store unavailable" });
    expect(parseRightClickPassthroughErrorFrame('{"type":"right_click_passthrough_error","error":"no id"}')).toBeNull();
    expect(parseRightClickPassthroughErrorFrame('{"type":"right_click_passthrough_error","requestId":2}')).toBeNull();
    expect(parseRightClickPassthroughErrorFrame('{"type":"right_click_passthrough","mode":"auto","revision":0}')).toBeNull();
    expect(parseRightClickPassthroughErrorFrame("not json")).toBeNull();
  });
});

describe("isForwardingActive", () => {
  it("forwards only when the pane tracks the mouse and the mode is auto", () => {
    expect(isForwardingActive(true, "auto")).toBe(true);
    expect(isForwardingActive(false, "auto")).toBe(false);
    expect(isForwardingActive(true, "off")).toBe(false);
    // No bridge frame yet: forwarding stays off regardless of mouse tracking.
    expect(isForwardingActive(true, null)).toBe(false);
    expect(isForwardingActive(false, null)).toBe(false);
  });
});

describe("shouldApplyRevision", () => {
  it("applies the first revision and strictly newer ones", () => {
    expect(shouldApplyRevision(null, 0)).toBe(true);
    expect(shouldApplyRevision(4, 5)).toBe(true);
  });

  it("drops duplicates and stale revisions", () => {
    // The broadcast and the personal ack carry one change's revision twice.
    expect(shouldApplyRevision(4, 4)).toBe(false);
    expect(shouldApplyRevision(4, 3)).toBe(false);
    expect(shouldApplyRevision(4, 0)).toBe(false);
  });
});

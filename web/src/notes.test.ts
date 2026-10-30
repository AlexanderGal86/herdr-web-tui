import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NotesApiError,
  createNote,
  isNotesConflictError,
  notesForPane,
  parseNotesList,
  parsePaneNote,
  supportsNotes,
} from "./notes";
import type { PaneNote } from "./notes";

describe("notes helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("checks the bridge notes capability", () => {
    expect(supportsNotes({ commands: [], notes: { version: 1 } })).toBe(true);
    expect(supportsNotes({ commands: [] })).toBe(false);
    expect(supportsNotes(null)).toBe(false);
  });

  it("returns only active linked notes for the selected pane", () => {
    const notes: PaneNote[] = [
      note("n1", "p1", "linked", "200"),
      note("n2", "p1", "unresolved", "300"),
      note("n3", "p2", "linked", "400"),
      { ...note("n4", "p1", "linked", "500"), archived_at: "501" },
      note("n5", "p1", "linked", "600"),
    ];

    expect(notesForPane(notes, "p1").map((item) => item.note_id)).toEqual(["n5", "n1"]);
  });

  it("preserves HTTP status for note mutation errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: "note has changed" }), {
          status: 409,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await expect(createNote((path) => `http://bridge${path}`, {})).rejects.toMatchObject({
      name: "NotesApiError",
      status: 409,
      message: "note has changed",
    });

    const error = new NotesApiError("note has changed", 409);
    expect(isNotesConflictError(error)).toBe(true);
    expect(isNotesConflictError(new NotesApiError("bad", 400))).toBe(false);
  });

  it("validates note list payloads and drops malformed note entries", () => {
    const valid = note("n1", "p1", "linked", "200");
    const malformed: Record<string, unknown> = { ...valid, revision: "one" };
    expect(parseNotesList({ store_id: "store", session_key: "s", notes: [valid, malformed] }))
      .toEqual({ store_id: "store", session_key: "s", notes: [valid] });
    expect(parseNotesList({ store_id: "store", session_key: "s", notes: "none" })).toBeNull();
    expect(parseNotesList({ store_id: "store", notes: [] })).toBeNull();
    expect(parseNotesList("nope")).toBeNull();
  });

  it("validates single note payloads including optional attachments", () => {
    expect(parsePaneNote(note("n1", "p1", "linked", "200"))).toMatchObject({ note_id: "n1" });
    expect(parsePaneNote({ ...note("n1", "p1", "linked", "200"), attachment: { pane_id: "p1" } })).toBeNull();
    expect(parsePaneNote({ ...note("n1", "p1", "linked", "200"), link_state: "floating" })).toBeNull();
    expect(parsePaneNote({ ...note("n1", "p1", "linked", "200"), attachment_history: null })).toBeNull();
    expect(parsePaneNote(42)).toBeNull();
  });

  it("rejects malformed note mutation responses with an explicit error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ note_id: 7 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await expect(createNote((path) => `http://bridge${path}`, {})).rejects.toThrow(
      "note mutation failed: malformed response",
    );
  });
});

function note(
  noteId: string,
  paneId: string,
  linkState: PaneNote["link_state"],
  updatedAt: string,
): PaneNote {
  return {
    note_id: noteId,
    title: noteId,
    body: "",
    created_at: "100",
    updated_at: updatedAt,
    session_key: "session:default",
    attachment: {
      type: "pane",
      pane_id: paneId,
      workspace_id: "w1",
      tab_id: "t1",
      terminal_id: "term1",
      captured_at: "100",
      context: {},
    },
    attachment_history: [],
    revision: 1,
    link_state: linkState,
    resolved_pane:
      linkState === "linked"
        ? {
            pane_id: paneId,
            terminal_id: "term1",
            workspace_id: "w1",
            tab_id: "t1",
            focused: false,
            agent_status: "unknown",
            revision: 1,
          }
        : undefined,
  };
}

import { apiErrorMessage } from "./bridgeApi";
import type { BridgeHttpUrl } from "./bridgeApi";
import { fetchWithTimeout } from "./fetchWithTimeout";
import type { PaneInfo } from "./types";
import type { BridgeCapabilities } from "./bridge";

export type NoteLinkState = "linked" | "unresolved" | "detached";

export type NotePaneContext = {
  pane_label?: string;
  pane_title?: string;
  agent?: string;
  display_agent?: string;
  cwd?: string;
  foreground_cwd?: string;
};

export type NoteAttachment = {
  type: "pane";
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  terminal_id?: string;
  pane_revision?: number;
  observed_generation?: string;
  captured_at: string;
  context: NotePaneContext;
};

export type PaneNote = {
  note_id: string;
  title: string;
  body: string;
  created_at: string;
  updated_at: string;
  archived_at?: string;
  deleted_at?: string;
  session_key: string;
  attachment?: NoteAttachment | null;
  attachment_history: NoteAttachment[];
  revision: number;
  link_state: NoteLinkState;
  resolved_pane?: PaneInfo;
};

export type NotesListResponse = {
  store_id: string;
  session_key: string;
  notes: PaneNote[];
};

export type NotesListOptions = {
  includeArchived?: boolean;
  includeDeleted?: boolean;
  includeOtherSessions?: boolean;
  paneId?: string;
};

export type NoteCreateInput = {
  title?: string;
  body?: string;
  paneId?: string;
};

export type NoteUpdateInput = {
  title?: string;
  body?: string;
  expectedRevision: number;
};

export type NoteAttachInput = {
  paneId: string;
  expectedRevision: number;
};

export type NoteRevisionInput = {
  expectedRevision: number;
};

export type { BridgeHttpUrl } from "./bridgeApi";

export class NotesApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "NotesApiError";
    this.status = status;
  }
}

export function isNotesConflictError(error: unknown): error is NotesApiError {
  return error instanceof NotesApiError && error.status === 409;
}

export function supportsNotes(capabilities: BridgeCapabilities | null | undefined) {
  return capabilities?.notes?.version === 1;
}

export async function fetchNotes(
  httpUrl: BridgeHttpUrl,
  options: NotesListOptions = {},
): Promise<NotesListResponse> {
  const query = new URLSearchParams();
  if (options.includeArchived) {
    query.set("include_archived", "true");
  }
  if (options.includeDeleted) {
    query.set("include_deleted", "true");
  }
  if (options.includeOtherSessions) {
    query.set("include_other_sessions", "true");
  }
  if (options.paneId) {
    query.set("pane_id", options.paneId);
  }
  const response = await fetchWithTimeout(httpUrl("/api/notes", query));
  return parseNotesResponse(response);
}

export function createNote(httpUrl: BridgeHttpUrl, input: NoteCreateInput) {
  return sendNoteMutation(httpUrl, "/api/notes", {
    title: input.title,
    body: input.body,
    pane_id: input.paneId,
  });
}

export function updateNote(httpUrl: BridgeHttpUrl, noteId: string, input: NoteUpdateInput) {
  return sendNoteMutation(httpUrl, notePath(noteId, "update"), {
    title: input.title,
    body: input.body,
    expected_revision: input.expectedRevision,
  });
}

export function attachNote(httpUrl: BridgeHttpUrl, noteId: string, input: NoteAttachInput) {
  return sendNoteMutation(httpUrl, notePath(noteId, "attach"), {
    pane_id: input.paneId,
    expected_revision: input.expectedRevision,
  });
}

export function detachNote(httpUrl: BridgeHttpUrl, noteId: string, input: NoteRevisionInput) {
  return sendNoteMutation(httpUrl, notePath(noteId, "detach"), {
    expected_revision: input.expectedRevision,
  });
}

export function archiveNote(httpUrl: BridgeHttpUrl, noteId: string, input: NoteRevisionInput) {
  return sendNoteMutation(httpUrl, notePath(noteId, "archive"), {
    expected_revision: input.expectedRevision,
  });
}

export function restoreNote(httpUrl: BridgeHttpUrl, noteId: string, input: NoteRevisionInput) {
  return sendNoteMutation(httpUrl, notePath(noteId, "restore"), {
    expected_revision: input.expectedRevision,
  });
}

export function deleteNote(httpUrl: BridgeHttpUrl, noteId: string, input: NoteRevisionInput) {
  return sendNoteMutation(httpUrl, notePath(noteId, "delete"), {
    expected_revision: input.expectedRevision,
  });
}

export function notesForPane(notes: readonly PaneNote[], paneId: string | null | undefined) {
  if (!paneId) {
    return [];
  }
  return notes
    .filter((note) => !note.archived_at && !note.deleted_at)
    .filter(
      (note) =>
        note.link_state === "linked" &&
        note.resolved_pane?.pane_id === paneId &&
        note.attachment?.pane_id === paneId,
    )
    .sort(compareNotes);
}

export function compareNotes(a: PaneNote, b: PaneNote) {
  const updated = Number(b.updated_at || 0) - Number(a.updated_at || 0);
  if (updated !== 0) {
    return updated;
  }
  return a.note_id.localeCompare(b.note_id, undefined, { numeric: true });
}

async function sendNoteMutation(
  httpUrl: BridgeHttpUrl,
  path: string,
  body: Record<string, unknown>,
) {
  const response = await fetchWithTimeout(httpUrl(path), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return parseNoteResponse(response);
}

const NOTE_LINK_STATES: readonly NoteLinkState[] = ["linked", "unresolved", "detached"];

function isNoteAttachment(value: unknown): value is NoteAttachment {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const attachment = value as Record<string, unknown>;
  return (
    typeof attachment.pane_id === "string" &&
    typeof attachment.workspace_id === "string" &&
    typeof attachment.tab_id === "string" &&
    typeof attachment.captured_at === "string" &&
    typeof attachment.context === "object" &&
    attachment.context !== null
  );
}

function isPaneNotePayload(value: unknown): value is PaneNote {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const note = value as Record<string, unknown>;
  if (
    typeof note.note_id !== "string" ||
    !note.note_id ||
    typeof note.title !== "string" ||
    typeof note.body !== "string" ||
    typeof note.created_at !== "string" ||
    typeof note.updated_at !== "string" ||
    typeof note.session_key !== "string" ||
    typeof note.revision !== "number" ||
    typeof note.link_state !== "string" ||
    !NOTE_LINK_STATES.includes(note.link_state as NoteLinkState) ||
    !Array.isArray(note.attachment_history)
  ) {
    return false;
  }
  if (note.attachment !== null && note.attachment !== undefined && !isNoteAttachment(note.attachment)) {
    return false;
  }
  return true;
}

/** Parses a /api/notes list payload; malformed note entries are dropped. */
export function parseNotesList(value: unknown): NotesListResponse | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const { store_id, session_key, notes } = value as Record<string, unknown>;
  if (typeof store_id !== "string" || typeof session_key !== "string" || !Array.isArray(notes)) {
    return null;
  }
  return { store_id, session_key, notes: notes.filter(isPaneNotePayload) };
}

/** Parses a single note payload; returns null when the shape is malformed. */
export function parsePaneNote(value: unknown): PaneNote | null {
  return isPaneNotePayload(value) ? value : null;
}

async function parseNotesResponse(response: Response) {
  if (!response.ok) {
    throw await notesApiError(response, "notes");
  }
  const parsed = parseNotesList(await response.json());
  if (!parsed) {
    throw new Error("notes failed: malformed response");
  }
  return parsed;
}

async function parseNoteResponse(response: Response) {
  if (!response.ok) {
    throw await notesApiError(response, "note mutation");
  }
  const parsed = parsePaneNote(await response.json());
  if (!parsed) {
    throw new Error("note mutation failed: malformed response");
  }
  return parsed;
}

async function notesApiError(response: Response, fallback: string) {
  const message = await apiErrorMessage(response);
  return new NotesApiError(
    message ?? `${fallback} failed: ${response.status}`,
    response.status,
  );
}

function notePath(noteId: string, action: string) {
  return `/api/notes/${encodeURIComponent(noteId)}/${action}`;
}

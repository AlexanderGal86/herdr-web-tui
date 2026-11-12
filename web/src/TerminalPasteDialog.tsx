import { useEffect, useId, useRef, useState } from "react";
import type { FormEvent } from "react";
import { trapFocusWithin, useFocusReturn } from "./overlayFocus";
import {
  countPasteLines,
  normalizePasteText,
  pastePayloadBytes,
  PASTE_MAX_BYTES,
  sanitizePasteText,
} from "./terminalPastePayload";
import type { PasteSendMode } from "./terminalPastePayload";

const MODE_OPTIONS: ReadonlyArray<{ id: PasteSendMode; label: string; hint: string }> = [
  {
    id: "bracketed",
    label: "Bracketed paste",
    hint: "Multiline text arrives as one block — newlines are not Enter. Works when the pane's app supports it (bash, pi, codex and most TUIs do)",
  },
  {
    id: "auto",
    label: "Automatic",
    hint: "Plain terminal paste like Ctrl+V today — apps without bracketed-paste support treat each newline as Enter",
  },
  {
    id: "flatten",
    label: "Single line",
    hint: "Newlines are replaced with spaces before sending",
  },
];

/**
 * Preview dialog for multiline pastes. The user picks the send mode because
 * the browser cannot reliably know whether the pane's app enabled DEC mode
 * 2004 (the daemon may not forward the mode report).
 */
export function TerminalPasteDialog({
  text,
  onSend,
  onCancel,
}: {
  text: string;
  /** Returns an error message to display, or null when the paste was sent. */
  onSend: (mode: PasteSendMode, text: string) => string | null;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(() => normalizePasteText(text));
  const [mode, setMode] = useState<PasteSendMode>("bracketed");
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const titleId = useId();
  useFocusReturn();

  useEffect(() => {
    textareaRef.current?.focus();
    textareaRef.current?.select();
  }, []);

  const lines = countPasteLines(value);
  const bytes = pastePayloadBytes(value);
  const normalized = normalizePasteText(value);
  // Auto mode is a plain VT paste (today's Ctrl+V) and sends controls as-is.
  const willSanitize = mode !== "auto" && sanitizePasteText(normalized) !== normalized;
  const tooLarge = bytes > PASTE_MAX_BYTES;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (value.trim().length === 0 || tooLarge) {
      return;
    }
    setError(onSend(mode, value));
  };

  return (
    <div className="overlay-root">
      <button className="overlay-scrim" type="button" tabIndex={-1} aria-label="Cancel" onClick={onCancel} />
      <form
        className="modal paste-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onSubmit={submit}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
            return;
          }
          trapFocusWithin(event);
        }}
      >
        <div id={titleId} className="modal-title">
          Paste to terminal
        </div>
        <textarea
          ref={textareaRef}
          className="paste-textarea mono"
          value={value}
          rows={8}
          spellCheck={false}
          onChange={(event) => setValue(event.target.value)}
        />
        <div className="paste-stats mono" role="status">
          {lines} {lines === 1 ? "line" : "lines"} · {bytes} bytes
          {willSanitize ? " · control characters will be removed" : ""}
        </div>
        <div className="paste-modes" role="radiogroup" aria-label="Paste mode">
          {MODE_OPTIONS.map((option) => (
            <label key={option.id} className="paste-mode">
              <input
                type="radio"
                name="paste-mode"
                value={option.id}
                checked={mode === option.id}
                onChange={() => setMode(option.id)}
              />
              <span>
                <span className="paste-mode-label">{option.label}</span>
                <span className="paste-mode-hint">{option.hint}</span>
              </span>
            </label>
          ))}
        </div>
        {error ? (
          <div className="paste-error mono" role="alert">
            {error}
          </div>
        ) : null}
        {tooLarge ? (
          <div className="paste-error mono" role="alert">
            Text is larger than {Math.floor(PASTE_MAX_BYTES / 1024 / 1024)} MiB
          </div>
        ) : null}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={value.trim().length === 0 || tooLarge}>
            Paste
          </button>
        </div>
      </form>
    </div>
  );
}

import { useEffect, useId, useRef, useState } from "react";
import type { FormEvent } from "react";
import { trapFocusWithin, useFocusReturn } from "./overlayFocus";

export type MachineAddSubmit = {
  target: string;
  label?: string;
  session?: string;
};

/**
 * Modal for registering a saved SSH machine through the bridge's native
 * `herdr machine add` route (the same command the operator would run in a
 * terminal on the bridge host). Purely user-triggered: nothing is registered
 * until the form is submitted.
 */
export function MachineAddDialog({
  busy,
  error,
  onCancel,
  onSubmit,
}: {
  busy?: boolean;
  error?: string | null;
  onCancel: () => void;
  onSubmit: (input: MachineAddSubmit) => void;
}) {
  const targetRef = useRef<HTMLInputElement | null>(null);
  const [target, setTarget] = useState("");
  const [label, setLabel] = useState("");
  const [session, setSession] = useState("");
  const titleId = useId();
  const errorId = useId();
  useFocusReturn();

  useEffect(() => {
    targetRef.current?.focus();
  }, []);

  const cancel = () => {
    if (!busy) {
      onCancel();
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmedTarget = target.trim();
    if (busy || !trimmedTarget) {
      return;
    }
    onSubmit({
      target: trimmedTarget,
      label: label.trim() || undefined,
      session: session.trim() || undefined,
    });
  };

  return (
    <div className="overlay-root">
      <button
        className="overlay-scrim"
        type="button"
        tabIndex={-1}
        aria-label="Cancel"
        disabled={busy}
        onClick={cancel}
      />
      <form
        className="modal machine-add-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onSubmit={submit}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            cancel();
            return;
          }
          trapFocusWithin(event);
        }}
      >
        <div id={titleId} className="modal-title">
          Add machine
        </div>
        <div className="modal-message">
          Saved on the bridge host with your existing SSH access. Submitting registers
          the machine; no passwords are entered here.
        </div>
        <label className="field-label">
          <span>SSH target</span>
          <input
            ref={targetRef}
            className="field"
            value={target}
            placeholder="root@host"
            required
            spellCheck={false}
            autoComplete="off"
            disabled={busy}
            aria-label="SSH target"
            onChange={(event) => setTarget(event.currentTarget.value)}
          />
        </label>
        <label className="field-label">
          <span>Label</span>
          <input
            className="field"
            value={label}
            placeholder="farm"
            spellCheck={false}
            autoComplete="off"
            disabled={busy}
            aria-label="Machine label (optional)"
            onChange={(event) => setLabel(event.currentTarget.value)}
          />
        </label>
        <label className="field-label">
          <span>Remote session</span>
          <input
            className="field"
            value={session}
            placeholder="default"
            spellCheck={false}
            autoComplete="off"
            disabled={busy}
            aria-label="Remote session (optional)"
            onChange={(event) => setSession(event.currentTarget.value)}
          />
        </label>
        {error ? (
          <div className="modal-message" role="alert" id={errorId}>
            {error}
          </div>
        ) : null}
        <div className="modal-actions">
          <button type="button" className="btn" disabled={busy} onClick={cancel}>
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={busy || !target.trim()}
            aria-describedby={error ? errorId : undefined}
          >
            Add machine
          </button>
        </div>
      </form>
    </div>
  );
}

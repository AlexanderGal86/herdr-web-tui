import { useEffect, useRef } from "react";

/** Retries are for mobile keyboards; desktop defaults must yield to subsequent clicks. */
export function useTerminalFocusRequest(token: number, focus: () => void, retry: boolean) {
  const retryRef = useRef(retry);

  // Synced in an effect (not during render) so a discarded concurrent render
  // cannot leave a stale retry flag behind; declared first so the token effect
  // below always reads the committed value.
  useEffect(() => {
    retryRef.current = retry;
  }, [retry]);

  useEffect(() => {
    if (token === 0) return;
    const frame = window.requestAnimationFrame(focus);
    const timers = (retryRef.current ? [80, 220] : []).map((delay) =>
      window.setTimeout(focus, delay),
    );
    return () => {
      window.cancelAnimationFrame(frame);
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [focus, token]);
}

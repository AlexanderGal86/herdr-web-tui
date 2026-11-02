# Tech Debt Notes

Parked engineering findings that are **deliberately not being fixed now**. Recorded so the
analysis work is not lost. This is not a to-do list — nothing here is scheduled.

Policy (agreed with the owner, 2026-11-02): no preventive refactors of hotspots. Extract a
seam only when a feature or bugfix already touches that file — the cost then rides along with
work we were doing anyway.

## Complexity hotspots (pi-lens scan, 2026-11-02, main `fdc2a56`)

Line numbers drift; anchor by symbol name.

### `web/src/bridge.tsx`

| Symbol / site | Metric | Note |
|---|---|---|
| `BridgeProvider` (~L152) | cyclomatic complexity 60; calls 62 distinct functions | Coordination smell: reconnect policy + polling + command dispatch + state all in one provider. Candidate seams: reconnect/backoff policy, snapshot refresh coordinator, machine-add flow, capability parsing. |
| `parseCapabilities` (~L1269) | cyclomatic complexity 20 | Field-by-field optional decoding; table-driven decode would flatten it. |
| L250 | `filter(x => x).map(...)` | Single-pass `flatMap` reads better. |
| L381, L403, L426 | async functions with no `await` | Async noise; drop `async` or await something real. |
| L779, L954 | nested ternaries | if/else or early returns. |
| `isNativeApp` (~L1045) | trivial pass-through wrapper | Inline or keep as the single seam if platform checks centralize later. |

### `web/src/overlays.tsx`

| Symbol / site | Metric | Note |
|---|---|---|
| `ActionMenu` (~L101) | cyclomatic complexity 30; 23 distinct calls | Menu rendering + focus management + keyboard nav in one component. Extract keyboard-nav state machine (see `onMenuKeyDown`). |
| `onMenuKeyDown` (~L160) | cyclomatic complexity 15 | Key-switch + focus math; a small reducer would make it testable without rendering. |
| `useLongPress` (~L16) | cyclomatic complexity 16 | Timer + pointer lifecycle; candidate for a pure reducer with injected timers. |
| L197–L201 | nested ternaries (3×) | Position/visibility logic; if/else chains. |

## Why these are parked

- Zero user-visible benefit; pure maintainability.
- `bridge.tsx` and `overlays.tsx` are the heart of the UI. Refactoring them requires
  characterization-test coverage first — the regression risk outweighs the readability win
  while nobody is touching the files.
- Complexity metrics are heuristics, not defects. `parseCapabilities` at 20 is fine until the
  capability protocol changes again.

## Trigger conditions (when to pick up)

- Any feature that extends `BridgeProvider` behavior (new resource type, new reconnect rule):
  extract the piece it touches first, add characterization tests, then implement.
- Any keyboard-nav change in `ActionMenu`: extract `onMenuKeyDown` reducer first.
- `parseCapabilities`: table-drive it the next time a capability field is added.

## Reproducing the scan

Run pi-lens diagnostics (`lens_diagnostics`) on the files above; warnings are labelled
`[high-complexity]`, `[slop]`, etc. Advisories about "unused exports" and "unlisted
dependencies" from lens across multiple git worktrees have repeatedly been false positives
(stale graph); verify against `web/package.json` and real imports before acting.

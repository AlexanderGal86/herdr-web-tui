# Terminal context menu

The user requested the original Herdr CLI right-click menu in the web client and confirmed that the target is the terminal body. The reference is Herdr v0.9.1 `src/client/shell/context_menu.rs` (https://github.com/herdrdev/herdr/blob/v0.9.1/src/client/shell/context_menu.rs).

## Behavior

Right-click on a terminal opens the existing accessible web action menu at the pointer, targeting that exact pane and bridge, including an unfocused split. Opening it must not send mouse input or terminal keys, change the selected pane, or clear the active text selection. Escape and dismissal return focus to the invoking terminal. Shift+F10 / ContextMenu opens it from keyboard focus.

Provide Rename pane, Clear pane name when manually named, Split right/down, Zoom/Restore, Swap with focused pane when a distinct selected pane in the same tab exists, and Close pane with the existing confirmation. Retain supported pin/note/move web actions. Gate remote actions against the clicked bridge's advertised capabilities and current connection. Missing/closed targets must not fall back to some other pane.

Provide a per-terminal web-session toggle for sending right-clicks to the terminal application. Shift+right-click or the keyboard context-menu shortcut always opens the web menu, allowing the toggle to be reverted. This is a web input preference, not a change to native Herdr's setting, and resets with the web session/terminal identity. Left clicks, native editing controls, mobile selection gestures, and ordinary input retain their behavior.

## Implementation

Reuse App's ActionMenu, dialogs, commands and split rendering. TerminalView receives `onContextMenu?: (x: number, y: number) => void` and `rightClickPassthrough?: boolean`. Intercept actual terminal-host mouse/pointer events during capture, ahead of Ghostty; leave textarea/input controls outside that host alone. Restore focus through the existing overlay mechanism without causing a terminal reconnect.

Add only `pane.zoom` and `pane.swap` to the Rust bridge allow-list. Zoom requires explicit non-empty pane_id. Swap accepts only distinct explicit source_pane_id/target_pane_id; implicit focus and directional swap are rejected. Keep other allow-list constraints and vendored protocol files unchanged. Pane-name reset reuses pane.rename with null.

## Verification and delivery

Write failing focused tests before implementation for event capture and keyboard/mouse passthrough, command payloads/menu capability gating, and Rust validation. Run frontend full tests/lint/build, bridge focused command tests/build/format, then check the menu visually using isolated preview sessions. Do not execute terminal actions against the user's live panes. Temporarily start a preview server only for verification and stop it afterward, respecting the previous request to stop both web servers. Record upstream Windows failures separately. Update README and changelog. Existing OneDev publication authorization covers this fork; do not prompt for new credentials unless publishing actually needs them.

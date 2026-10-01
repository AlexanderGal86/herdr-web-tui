# Terminal Context Menu Implementation Plan

> **For agentic workers:** Use subagent-driven-development for independent bridge and terminal-event tasks, then review the integrated change.

**Goal:** Implement the confirmed terminal right-click menu from Herdr v0.9.1 in both web appearances.

**Architecture:** Existing ActionMenu and explicit bridge/pane targets; terminal capture handlers suppress application input only when opening the web menu. Extend bridge validation only for explicit zoom/swap operations.

**Tech Stack:** React, TypeScript, Ghostty Web, Vitest, Rust/serde.

## Tasks

- [x] Bridge: tests first for `pane.zoom` with explicit pane_id and `pane.swap` with distinct explicit source/target IDs, rejecting directional/implicit modes; implement allow-list/validation in bridge/src/web_bridge.rs. Run focused cargo tests and format.
- [x] TerminalView: tests first for callbacks, right-click input interception, keyboard menu, passthrough with Shift override, and native input preservation. Add optional onContextMenu/rightClickPassthrough props; preserve connections/focus.
- [x] App integration: capture clicked-pane target without selecting it; add gated native actions and a transient per-terminal passthrough state. Wire single/split views and existing dialogs. Add command payload and menu model tests; implement API helpers for zoom/swap/null rename.
- [x] Verify frontend lint/full tests/build and bridge build/focused tests, review changes independently, and fix findings. Inspect preview with real Ghostty canvas; never issue live-pane mutations. Stop temporary preview server.
- [x] Document use and limitations; commit reviewed code and update OneDev if existing authentication permits. Verify repository state and report concrete outcome.

Publication attempt: non-interactive Git push to OneDev could not authenticate. The reviewed commit is local; remote branches remain unchanged until Git sign-in is available.


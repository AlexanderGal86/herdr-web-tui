## [Unreleased]

### Breaking Changes

### Added

- Bottom-right **Open TTT** button: opens the TTT Editor in the active workspace as a new tab through the official Herdr plugin pane mechanism (`ttt.editor`/`editor`, `plugin.pane.open` over the daemon socket — no browser-supplied argv). The preset (`builtin:ttt`) is offered only while Herdr reports the plugin installed and enabled on the serving host, and machine runtimes never show it, so a click always launches on the bridge host the user is looking at. The button sits above the stage bar and, on touch layouts, above the mobile terminal controls strip, so it covers no bar controls or quick keys.
- Pane-app mouse forwarding for the web terminal: the bridge now forwards the daemon's `MouseCapture` state over the terminal socket (`{"type":"mouse_mode","enabled":…}`, seeded from the shared session so a joining client learns the current flag) and translates browser mouse gestures into `AttachMouse` structured events the daemon encodes for the pane app's real tracking mode. While a pane app captures the mouse (TTT, vim, htop, …), clicks, drags, and wheel go to the app; right/middle clicks keep the browser-like Herdr gestures (pane menu, selection copy, middle-click paste), with Shift always forcing the Herdr menu. Mouse reports respect the same detach/takeover gating as keyboard input and are rejected unless they match a strict kind/button allowlist.
- Fixed the browser terminal ignoring pane-app mouse reporting entirely: ghostty-web has no mouse→PTY path, so clicks in TTT-style panes previously did nothing.
- Two-stage SCP uploads for saved SSH machines: uploading from a machine runtime now stages the file privately on the bridge host and copies it with `scp -s` into the remote user's `~/.local/share/herdr-web/uploads` directory, committing atomically with no-clobber semantics, conflict renaming, and explicit overwrite. The uploads UI is gated on a new `uploads` capability so runtimes without the route no longer advertise it, while older local bridges keep their existing upload behavior.

- Added a built-in `omp` launcher preset: the launch dialog offers OMP alongside the other managed
  agents, started through Herdr `agent.start` with kind `omp`.
- Added an OMP agent icon shown for the `omp` agent hint and `omp`/`oh my pi` labels in panes,
  agent rows, and the launch dialog.
- Added a `Paste` item to the terminal right-click menu: it reads the clipboard and pastes into
  the pane the menu was opened on (same path as middle-click paste, including bracketed paste and
  the clipboard-unavailable fallback message).
- Added Local/Remote workspace zones in the sidebar spaces list, mirroring the CLI client's
  local-versus-remote endpoint split: spaces of the serving bridge group under a `Local` header,
  configured remote bridges under `Remote` (with per-host subheaders when several remote bridges
  are enabled; the `Local` header stays hidden while no remote bridge exists, like the CLI).
  The mode is a server-side bridge setting stored on the bridge host under
  `herdr-web/workspace-zones` (override with `HERDR_WEB_WORKSPACE_ZONES_DIR`), exposed via
  `GET/PUT /api/workspace-zones` and the `workspace_zones` capability, and toggled from the space
  list options menu (`Zones: Local / Remote | Off`). Default: on.
- Added saved-machine grouping with real remote routing, matching the CLI `machines` sidebar:
  the bridge discovers the operator's saved Herdr SSH machines from Herdr's own client state
  (`~/.local/state/herdr/client/endpoints.json`) and exposes them via `GET /api/machines`
  (`machines` capability). The sidebar shows a `workspaces` section (the machine tree, headed
  `workspaces` while it is active) with a collapsible `Local`
  group (the serving bridge daemon) and one collapsible group per enabled saved machine with
  a connection indicator; workspaces always sit under the machine that serves them, so the
  tree also works with a single serving bridge. All machine data flows through same-origin
  machine-scoped bridge routes (`/api/machines/{id}/snapshot|command|selection|capabilities`
  and `/api/machines/{id}/ws/events|terminal`): snapshot, browser commands (same allow-list),
  pane selection, events, and terminal attach are forwarded to the selected machine over
  Herdr hidden `remote-api-bridge` / `remote-client-bridge` SSH transports - nothing falls
  back to local data, and unknown, disabled, unreachable, or unsupported machines fail closed.
  SSH arguments are built as plain argv vectors from the operator-configured catalog only, the
  remote capability marker (`herdr-api-bridge-v1`) is verified before serving a machine, and
  per-machine terminal-session and selection state stays isolated so colliding workspace or
  pane ids on different machines never mix. Machine selection is browser-session state and is
  never persisted to browser storage; configured HTTP bridge backends keep their existing
  grouping and remain distinct from saved machines.

- Farm connections can now be created from the sidebar: whenever the serving bridge advertises
  its `machines` capability, the section header shows a plus button opening an `Add machine`
  dialog (SSH target, optional label, optional remote session) — including before any saved SSH
  machine exists and while the Local/Remote zone split is off. Submitting runs the native
  `herdr machine add` CLI on the bridge host as a plain argv vector, so registration follows the
  CLI's documented flow: it may discover and start the remote Herdr server and saves the profile
  using the bridge host's existing SSH access. The bridge itself stores nothing and adds no SSH
  keys — authentication and host-key checking stay with OpenSSH — and steps the CLI reserves for
  interactive confirmation (installing or replacing the remote server) fail with the CLI's own
  error text, since the bridge runs it non-interactively. Option-like or control-character input
  is rejected before anything runs, the new `POST /api/machines/add` route sits behind the
  bridge's existing origin/Host request policy, and new machines appear in the tree immediately.
  When `HERDR_WEB_MACHINES_ENDPOINTS` relocates the catalog the bridge reads, the route refuses
  with 503 before invoking the CLI, since the CLI would write a different catalog than the one
  being served.
- Saved SSH machines can now be disabled from the web client: the machine's group context menu
  offers `Disable connection` with a confirmation, and confirming calls the new
  `POST /api/machines/{machine_id}/disable` bridge route. As with machine add, the bridge only
  forwards a validated argv vector to the native `herdr machine disable <PROFILE_ID>` CLI on the
  bridge host and never touches endpoints.json, SSH trust, or keys itself; the saved profile is
  retained (re-enabling stays a native CLI operation, `herdr machine enable`). The route answers
  with the freshly read machine list, so the machine leaves the sidebar immediately, and errors
  map to sensible responses: the local machine and already-disabled machines are refused
  (400), unknown or invalid ids are refused (404), a CLI failure returns 502 with the CLI's own
  stderr tail, and a relocated catalog (`HERDR_WEB_MACHINES_ENDPOINTS`) refuses with 503 before
  anything runs. The route sits behind the same origin/Host request policy as every other
  machine route, so the behavior change applies to all bridge clients. Deployment is not part
  of this change: existing bridge installations gain it only after they deploy a bridge build
  from this source.
- Restored the `workspaces` sidebar heading: while the machine tree is active the spaces list
  header reads `workspaces` (instead of `spaces`), matching the CLI machine tree; every other
  mode keeps the `spaces` label.

- Add native TLS to the bridge behind a new `--tls-self-signed` flag. The
  single bridge port serves HTTPS and secure WebSockets (`wss://`) when the
  flag is enabled and stays plain HTTP otherwise. The self-signed certificate
  is generated once and kept stable across restarts — it is stored under the
  XDG state directory (e.g. `~/.local/state/herdr-web/tls`, overridable with
  `HERDR_WEB_TLS_DIR`), covers `localhost`, `127.0.0.1`, `::1`, the machine
  hostname, and local network IPs, and is regenerated only when missing or
  invalid. Bridge compatibility note: no wire-protocol or API change; the
  Host-header gate now treats 443 as the implicit port when TLS is enabled
  (80 remains the implicit port for plain HTTP).
- Copying selected terminal text with a right-click: when a selection is
  active, right-click copies it to the clipboard (with the same wrapped-URL
  normalization as the mobile copy flow) and clears the selection, instead of
  opening the pane menu. Shift+right-click always opens the menu, and
  right-clicking without a selection keeps the previous behavior (menu, or
  forwarding to the pane in "Send right-clicks to pane" mode).
- Add a Russian troubleshooting section for a hung bridge: idle WebSocket
  connections, heartbeat timeouts and `terminal not found` on re-attach, with
  diagnosis steps and a `systemctl restart herdr-web-tui.service` recovery.

- Add middle-button clipboard paste into the clicked terminal, activating its pane
  and preserving native bracketed paste. Retain Ghostty's automatic copy on selection.
  Reject delayed clipboard results when the target terminal or connection changes.

- Add terminal right-click menus in both appearances, matching Herdr's rename/reset,
  split, zoom, swap and close actions. Support keyboard invocation and per-terminal
  right-click passthrough with Shift+right-click recovery. Expose only explicitly
  targeted `pane.zoom` and `pane.swap` commands through the bridge allow-list.

- Add the default Herdr TUI appearance inspired by the interactive herdr.dev shell, with
  monospace navigation, compact tabs, split-pane captions and mauve focus borders.
  Settings > Display > Appearance switches back to the original Web appearance.

- Allow configured bridge URLs to include a reverse-proxy path prefix for same-origin multi-bridge
  deployments. [PR #94](https://github.com/kcosr/herdr-web/pull/94), contributed by
  [Will Hampson (@Whamp)](https://github.com/Whamp).
- Shift+Insert pastes the clipboard into the focused terminal (also while a pane app tracks the
  mouse), matching desktop-terminal muscle memory alongside middle-click paste.

### Changed

- The duplicated selection column-range ternaries in `selectedTextFromVisibleRows` and the
  renderer's viewport selection text are extracted into a shared tested `selectionRowColRange`
  helper (anchor rows clamp to their endpoint, intermediate rows span to the caller's row end);
  both call sites keep their existing row-end behavior.
- The five scattered `as` casts reaching ghostty-web's private runtime fields are consolidated:
  one `ghosttyTerminalPrivateFields` view (animationFrameId/scrollbarOpacity/selectionManager) and
  one `terminalBufferLine` helper (the grapheme_len superset of `IBufferLine`) now carry the only
  remaining assertions, and `renderGhosttyTerminalFrame` reads the public renderer/wasmTerm/
  viewportY fields directly. Covered by the existing suspend/render/selection tests; no behavior
  change.
- `TERMINAL_INPUT_BATCH_DELAY_OPTIONS_MS` is typed as `readonly number[]` at its definition, so
  the batch-delay preference check uses plain `Array.includes` instead of a cast to the literal
  tuple's element type.
- The terminal `input` event handler narrows its `Event` to the fields the IME reducer reads with
  a validated `terminalInputEventFields` guard instead of a blind `as InputEvent` cast, so a
  non-InputEvent dispatch degrades to an unknown edit instead of reading undefined fields.
- Terminal upload responses are validated with a runtime type guard (mirroring the notes/machines
  parsers) instead of an unchecked cast, so a malformed `file` payload now fails the upload with
  `Upload failed (…)` instead of returning garbage data.
- The four duplicate `/ws/ui-events` parsers (selection/notes/agent-activity/agent-pins, each with
  its own JSON.parse and try/catch) are consolidated into one exported `parseBridgeEvent` type-guard
  returning a discriminated union; behavior of every event kind is preserved (covered by
  characterization tests).
- The sidebar `spaceEntries` computation is memoized (like the neighboring machine space entries),
  avoiding an O(workspaces×panes) rebuild on every render.
- Development model documented in `README.md` and `AGENTS.md`: upstream
  `kcosr/herdr-web` is a source of ideas only; this fork develops independently
  and does not track or layer on upstream releases (#1).
- Vendored Herdr compatibility snapshot refreshed from upstream `v0.9.0` to `v0.9.5`
  (commit `2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01`): the exact-compared upstream
  copies (JSON API schema modules, input model, wire production body) now match
  upstream `v0.9.5` (locally adapted files — `client`, `status`, `tests`,
  `tabs`, `workspaces` — stay documented adaptations); the shim grew
  `DefaultColorKind`/`RgbColor` host default-color support for the new
  `ClientInputEvent::HostDefaultColor` variant, and the upstream graphics
  bulk-codec regression tests are now included. Terminal wire protocol stays at
  `22` (frozen generation-1 digests unchanged); new JSON fields deserialize with
  `serde` defaults, and the refreshed build was smoke-tested end-to-end against
  a live Herdr `v0.9.5` daemon. The bridge still enforces the documented
  `v0.9.0`+ / protocol-`22` floor (#1).
- Installation instructions now clone from the public GitHub repository
  (`https://github.com/AlexanderGal86/herdr-web-tui.git`); the LAN-only OneDev
  address remains documented as an internal mirror.
- Launcher preset launches of managed agents now complete as soon as the daemon
  acknowledges the agent start, instead of waiting for the agent to become
  interactive. The "New tab" dialog closes in a fraction of a second for every
  preset (previously ~4s for agents, and a 30s hang followed by tab rollback and
  a launch error when the agent CLI was missing on the bridge host). Agent
  startup failures — e.g. a missing CLI — now surface directly inside the new
  terminal pane. Bridge compatibility note: no wire-protocol change; the
  `/api/launcher-presets/launch` response is unchanged, only faster.
- Removed the `Zoom` entry from the terminal right-click menu. `Restore split layout` is still
  offered when a tab is already zoomed, so an existing zoom state remains recoverable.

- Automatically increment Android `versionCode` and stamp `versionName` in the tagged release
  commit, keeping repeated builds of that release on the same Android version.
  [PR #91](https://github.com/kcosr/herdr-web/pull/91).
- Document APK package, signature, alignment, and update-signer checks, and clarify debug signing.
  [PR #91](https://github.com/kcosr/herdr-web/pull/91) by
  [Will Hampson (@Whamp)](https://github.com/Whamp).

### Fixed

- Vendored herdr-compat: `ApiClientError` now implements `source()`, so the underlying io or
  serde_json cause stays reachable through the error chain for loggers and diagnostics (the
  bridge binary picks this up without changes); `Display` output is unchanged.
- Bridge: terminal-session pruning no longer fires on Herdr events whose payload text merely
  contains a substring like `pane.closed` (e.g. a pane cwd or label); the event envelope's exact
  `event` kind is now parsed and matched, and non-JSON payloads never prune.
- Bridge: uploaded files are now stored with owner-only permissions (0600), set at creation
  time (create-new path) or on the temp file before the publish rename (overwrite path), instead
  of the umask default (0644) that briefly exposed uploaded content to other local users; the
  upload directory itself is unchanged.
- Bridge: the `Content-Security-Policy` header is now computed once at startup and cloned per
  response instead of being rebuilt from the configured connect sources on every HTTP reply.
- Bridge: the agent-activity tracker no longer panics on every agent-activity API call after a
  panic poisons its internal mutex; a poisoned lock now serves the last tracked state until the
  bridge restarts.
- `herdr-web:terminal-connection-lost` is now dispatched once per outage instead of on every
  reason-less close: failed reconnect attempts close the same way, and each dispatch triggered an
  app-wide resnapshot. A successful reopen re-arms the signal for the next outage.
- Queued terminal input now drains up to 8 parts (or 4 KiB) per 35ms tick instead of exactly one
  part, so a submitted command and its Enter frame arrive together instead of Enter lagging one
  tick behind; the caps still pace a large reconnect backlog onto a freshly opened socket.
- Disposing the terminal renderer now also cancels the pending 0ms focus-retry timer from
  `focusTextInput`, matching the render-frame cleanup, so a dispose right after focus cannot fire
  into a detached textarea.
- Trackpad wheel scrolling now accumulates fractional line deltas across wheel events
  (`normalizeWheelLines` carries a remainder on the renderer) instead of rounding every sub-line
  delta up to a full line, which made slow two-finger scrolling jump one line per event.
- A machine-bridge connection whose local client disconnected is now torn down even when the
  ssh child keeps running: previously an ssh child that ignored stdin EOF and stayed silent held
  one of the 32 connection permits forever (the keepalive fix only covered the opposite case of a
  dead ssh child with a silent local client). Since no bridge client half-closes its socket
  (API requests drop the stream, terminal detach shuts down both directions), EOF on the client
  socket now ends the session: the stdin copier kills the ssh child, the stdout copier and the
  accept-loop permit are released promptly, and the child is reaped.
- Bridge unit tests no longer flake when run in parallel: every `MachineManager` test
  now gets its own machine socket root (injected through the manager config) instead of
  racing `remove_file`/`bind` cycles on the shared default socket directory under
  `~/.local/state/herdr-web/machines` (the `EADDRINUSE`/`Address already in use` flakes),
  and the fake-CLI/fake-scp stub tests retry the transient `ETXTBSY` overlayfs window
  after writing a stub script, matching the existing machine-disable test.
- Backend settings no longer clobber the dialog state when a save finishes after the user switched
  to adding a new bridge or to the same-origin mode mid-flight: the saved profile only replaces the
  form if the selection mode and form contents are still the ones the save started with.
- Overlay focus traps now keep Tab inside the trap when the focused element became unfocusable
  (e.g. `tabindex=-1` or disabled while focused): such elements are treated like focus outside the
  focusable list and wrap to the first/last focusable element.
- Bridge command and launcher-preset errors now go through the shared `apiErrorMessage` helper, so a
  structured error body (e.g. `{"error":{...}}`) surfaces the HTTP status fallback instead of a
  literal `[object Object]` message; plain string errors are still preferred.
- `/api/notes` responses are validated instead of blindly cast: list and mutation payloads go through
  `parseNotesList`/`parsePaneNote` guards (modeled on `parseMachinesList`), malformed note entries are
  dropped from lists, and a malformed single-note response fails with an explicit error instead of
  crashing note rendering later.
- Pane selection sync (`/api/selection`) now uses the shared `fetchWithTimeout` helper, so a hung
  bridge can no longer leave the selection request pending indefinitely.
- Failed bridge snapshot refreshes now log the underlying error cause in the console instead of
  silently swallowing it, while the connection state keeps its existing shape.
- The bridge snapshot response is validated before use: a malformed payload (missing the
  workspaces/tabs/panes/layouts collections) now fails the snapshot fetch with an explicit
  error instead of being blindly cast and crashing later rendering.
- Agent pin toggles no longer apply a stale response after the bridge reconnects mid-request: the
  pin state update is dropped unless the connection key captured at request time still matches.
- Saved-machine ssh connections now send fast keepalives (`ServerAliveInterval=5`,
  `ServerAliveCountMax=2`, matching the upload path) so a silently dead peer can no
  longer hold a bridge connection permit; when the ssh child exits, the local bridge
  socket is closed so the peer sees EOF and the permit is released promptly.
- Pane observation polls no longer serialize the whole observation store twice per call to
  detect changes; mutations now report their own change flag (matching the notes store), which
  also removes a spurious rewrite when serialization ever failed. Recovered stores are still
  rewritten unconditionally.
- Saved-machine bridge sockets no longer die silently on transient accept errors (EMFILE,
  ENFILE, ENOBUFS, ECONNABORTED): the accept loop now classifies errors, backs off with capped
  exponential delay while remaining stop-responsive, and only exits (with a visible `failed`
  state and an error log) when the listener itself is broken.
- Local upload overwrites are now committed with a single atomic `rename` on Unix instead of
  unlink-then-rename, so a crash or a failed swap can no longer leave the upload directory
  without the previous file. Symlink and directory destinations are still refused.
- Text selection is creatable with the mouse again in every pane, including ones whose app
  tracks the mouse (agent TUIs like pi, vim, htop): structured mouse reports are now forwarded
  to the pane app only in panes opted into right-click passthrough (TTT), so every other pane
  keeps fully native drag-to-select, wheel scrollback, and the right-click copy/menu contract
  (right-click with a selection copies and clears it; without a selection it opens the pane
  menu; nothing is copied merely by selecting).
- Right-click copy/menu and middle-click paste work again in panes whose app tracks the mouse
  (agent TUIs, TTT): pane-app mouse forwarding no longer swallows those browser gestures.
  Right-click passthrough now reroutes clicks only while the pane app actually tracks the
  mouse, so an opted-in pane without tracking keeps the Herdr pane menu instead of a dead
  right-click. Right/middle clicks still go to the app in panes opted into right-click
  passthrough — TTT
  panes launched from the web are seeded into it automatically (and the preference now persists
  across reloads, like manual toggles) so their context menus keep working, and the explicit
  pane-menu toggle still overrides (TTT panes launched outside the web need the toggle once).
- Fixed the machine host selector resetting to the local bridge: ephemeral SSH machine runtimes are now included in the enabled bridge id list the web app validates selections against, so picking a saved machine stays selected (machine selection remains session-only and is never written to browser storage).

- Terminal selections no longer copy to the clipboard by themselves.
  Finishing a mouse selection in the web terminal silently overwrote the
  clipboard with the selected text (ghostty-web's built-in copy-on-select).
  Copying now happens only through explicit actions: right-click copy, the
  copy keyboard shortcut, or the mobile copy flow.

- Recover open panes within ~a second after a herdr server restart: terminal sockets
  that close without a close reason now trigger an immediate snapshot refresh, so
  panes remount on the rotated terminal ids instead of retrying the dead ones until
  the 10-second periodic poll notices.

- Send protocol-level pings on idle browser WebSockets and close connections that do not return peer
  traffic within 15 seconds, removing dead transports without claiming to detect frozen JavaScript.
  [PR #93](https://github.com/kcosr/herdr-web/pull/93), contributed by
  [Will Hampson (@Whamp)](https://github.com/Whamp).
- Overlapping terminal commands no longer unlock the UI early: when two commands race
  (e.g. a keyboard shortcut fires while another command is still running), the busy state now
  stays set until the last command settles instead of being cleared by whichever finishes first.
- Terminal mouse drags no longer leak document listeners: when a pane app disabled mouse
  tracking mid-drag, the drag's document mousemove/mouseup listeners stayed installed until the
  terminal was disposed and reported phantom moves once tracking came back; they are now removed
  on every drag-ending mouseup.

### Removed

## [0.6.1] - 2026-09-12

### Added

- Add a non-repeating Enter key at the end of the expanded mobile arrow row, also selectable
  for shortcuts such as Alt+Enter. [PR #89](https://github.com/kcosr/herdr-web/pull/89).

- Add mobile terminal keys with hold-repeat and a shortcut builder for Ctrl, Shift, and Alt
  combinations with special or printable keys. [PR #89](https://github.com/kcosr/herdr-web/pull/89),
  building on [PR #63](https://github.com/kcosr/herdr-web/pull/63) by
  [Will Hampson (@Whamp)](https://github.com/Whamp).

### Changed

- Keep Esc, Tab, C-c, C-d, and 1/2/3 in the mobile quick-key row. The neutral keyboard icon
  expands Backspace, arrows, and navigation keys, with a keyboard-plus shortcut toggle inside.
  [PR #89](https://github.com/kcosr/herdr-web/pull/89).
- Share the same keys between direct input and shortcut building. Show the selected chord with
  Send and Cancel actions; tapping the selected key again clears it while retaining modifiers.
  Sending, cancelling, or collapsing the keyboard exits shortcut mode without changing the
  command draft.
  [PR #89](https://github.com/kcosr/herdr-web/pull/89).

### Fixed

- Preserve terminal or command-field focus when tapping mobile quick keys, shortcut keys,
  or modifier toggles so the soft keyboard can stay open.
  [PR #89](https://github.com/kcosr/herdr-web/pull/89).

- Keep held mobile terminal keys repeating through UI updates, and send conventional
  modified Backspace, Tab, and Escape input without requiring an extended keyboard protocol.
  [PR #89](https://github.com/kcosr/herdr-web/pull/89).

- Start mobile terminal refit retries after the current terminal renderer mounts, so a slow tab
  switch cannot leave the terminal at its initial keyboard-sized height.
  [PR #90](https://github.com/kcosr/herdr-web/pull/90).

## [0.6.0] - 2026-09-07

### Breaking Changes

- Require Herdr v0.9.0 or newer with terminal protocol 22.
  [PR #88](https://github.com/kcosr/herdr-web/pull/88).

### Changed

- Refresh the minimal Herdr compatibility code for v0.9.0 while retaining the existing
  per-terminal ANSI rendering, browser input, and shared-view behavior.
  [PR #88](https://github.com/kcosr/herdr-web/pull/88).

### Fixed

- Use the browser's active space as the source for new-space launch directories,
  respecting Herdr's `terminal.new_cwd` policy instead of another client's focus.
  [PR #88](https://github.com/kcosr/herdr-web/pull/88).
- Require explicit confirmation before closing a primary workspace and its related workspaces.
  [PR #88](https://github.com/kcosr/herdr-web/pull/88).
- Subscribe to live agent activity before establishing the initial status snapshot.
  [PR #88](https://github.com/kcosr/herdr-web/pull/88).

## [0.5.2] - 2026-09-07

### Added

- Add an optional mobile “Focus command input after Send” setting, off by default,
  to refocus the cleared command field for continued typing.
  [PR #85](https://github.com/kcosr/herdr-web/pull/85).

- Added an opt-in desktop command composer under Settings → Terminal for editing multiline input
  before sending it, without changing desktop terminal selection, scrolling, or cursor
  behavior. [PR #82](https://github.com/kcosr/herdr-web/pull/82), contributed by
  [Andreas Ahrens (@AndreasAhrens)](https://github.com/AndreasAhrens).

### Fixed

- Redraw idle Windows terminal selections and scrolling with cursor blinking disabled,
  and apply cursor-blink changes immediately to mounted terminals.
  [PR #87](https://github.com/kcosr/herdr-web/pull/87).

- Add a Terminal setting for cursor blinking and default it off on Windows. When it is
  off, render only for terminal updates and interactions instead of repainting the
  high-DPI canvas continuously, avoiding severe lag in large Windows browser windows.
  [PR #86](https://github.com/kcosr/herdr-web/pull/86).

- Discard late keyboard composition updates for 250 ms after command Send or Stage so
  submitted dictation cannot immediately repopulate the replacement input. Preserve existing
  field replacement and focus behavior; ordinary non-composing typing and paste remain accepted.
  New composition started within this brief window can also be discarded.
  [PR #85](https://github.com/kcosr/herdr-web/pull/85).

- Update locked development dependencies to established security-patched releases for the
  Capacitor, lint, test, and frontend build tools, preserving cross-platform optional packages.
  [PR #85](https://github.com/kcosr/herdr-web/pull/85).

- Focus the enabled desktop command composer on terminal attach and navigation focus requests,
  after closing Settings, and after Send, including Ctrl+Enter and Cmd+Enter. Direct terminal
  clicks retain focus through reconnects and immediately after a default focus request. Desktop
  Stage focuses the terminal to edit or run the staged input; mobile keyboard behavior
  remains unchanged. [PR #82](https://github.com/kcosr/herdr-web/pull/82).

- Keep unsent desktop and mobile command drafts per bridge and pane while navigating, until
  sent, staged, or the pane is confirmed closed. Drafts remain in memory for the current browser
  tab only. [PR #82](https://github.com/kcosr/herdr-web/pull/82).

- Fixed desktop terminal copy shortcuts so copying selected text no longer also sends Ctrl+C to
  the PTY; Ctrl+C without a selection and Ctrl+C on macOS retain their normal interrupt behavior.
  [PR #84](https://github.com/kcosr/herdr-web/pull/84), contributed by
  [Andreas Ahrens (@AndreasAhrens)](https://github.com/AndreasAhrens).

## [0.5.1] - 2026-09-04

### Added

- Added a bundled JetBrainsMono Nerd Font Mono fallback for special terminal and LLM output glyphs
  on devices without an accessible Nerd Font.
  [PR #74](https://github.com/kcosr/herdr-web/pull/74), contributed by
  [Craig P. Motlin (@motlin)](https://github.com/motlin).

### Changed

- Upload conflicts are now atomically de-duplicated by default: re-uploading `image.png` lands as
  `image-1.png` instead of prompting to replace the original, including when uploads race. Turn off
  automatic conflict renaming under Settings → Terminal → Uploads to keep the Replace or Cancel
  prompt. Existing files are replaced only after explicit confirmation.
  [PR #77](https://github.com/kcosr/herdr-web/pull/77), contributed by
  [Trillium Smith (@trillium)](https://github.com/trillium).

## [0.5.0] - 2026-08-21

### Breaking Changes

- The bridge now requires Herdr `v0.8.2` or newer reporting terminal protocol `20`. Herdr
  `v0.8.0` and `v0.8.1` daemons (protocol `19`) are rejected at startup.
  [PR #69](https://github.com/kcosr/herdr-web/pull/69)

### Changed

- Refreshed the vendored Herdr compatibility sources to the `v0.8.2`/protocol `20` baseline.
  The new protocol `20` server message variants (`TerminalBell`, `GraphicsFile`,
  `GraphicsTransmissionRetired`) decode but are ignored by the bridge, adding no new behavior.
  [PR #69](https://github.com/kcosr/herdr-web/pull/69)
- Compress terminal output with gzip when the client and bridge both support it.
  [PR #59](https://github.com/kcosr/herdr-web/pull/59), contributed by
  [Will Hampson (@Whamp)](https://github.com/Whamp).
- Changed the Attention agent sort to break ties within an attention band by the most recent agent
  status change, matching Herdr's Priority agent panel, and kept the existing bridge, Space, and tab
  order as the fallback for agents with no recorded transition.
  [PR #68](https://github.com/kcosr/herdr-web/pull/68), contributed by
  [Craig P. Motlin (@motlin)](https://github.com/motlin).
- Stop blinking the terminal cursor on touch devices so idle terminals do not keep redrawing.
  Desktop cursors still blink.
  [PR #60](https://github.com/kcosr/herdr-web/pull/60), contributed by
  [Will Hampson (@Whamp)](https://github.com/Whamp).

### Fixed

- Join canvas-wrapped HTTP(S) URLs when copying from a mobile terminal.
  [PR #61](https://github.com/kcosr/herdr-web/pull/61), contributed by
  [Will Hampson (@Whamp)](https://github.com/Whamp).

## [0.4.3] - 2026-08-17

### Added

- Added an optional screen-reader text mirror for visible terminal contents, with bounded updates
  and concealed-cell filtering. [PR #64](https://github.com/kcosr/herdr-web/pull/64), based on the
  concept proposed by
  [shuv (@shuv1337)](https://github.com/shuv1337) in
  [PR #37](https://github.com/kcosr/herdr-web/pull/37).

### Fixed

- Improved keyboard focus behavior for dialogs and action menus: modal focus stays contained,
  menus support arrow, Home, and End navigation, Tab exits menus normally, and dismissing an
  overlay restores its opener. [PR #62](https://github.com/kcosr/herdr-web/pull/62), based on work
  proposed by [shuv (@shuv1337)](https://github.com/shuv1337) in
  [PR #37](https://github.com/kcosr/herdr-web/pull/37).

## [0.4.2] - 2026-08-15

### Added

- Added `npm run dev` to supervise the bridge and Vite HMR server together, wait for bridge
  readiness, proxy API and WebSocket traffic, and stop both processes cleanly.
  [PR #57](https://github.com/kcosr/herdr-web/pull/57), based on work proposed by
  [Hopkins (@LosEcher)](https://github.com/LosEcher) in
  [PR #51](https://github.com/kcosr/herdr-web/pull/51).
- Declared the existing Herdr logo as the browser favicon.
  [PR #56](https://github.com/kcosr/herdr-web/pull/56), contributed by
  [Craig P. Motlin (@motlin)](https://github.com/motlin).

### Changed

- Static bridge responses now explicitly revalidate HTML and public files while caching successful
  content-hashed Vite assets as immutable. Error responses are never marked immutable.
  [PR #57](https://github.com/kcosr/herdr-web/pull/57), based on work proposed by
  [Hopkins (@LosEcher)](https://github.com/LosEcher) in
  [PR #51](https://github.com/kcosr/herdr-web/pull/51).

### Fixed

- Fixed CJK and other IME terminal input so preedit stays local, committed text is sent exactly
  once, canceled composition is discarded, and the candidate window and visible preedit stay near
  the terminal cursor. [PR #58](https://github.com/kcosr/herdr-web/pull/58), based on work proposed
  by [Hopkins (@LosEcher)](https://github.com/LosEcher) in
  [PR #51](https://github.com/kcosr/herdr-web/pull/51).
- Fixed icons rendering slightly off-center in square icon buttons (sidebar section header
  actions and the tab bar's new-tab button) by resetting the user-agent button padding, and
  removed the per-icon transform that compensated for it.
  [PR #55](https://github.com/kcosr/herdr-web/pull/55), contributed by
  [Philippe SEGATORI (@tigitz)](https://github.com/tigitz).

## [0.4.1] - 2026-08-05

### Breaking Changes

- Herdr `v0.8.0` or newer with terminal protocol exactly `19` is now required. The bridge rejects
  the previous protocol `17` baseline and other unreviewed protocols instead of attempting a
  backward-compatible wire fallback. [PR #48](https://github.com/kcosr/herdr-web/pull/48)

### Added

- Added a contextual Move Space mode to the Spaces menu. The selected space card becomes draggable,
  retains a cancel control and arrow/Home/End keyboard support, mutes unrelated sidebar actions
  until the move is completed or canceled, and moves worktree groups atomically within their host's
  canonical workspace order. [PR #48](https://github.com/kcosr/herdr-web/pull/48)
- Added persistent expand/collapse controls to grouped Agents, Tabs, and Spaces headers, including
  independent, visually nested host and workspace controls for Host + workspace grouping and a
  bulk expand/collapse control for the current Agents or Tabs list.
  [PR #47](https://github.com/kcosr/herdr-web/pull/47)
- Added a default-off Display setting that combines same-named workspaces across hosts when using
  Workspace grouping, while retaining host context on each agent or pane row.
  [PR #47](https://github.com/kcosr/herdr-web/pull/47)

### Changed

- Refreshed the minimal vendored Herdr compatibility sources to the `v0.8.0`/protocol `19`
  baseline, including the current API schemas, terminal wire definitions, and input model shims.
  [PR #48](https://github.com/kcosr/herdr-web/pull/48)
- Follow Herdr's canonical workspace order when atomic worktree groups are reordered.
  [PR #48](https://github.com/kcosr/herdr-web/pull/48)
- Simplified Workspace grouping in the Agents and Tabs sidebars to show workspace-only group
  headers and move host context into each detail row. Host + workspace grouping keeps its nested
  host and workspace headers. [PR #47](https://github.com/kcosr/herdr-web/pull/47)

### Fixed

- Fixed built-in agent launches against Herdr `v0.8.0` by waiting for a newly created pane's shell
  to become available before starting the managed agent.
  [PR #48](https://github.com/kcosr/herdr-web/pull/48)

## [0.4.0] - 2026-07-30

### Breaking Changes

- Herdr `v0.7.5` or newer with terminal protocol exactly `17` is now required. The bridge rejects
  older protocol `16` daemons and unreviewed newer protocols rather than attempting a
  backward-compatible wire fallback. [PR #45](https://github.com/kcosr/herdr-web/pull/45)
- Removed the obsolete `custom_status` field from bridge snapshots and activity events; agent
  presentation now uses Herdr's `state_labels`, title, display-agent, and status fields.
  [PR #45](https://github.com/kcosr/herdr-web/pull/45)
- Changed the default ungrouped Tabs and Spaces sidebar presentation to compact rows with inline
  host, Space, and tab context instead of contextual headers. Agent panes in Tabs also use the
  Agents row presentation and agent-aware ordering by default. Choose a grouping mode to restore
  contextual headers, or disable Agent features in Tabs to restore generic pane rows and the
  original tab order. [PR #41](https://github.com/kcosr/herdr-web/pull/41)

### Added

- Added a default-on client-local Sync navigation setting. Browser tabs and windows with sync off
  can view different panes through the same bridge without publishing or following shared pane
  selection or changing Herdr's focused tab through ordinary navigation.
  [PR #42](https://github.com/kcosr/herdr-web/pull/42)
- Added default-on Agent features in Tabs, including consistent Agents row metadata and pin
  placement, agent-aware sorting, and pinned-only and active-only filters. Non-agent tabs remain
  visible at the bottom of agent-aware sorts; disabling the setting restores generic pane rows.
  [PR #41](https://github.com/kcosr/herdr-web/pull/41)
- Added multi-host Spaces controls: Spaces can be shown as a flat list with host context or grouped
  under host headers, and the default-on Multi-host Space selection setting can be disabled to limit
  Space-scoped Agents, Tabs, and Notes to one globally selected Space. All scope remains unchanged.
  [PR #41](https://github.com/kcosr/herdr-web/pull/41)

### Changed

- Refreshed the minimal vendored Herdr compatibility sources to the `v0.7.5`/protocol `17` baseline,
  including the current API schemas and terminal wire definitions.
  [PR #45](https://github.com/kcosr/herdr-web/pull/45)
- Updated launching for Herdr `v0.7.5`: built-in agents use the managed `agent.start` flow after the
  destination pane is created. The bridge waits for interactive readiness and rolls back its new
  tab or pane after rejection, early process exit, or timeout. Custom launcher presets continue to
  execute their exact configured `argv`. [PR #45](https://github.com/kcosr/herdr-web/pull/45)
- Store the Sync navigation setting browser-wide while keeping sync-off pane selections only in
  memory. The app no longer creates per-tab navigation storage records.
  [PR #43](https://github.com/kcosr/herdr-web/pull/43)
- Simplified agent-row metadata by removing generic status text already communicated by the status
  indicator and badge, while retaining bridge-defined state labels.
  [PR #41](https://github.com/kcosr/herdr-web/pull/41)

### Fixed

- Cleared and remounted the mobile terminal command field after Send or Stage so stale native input
  cannot prefix the next command. [PR #44](https://github.com/kcosr/herdr-web/pull/44), with an
  earlier implementation contributed by
  [Alexander Makarov (@AlexanderMakarov)](https://github.com/AlexanderMakarov) in
  [PR #38](https://github.com/kcosr/herdr-web/pull/38).
- Fixed client-local navigation synchronization across reloads, reconnects, lagging snapshots, and
  rapid multi-client selection races. Sync-off split navigation now stays local, and independent
  clients no longer rewrite shared navigation persistence. After a bridge restart, the focused
  Herdr pane now seeds shared navigation so synced clients immediately converge.
  [PR #43](https://github.com/kcosr/herdr-web/pull/43)

## [0.3.3] - 2026-07-19

### Added

- Added Grok and OpenCode agent icons in the Agents sidebar and create-menu launch choices.
  [PR #36](https://github.com/kcosr/herdr-web/pull/36)
- Added built-in launcher presets for Grok and OpenCode (`builtin:grok`, `builtin:opencode`).
  [PR #36](https://github.com/kcosr/herdr-web/pull/36)
- Added optional `builtins` allowlist/order in `launcher-presets.json` so the create menu can show a
  subset of built-ins without PATH probing. Omitting `builtins` keeps the full default set; `[]`
  hides all built-ins (custom presets still appear). Short names (`shell`) and full ids
  (`builtin:shell`) are accepted; unknown entries warn and are ignored.
  [PR #36](https://github.com/kcosr/herdr-web/pull/36)

### Fixed

- Kept the first selected character anchored during mobile endpoint dragging, aligned the loupe caret
  with the selected row, and centered a hollow drag handle over the anchored character.
  [PR #35](https://github.com/kcosr/herdr-web/pull/35)

## [0.3.2] - 2026-07-07

### Breaking Changes

- Users must upgrade Herdr to `v0.7.2` or newer before upgrading herdr-web. The bridge now requires
  a Herdr daemon with protocol `16` because browser snapshots use Herdr's native
  `session.snapshot` API.
  [PR #32](https://github.com/kcosr/herdr-web/pull/32)

### Added

- Added an Agents-view active-status filter that shows only agents currently
  marked working, blocked, or done, with grouped views hiding empty groups after
  filtering. [PR #31](https://github.com/kcosr/herdr-web/pull/31)

### Changed

- Refreshed the vendored Herdr compatibility baseline to `v0.7.2`, including protocol `16`, native
  session snapshots, layout/scroll event schema drift, and terminal observe/control wire messages.
  [PR #32](https://github.com/kcosr/herdr-web/pull/32)
- Changed `/api/snapshot` to use one native Herdr `session.snapshot` request instead of separate
  workspace, tab, pane, and per-tab layout requests.
  [PR #32](https://github.com/kcosr/herdr-web/pull/32)

## [0.3.1] - 2026-07-03

### Added

- Added bridge-owned configurable launcher presets for the create menu, including argv-based custom
  agent commands, optional Herdr agent hints, and horizontally scrollable launch choices.
  [PR #30](https://github.com/kcosr/herdr-web/pull/30)
- Documented macOS x86_64 desktop tarball support alongside Linux x86_64 and macOS ARM64 release
  artifacts.
  [PR #30](https://github.com/kcosr/herdr-web/pull/30)
- Refreshed the vendored Herdr compatibility baseline to `v0.7.1` for launcher preset agent hints.
  [PR #30](https://github.com/kcosr/herdr-web/pull/30)

### Fixed

- Fixed mobile sidebar space selection so tapping a space updates the scoped Tabs list instead of
  snapping back to tabs from the previously selected pane.
  [PR #29](https://github.com/kcosr/herdr-web/pull/29)
- Fixed a bridge reattach race where a client reconnecting right after the last viewer left a
  terminal could be rejected by the daemon with `already has an attached client` and shown a
  permanent `Attached elsewhere` error; the bridge now shuts detached attach connections down and
  reattaches only after the pending detach has been delivered.
  [PR #26](https://github.com/kcosr/herdr-web/pull/26)
- Stopped detached terminal attach connections from leaking a blocked reader thread and an open
  socket on both the bridge and daemon sides after every pane switch.
  [PR #26](https://github.com/kcosr/herdr-web/pull/26)
- Serialized concurrent first attaches per terminal in the bridge and made the web client briefly
  retry `already has an attached client` rejections, so multiple viewers reconnecting at once
  (for example after a bridge restart) no longer strand a terminal on a permanent
  `Attached elsewhere` error. The bridge also now logs daemon-initiated attach connection closes,
  which were previously recorded nowhere.
  [PR #26](https://github.com/kcosr/herdr-web/pull/26)

## [0.3.0] - 2026-07-02

### Added

- Added an `Add note` action to pane and agent sidebar context menus, opening a quick-create
  dialog with a focused title and optional body that attaches the new note to the target pane.
  [PR #24](https://github.com/kcosr/herdr-web/pull/24)
- Added Mobile settings for an expanding terminal command input and Enter-as-newline
  editing, allowing long prompts to wrap and remain viewable while preserving send-on-Enter
  by default. [PR #21](https://github.com/kcosr/herdr-web/pull/21)
- Added bridge-tracked agent status transition activity with an Agents view sort option for
  `Last status change`, using semantic status changes rather than terminal output activity.
  [PR #23](https://github.com/kcosr/herdr-web/pull/23)
- Added server-side agent pins with pinned-first agent ordering, a pinned-only sidebar toggle, and
  a selected-pane header toggle plus a small pinned indicator on pinned agent rows.
  [PR #22](https://github.com/kcosr/herdr-web/pull/22)
- Added bridge-owned pane notes with a sidebar Notes view, desktop/mobile notes editor, pane
  attachment recovery states, and per-bridge note synchronization. Notes are exposed through the
  same bridge request policy as terminal controls, so allowed bridge clients can read and mutate
  saved note content. [PR #20](https://github.com/kcosr/herdr-web/pull/20)
- Added a Notes feature toggle plus persisted desktop notes panel sizing, notes list collapse
  state, notes panel open state, pane note tabs, and a dedicated Other notes list.
  [PR #20](https://github.com/kcosr/herdr-web/pull/20)
- Added a Markdown preview mode for notes that remembers Edit/Preview preference locally and keeps
  the Markdown renderer lazy-loaded until preview is used. [PR #20](https://github.com/kcosr/herdr-web/pull/20)

### Changed

- Unified the `session_key` reported by `/api/agent-activity` with the notes and agent-pins
  endpoints (`session:default` and FNV-1a socket hashes instead of a divergent local format).
  [PR #25](https://github.com/kcosr/herdr-web/pull/25)
- Extended the pinned-only sidebar toggle to the Tabs view so pinned panes can be found outside the
  Agents view. [PR #23](https://github.com/kcosr/herdr-web/pull/23)
- Notes created from the notes panel now open in Edit mode with the title selected, so the default
  title can be replaced immediately. [PR #24](https://github.com/kcosr/herdr-web/pull/24)

### Fixed

- Made the bridge close and cleanly reattach terminal sockets that fall behind fast output instead
  of silently dropping frames and corrupting the rendered stream.
  [PR #25](https://github.com/kcosr/herdr-web/pull/25)
- Moved the bridge's remaining blocking daemon round-trips (snapshot, selection, agent activity,
  rename-label lookups) off async worker threads, so a stalled daemon no longer freezes unrelated
  requests and terminal websockets.
  [PR #25](https://github.com/kcosr/herdr-web/pull/25)
- Bounded the bridge's per-terminal input queue so a client sending faster than the pty drains no
  longer grows bridge memory without limit.
  [PR #25](https://github.com/kcosr/herdr-web/pull/25)
- Fixed terminal session races where a client connecting while the previous one disconnected could
  be handed an already-detached session, and where the daemon handshake blocked all other terminal
  clients.
  [PR #25](https://github.com/kcosr/herdr-web/pull/25)
- Stopped the bridge from silently tightening permissions on a pre-existing operator-supplied
  `--upload-dir`; only directories the bridge creates itself are set to 0700.
  [PR #25](https://github.com/kcosr/herdr-web/pull/25)
- Applied the standard 120-byte label validation to `pane.rename` requests, matching every other
  rename/create command.
  [PR #25](https://github.com/kcosr/herdr-web/pull/25)
- Stopped a cancelled terminal mount from leaking an orphaned renderer and duplicated canvas when
  the pane changes while the terminal module is still loading.
  [PR #25](https://github.com/kcosr/herdr-web/pull/25)
- Made single-cell touch selections highlight correctly instead of silently storing a wrong
  scrollback row.
  [PR #25](https://github.com/kcosr/herdr-web/pull/25)
- Preserved combining characters and multi-codepoint emoji when copying terminal text via touch
  selection.
  [PR #25](https://github.com/kcosr/herdr-web/pull/25)
- Kept the selected note open while no pane is selected, so notes no longer deselect mid-edit when
  a bridge disconnects, has zero panes, or a notes refresh lands.
  [PR #25](https://github.com/kcosr/herdr-web/pull/25)
- Made Escape in settings number fields discard the typed value instead of committing it, and stop
  it from closing the whole settings dialog; out-of-range numbers now snap back to the clamped
  value in the field.
  [PR #25](https://github.com/kcosr/herdr-web/pull/25)
- Reordered Android hardware-back handling so open menus and dialogs close before the notes panel
  underneath them.
  [PR #25](https://github.com/kcosr/herdr-web/pull/25)
- Made Escape cancel the rename dialog from any focused control, not just the text input.
  [PR #25](https://github.com/kcosr/herdr-web/pull/25)
- Extended long-press text-selection prevention to the stage header pane title.
  [PR #25](https://github.com/kcosr/herdr-web/pull/25)
- Restored the intended drop shadow and muted URL color on the terminal selection sheet, which
  referenced undefined CSS variables.
  [PR #25](https://github.com/kcosr/herdr-web/pull/25)
- Validated agent-pins responses at the fetch boundary so a malformed bridge response degrades
  gracefully instead of crashing the sidebar render.
  [PR #25](https://github.com/kcosr/herdr-web/pull/25)
- Prevented sidebar row labels and terminal tab labels from being text-selected during long-press
  context-menu gestures. [PR #24](https://github.com/kcosr/herdr-web/pull/24)
- Fixed notes editor selection and autosave edge cases so switching to panes without notes clears
  the editor, deleting the selected note no longer shows a deleted note, and stale local save
  refreshes do not appear as external note changes. Also fixed mobile delete-dialog back handling
  and unresolved note recovery actions in the notes panel. [PR #20](https://github.com/kcosr/herdr-web/pull/20)
- On mobile, kept the note editor's terminal action available for the current pane and made it
  close the full-screen notes surface. [PR #20](https://github.com/kcosr/herdr-web/pull/20)
- Changed mobile notes back navigation so back closes the notes surface from the editor, while a
  separate header button shows the notes list. [PR #20](https://github.com/kcosr/herdr-web/pull/20)
- Kept the new-tab button pinned at the right edge of the top tab bar while the tab list scrolls.
  [PR #20](https://github.com/kcosr/herdr-web/pull/20)
- Improved terminal reconnect/resume handling so Android foregrounding and quick terminal switches
  keep the renderer stable, avoid stale tab flashes, and suppress transient connecting overlays.
  [PR #19](https://github.com/kcosr/herdr-web/pull/19)

## [0.2.1] - 2026-06-20

### Added

- Added a Terminal font size setting. [PR #16](https://github.com/kcosr/herdr-web/pull/16)
- Added desktop click-to-open support for detected HTTP(S) terminal URLs.
  [PR #16](https://github.com/kcosr/herdr-web/pull/16)

### Changed

- Added a Mobile setting for long-press behavior, with Off, Copy, and Loupe modes; Loupe uses a
  two-stage endpoint flow, selected URLs keep the action sheet, and tapped HTTP(S) URLs open
  directly; original mobile selection work contributed by Will Hampson.
  [PR #16](https://github.com/kcosr/herdr-web/pull/16)

### Fixed

- Fixed Android/tablet bridge color picker dismissal so saving a backend after choosing a color
  keeps the Settings dialog open. [PR #16](https://github.com/kcosr/herdr-web/pull/16)
- Fixed sidebar keyboard shortcuts so agent and tab navigation follows the visible host/sidebar
  order across selected-host and all-host views. [PR #18](https://github.com/kcosr/herdr-web/pull/18)

## [0.2.0] - 2026-06-19

### Added

- Added multi-bridge connections, allowing multiple saved bridges to stay enabled at once with
  server chips and an all-agents sidebar overview. [PR #17](https://github.com/kcosr/herdr-web/pull/17)
- Added a bridge `--allow-connect-origin` option so bridge-served web pages can opt into connecting
  to other trusted bridge origins without relaxing the default Content Security Policy.
  [PR #17](https://github.com/kcosr/herdr-web/pull/17)
- Added a Host + workspace grouping option for agent lists.
  [PR #17](https://github.com/kcosr/herdr-web/pull/17)
- Added configurable bridge colors with a mobile-friendly color picker.
  [PR #17](https://github.com/kcosr/herdr-web/pull/17)

### Changed

- Moved sidebar agent/tab sorting and grouping controls into a vertical options menu, and removed
  redundant host prefixes from grouped tab labels. [PR #17](https://github.com/kcosr/herdr-web/pull/17)

## [0.1.2] - 2026-06-18

### Added

- Added a bridge-owned agent activity stream so pane status, title, display agent, and custom
  status updates reach connected browsers without waiting for a full snapshot refresh; concepts
  derived from the @roy-levi-amazon fork. [PR #11](https://github.com/kcosr/herdr-web/pull/11)
- Added Display settings for top/bottom app padding and mobile terminal controls size.
  [PR #13](https://github.com/kcosr/herdr-web/pull/13)
- Added configurable terminal input transport, with binary payload concepts derived from the
  @roy-levi-amazon fork. [PR #12](https://github.com/kcosr/herdr-web/pull/12)
- Added opt-in terminal input batching controls with a fixed 32-byte flush threshold for slow
  connections. [PR #12](https://github.com/kcosr/herdr-web/pull/12)
- Added a Shift-Tab key to the expanded mobile terminal key panel. [PR #11](https://github.com/kcosr/herdr-web/pull/11)

### Changed

- Coalesced fast terminal output bursts in the bridge before forwarding them to browser clients,
  with a per-client Terminal output batching setting for tuning frame churn during rapid TUI
  redraws; concepts derived from the @roy-levi-amazon fork.
  [PR #14](https://github.com/kcosr/herdr-web/pull/14)
- Reworked Settings into Bridge, Terminal, and Mobile areas, with horizontal area tabs on narrow
  screens. [PR #12](https://github.com/kcosr/herdr-web/pull/12)
- Improved browser startup by lazy-loading the terminal renderer with retry after load failures,
  adding installable mobile web app metadata and raster icons, and compressing static
  bridge-served web assets; concepts derived from the @roy-levi-amazon fork.
  [PR #10](https://github.com/kcosr/herdr-web/pull/10)

## [0.1.1] - 2026-06-17

### Breaking Changes

### Added

- Added a native Android setting, on by default, to blur text inputs and refit the terminal after
  the keyboard closes.
- Added an opt-in mobile terminal long-press selection setting with drag-to-copy selection, selected
  URL actions, and touch hit-testing for Ghostty-detected links.

### Changed

- Changed bridge URL validation so users can save HTTP bridge URLs at any valid host or IP address.

### Fixed

- Forced and reapplied Android dark system bar styling with light status/navigation bar icons.
- Removed duplicate bottom safe-area padding inside the mobile terminal controls.

### Removed

## [0.1.0] - 2026-06-16

### Added

- Initial release.

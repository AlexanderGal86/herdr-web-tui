# Herdr TUI appearance

This checkout adds a default **Herdr TUI** appearance to [kcosr/herdr-web](https://github.com/kcosr/herdr-web), based on the interactive session illustration at [herdr.dev](https://herdr.dev/). Upstream base: `f1312e2ffbe8d5b62db57ced66c3c56c4cdebdfb`.

## Use

Open **Settings → Display → Appearance** and choose **Herdr TUI** or **Web**. The selection persists in this browser and synchronizes with other tabs on the same origin. Existing navigation/layout preferences are preserved. Fresh TUI installations use a 240px resizable sidebar and the All scope, displaying workspaces and agents together. The original Web layout remains selectable.

The terminal and interface use the bundled JetBrains Mono Nerd Font in TUI appearance; no external font service is needed. Changing the appearance remeasures existing terminals without replacing their connections. All existing menus, shortcuts, pane splits, notes, uploads, bridge settings and mobile controls remain available.

## Linux startup

Requirements: Node.js 24.x, npm, Rust stable, and a platform C toolchain. With Herdr already running under the same user:

```bash
npm ci --prefix web
npm run build
HOST=127.0.0.1 PORT=8787 bash scripts/run-bridge.sh
```

The existing wrapper selects `${XDG_CONFIG_HOME:-$HOME/.config}/herdr/herdr.sock`, respects an explicit `HERDR_SOCKET_PATH`, and serves the production assets at `http://127.0.0.1:8787`. For a remote Linux host, use SSH forwarding as documented in the [README](../README.md). This fork's Linux runtime is verified as of 2026-10-28; see
[Linux verification (2026-10-28)](#linux-verification-2026-10-28) below.

## Linux verification (2026-10-28)

Verified on Linux with the bridge and web UI built from the same commit, exercised against a
live bridge serving the production `web/dist` over TLS:

- Frontend: ESLint clean; **506 tests across 56 files** passed; `tsc -b` clean; debug build
  succeeded; an isolated Vite production build completed with zero errors and warnings.
- Bridge: **237 passed / 1 ignored**; vendored compatibility crate: **146 tests passed**;
  Rust formatting clean.
- Machine-runtime selection regression (before/after in a real browser): with the previously
  deployed bundle the machine selector reset to the local bridge; with the new bundle,
  Local → saved machine → Local → saved machine switches keep the selected runtime sticky.
- Real upload through the GUI file input to a selected machine's
  `/api/machines/{id}/uploads`: HTTP 200; the 73-byte payload was verified byte-identical by
  SHA-256 directly on the target host; the committed file had mode `600` inside a `700`
  uploads directory; the fixture was removed on both hosts afterwards. During the upload the
  queued remote path was captured for the terminal instead of being typed into the user's live
  PTY, and Input/Resize broadcasts stayed blocked with takeover false.
- The temporary test stand and tunnel were stopped afterwards; the native binary, its
  configuration files, the live `web/dist`, and native Herdr focus were left unchanged.

Machine routing and remote-upload details: [native-machines-and-uploads.md](native-machines-and-uploads.md).
The dated Windows results below are retained as history.

## Windows startup

From the repository root, with Herdr already running:

```powershell
npm ci --prefix web
npm run build
.\scripts\start-tui.ps1
```

Open `http://127.0.0.1:8787`. The startup script binds only to loopback and points debug bridge builds at the stable `%APPDATA%\herdr\herdr.sock` endpoint. It respects `HERDR_SOCKET_PATH` and accepts `-Port 8788`. For `-Session NAME`, first set `$env:HERDR_CONFIG_DIR = Join-Path $env:APPDATA 'herdr'` (or your actual configuration directory): the compatibility crate does not automatically select APPDATA, and an explicit session ignores `HERDR_SOCKET_PATH`. It does not start, stop or replace the Herdr daemon. Runtime notes, pins, and uploads created by the bridge in the working directory are ignored by Git.

For frontend development on Linux, run `npm run dev` using the upstream launcher. On Windows, its Node.js `spawn("npm.cmd", ...)` call fails with EINVAL; use two terminals instead: `.\scripts\start-tui.ps1` for the bridge and `npm run dev:web` for Vite. See the [root README](../README.md) for installation from the GitHub repository, platform requirements, updates, and bridge options. The [original README](../README.upstream.md) is retained separately as upstream reference, not as the platform-specific guide for this fork.

## Visual preview

Run `npm run dev:web` and open `http://127.0.0.1:5173/theme-preview.html`. This development-only entry renders the real application with three sample workspaces, four agent states and a split terminal. A persistent banner identifies the fixture. Selections work locally; terminal input, commands, uploads and outgoing bridge requests are refused. Preview settings are isolated from your real client. This page is excluded from the default production build.

## Reference investigation

The public website hero is a **DOM mock**, not a connected terminal client. Inspected its HTML, inline selection handlers and browser-computed styles on 2026-09-30. Clicking workspaces/tabs/agents changes active elements; a timer animates working status. Its dialogue and command text were treated as sample output, not instructions.

| Element | Reference value | Implementation |
| --- | --- | --- |
| Terminal | `#11111b` | Existing Ghostty canvas and surrounding frame |
| Sidebar | `#181825` | Two equal scrollable sections on desktop |
| Selection/tab strip | `#1e1e2e` | Flat, square rows and tabs |
| Focus/active tab | `#cba6f7` | Thin frame; filled active tab |
| Border | `#313244` | 1px frame and separators |
| Text | `#cdd6f4` | Monospace labels and terminal text |
| Muted text | `#6c7086`, `#9399b2` | Secondary labels |
| Status | Yellow/pink/green/teal | Working/blocked/idle/done indicators |
| Font | JetBrains Mono | Bundled local Nerd Font variant |

The website scales a fixed illustration with its width. This app uses readable text, a resizable sidebar, independently scrollable lists and touch-sized controls in compact mode. Auxiliary actions are retained in a compact footer. Terminal contents come from actual sessions, so their text, branch labels and agent-specific colors naturally differ from the screenshot.

## Implementation

- `web/src/herdr-tui.css`: scoped visual overrides; no generic global restyling of Web appearance.
- `web/src/appearance.ts`, `AppearanceSetting.tsx`: persistent preference and accessible selector.
- `web/src/App.tsx`: TUI default layout, workspaces in All scope and split captions.
- `web/src/terminalRenderer.ts`, `TerminalView.tsx`: font selection and remeasurement without reconnecting.
- `web/src/paneContextMenu.ts`, `TerminalView.tsx`, `App.tsx`: terminal context menus in both appearances, capability filtering, captured pane identity and local right-click passthrough. Shift+right-click, Shift+F10 and the ContextMenu key recover the menu. Passthrough resets on reload and does not alter native Herdr preferences. The current menu offers rename/clear name, swap, split, clipboard paste, `Restore split layout` only while a tab is already zoomed (the separate `Zoom` entry was removed), the right-click passthrough toggle, and close.
- `web/src/terminalRenderer.ts`, `TerminalView.tsx`: structured mouse reports are forwarded to the pane app only in panes opted into right-click passthrough (`setMousePassthrough`, synced from the pane setting and every `mouse_mode` frame). Every other pane keeps native browser mouse behavior — drag-select, wheel scrollback, right-click copy/menu — even when the app enables mouse tracking (pi, vim, htop); Shift gestures stay native everywhere.
- `bridge/src/web_bridge.rs`: the allow-list now exposes `pane.zoom` with an explicit pane ID and `pane.swap` with two distinct explicit IDs; implicit/directional swap requests are rejected. The protocol and compatibility crate are unchanged. Upgrade the bridge together with the frontend to enable these two menu actions.

## Terminal menu verification (Windows, 2026-10-01)

Clipboard follow-up: mouse selection copy was verified against the real Ghostty canvas and browser clipboard. Middle-button paste uses `Terminal.paste` (including bracketed paste), selects/focuses the clicked pane, and checks renderer/socket identity after asynchronous clipboard permission. Preview input was refused as intended, with no live terminal writes. Reading clipboard requires a browser-supported secure context (HTTPS or localhost) and permission. Unit tests cover one paste per pointer/mouse gesture, stale targets, rejected clipboard access, and focus/activation.

- Frontend lint, all **454 tests** and the production build passed. Rust format, bridge build and the Git Bash vendor check passed. New zoom/swap validation tests pass.
- Independent specification and code reviews found no blockers. Dialog submissions also revalidate connection, terminal identity and command capability.
- Isolated preview: right-click on an inactive split pane, correct rename target, close confirmation/cancel, passthrough and Shift recovery, Shift+F10, Escape/focus return, and both appearances verified. Zoom reaches the preview's intentional mutation refusal. No real terminal actions were executed. Browser warning/error logs were empty. Screenshot: [terminal menu](images/terminal-context-menu.png).
- Full bridge run: **137 passed / 17 failed**; the existing Windows notes/pins replacement failures and HOME-dependent workspace test remain. The root `npm run check` still stops at the Windows shell's direct `.sh` invocation; the vendor check passes through Git Bash. Temporary preview was stopped; ports 5173, 5174 and 8787 have no listeners.

## Original theme verification (Windows, 2026-09-30)

- Frontend ESLint: passed. Vitest: **440 tests passed**, including preference persistence, preview isolation, terminal connection retention and drag-scroll regression checks.
- TypeScript and Vite production build: passed. The existing Ghostty bundle size warning remains. Confirmed `theme-preview.html` is absent from production output.
- Rust bridge: built successfully; live snapshot and capabilities return HTTP 200. The production page renders the existing Herdr 0.9.1 / protocol 22 terminal; browser error/warning logs are empty.
- Compatibility crate: **141 tests passed**. Both Rust format checks passed. Vendor layout check passed through Git Bash.
- Browser: TUI/Web switching, agent-to-workspace navigation, split captions, compact view at 390 × 844 and return to switcher verified. Screenshot: `docs/images/herdr-tui-preview.png` (sample sessions).
- Source review: clipping, drag scrolling and agent-context findings were fixed and re-reviewed; no outstanding findings.

The entire upstream check is **not green on Windows**: `npm run check` first stops because npm's Windows shell cannot execute `scripts/check-vendor.sh` directly. The vendor check passes when invoked explicitly through Git Bash. The latest unchanged bridge tests finish with **136 passed / 16 failed**, all failures in Windows notes/pins file replacement. An earlier run finished with 135 passed / 17 failed, including a test requiring `HOME`; the count depends on the shell environment. Retrying file replacement failures outside the sandbox did not resolve them. Unchanged development/release script tests previously finished with 4 passed / 7 failed because their executable/shebang mocks and `npm` spawning assume Unix. These files were not modified for the theme. Before the OneDev publication, frontend lint, all 440 tests, the production build, the Rust bridge build, both Rust format checks, and the explicit Git Bash vendor check were rerun successfully. This is a verified theme/frontend build and live connection, not a claim that upstream Windows packaging or every backend feature is fully validated.

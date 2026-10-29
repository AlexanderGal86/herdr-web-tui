# Saved SSH machines, workspace zones, and remote uploads

This document describes saved-machine routing, Local/Remote workspace zones, and two-stage SCP
uploads in `herdr-web`: what the bridge guarantees, which parts are operator-configured, and which
limits are known and accepted rather than fixed. None of this modifies native Herdr — its
updates, plugins, sockets, and panes are untouched — and machine ROUTING installs nothing on
remote machines; the one registration path below delegates to the `herdr machine add` CLI,
whose remote setup behavior is the CLI's own documented one (see "Adding machines").

## Discovery: the operator's machine catalog

- The bridge reads Herdr's own client state, `~/.local/state/herdr/client/endpoints.json`,
  re-read on every request, so machines saved or enabled through Herdr appear without a bridge
  restart. A missing or corrupt catalog yields the local bridge alone.
- The catalog is authoritative for machine ROUTING: the browser never supplies hostnames, users,
  ports, or paths for an existing machine — the machine-scoped routes resolve saved machine IDs
  only. The single exception is the explicit registration route below, which accepts a target
  but forwards it to the operator's own `herdr machine add` CLI as a validated argv vector (the
  CLI necessarily contacts the target to prepare it — that is its documented setup, outside the
  bridge's machine-scoped routing, and the bridge itself still never routes traffic to a target
  that is not in the saved catalog).
- The catalog always contains the serving bridge itself (`local`) plus each enabled saved SSH
  machine; disabled entries are not served.

## Adding machines from the browser

`POST /api/machines/add` (same `machines` capability, gated in the UI behind a plus button so the
first connection is addable from an empty tree) accepts `{ target, label?, session? }` and runs
the native `herdr machine add` CLI on the bridge host as a plain argv vector — no shell, stdin
closed, 300 s timeout that SIGKILLs the CLI's whole process group on expiry:

- Validation happens twice, at the handler (trim; blank optional fields fall back to CLI
  defaults) and at the runner boundary: targets/labels/sessions that are empty, start with `-`,
  or contain control characters are rejected with 400 before anything is spawned.
- Registration follows the CLI's documented flow using the bridge host's existing SSH access. The
  bridge itself stores nothing, adds no SSH keys, and does not touch authentication or host-key
  checking — those stay with OpenSSH. Steps the CLI reserves for interactive confirmation
  (installing or replacing the remote server) cannot be confirmed non-interactively and fail with
  the CLI's own error text, returned to the browser as `502 { "error": "machine add failed: …" }`
  (the CLI stderr tail; older bytes beyond a bounded window are discarded).
- On success the route answers with the freshly read catalog (`GET /api/machines` shape), so the
  new machine appears in the sidebar tree immediately.
- Override caveat (fail closed): the CLI always writes the operator's real Herdr client state
  (the native `endpoints.json` under the bridge user's `HOME`). When
  `HERDR_WEB_MACHINES_ENDPOINTS` relocates the catalog the bridge reads, the route refuses with
  `503 { "error": "machine add is unavailable: …" }` BEFORE invoking the CLI — no registration
  runs and no file outside the served catalog is touched. Deployments that relocate the catalog
  must register machines through the CLI directly.

## Disabling machines from the browser

`POST /api/machines/{machine_id}/disable` (same `machines` capability) is the browser-exposed
equivalent of the operator running the native `herdr machine disable <PROFILE_ID>` CLI on the
bridge host. The web TUI offers it from a saved machine's group context menu (right-click on
the group name) behind a confirmation dialog. The route takes no body and runs the CLI as a
plain argv vector — no shell, stdin closed, the same 300 s timeout and whole-process-group
teardown as machine add:

- The machine id is resolved against the freshly read catalog BEFORE anything is spawned: the
  local machine is refused with 400 (`cannot disable the local machine`), an already-disabled
  profile with 400 (`machine is disabled: …`), and unknown or option-like/invalid ids with 404.
  The runner boundary re-validates the id and rejects anything option-like or control-bearing,
  so a profile id can never become CLI options.
- A CLI failure answers `502 { "error": "machine disable failed: …" }` with the CLI's own
  stderr tail (capped, like machine add).
- The saved profile is retained in Herdr's client state — disabling only flips its enabled
  flag in the native catalog, so the machine leaves `GET /api/machines` and all machine-scoped
  routes (they already fail closed on disabled entries), and re-enabling stays a native CLI
  operation on the bridge host. The bridge itself never edits `endpoints.json`, SSH trust, or
  keys.
- Override caveat (fail closed, same as machine add): when `HERDR_WEB_MACHINES_ENDPOINTS`
  relocates the catalog the bridge reads, the route refuses with
  `503 { "error": "machine disable is unavailable: …" }` BEFORE invoking the CLI.
- The route passes the same Host allowlist, Origin handling, and OPTIONS preflight as every
  other bridge route, so the behavior applies to all bridge clients. Deployments gain it only
  by deploying a bridge binary from a source that includes it.

## Routing and capabilities

Machine-scoped routes are same-origin routes on the serving bridge:

- `GET /api/machines` — the machine list (`machines` capability, version 1).
- `POST /api/machines/add` and `POST /api/machines/{machine_id}/disable` — registration and
  disabling through the native `herdr machine` CLI (see above).
- `/api/machines/{machine_id}/snapshot`, `/capabilities`, `/command`, `/selection`, and
  `POST /api/machines/{machine_id}/uploads?name=…`
- `/api/machines/{machine_id}/ws/events` and `/api/machines/{machine_id}/ws/terminal`

All machine data flows through these routes: snapshot, browser commands (the same allow-list as
the local bridge), pane selection, events, and terminal attach are forwarded to the target
machine over Herdr's hidden `remote-api-bridge` / `remote-client-bridge` commands, run as
transient stdio transports over plain `ssh`. No remote daemon is installed or started beyond that
transient transport.

Before a machine is served, the bridge probes the remote capability marker `herdr-api-bridge-v1`.
Unknown, disabled, unsupported, and unreachable machines fail closed: the request is rejected and
never falls back to local data. Per-machine terminal-session and selection state is isolated, so
colliding workspace or pane ids on different machines never mix.

Capability bodies are versioned. The top-level `/api/capabilities` advertises `machines`,
`workspace_zones`, and `uploads`, each version 1. A machine-scoped `/capabilities` response
advertises `uploads` only when an `scp` binary is reachable in the bridge's `PATH`, and the
frontend hides upload affordances when the capability is absent. Malformed or unknown-version
capability bodies parse as unavailable, not as a weaker default.

Machine selection is browser-session state: it is not persisted to browser storage, and a reload
returns to the default runtime. Within a session the selection is sticky across Local ↔ machine
switches. This selection state is separate from the persisted list of manually configured HTTP
bridge backends — those keep their existing behavior and grouping — and the validated runtime
list includes the ephemeral SSH machine runtimes, so a chosen machine stays chosen.

## Two-stage SCP uploads

Uploading from a machine runtime uses a two-stage pipeline:

1. **Bridge staging.** The browser sends the file to the machine-scoped uploads route; request
   bodies are capped at 25 MB bridge-wide, and oversized bodies are rejected. The body is written
   to a generated staging file (mode `0600`, created with no-clobber semantics) inside a staging
   directory (mode `0700`) under the bridge's upload root.
2. **Remote transfer.** The staged file is copied with `scp -s` (SFTP mode — no legacy remote
   shell) to a generated `.incoming-…` staging name — never the final name, which `scp` would
   silently overwrite — inside the fixed remote directory
   `~/.local/share/herdr-web/uploads` of the machine's saved SSH account.
3. **Atomic commit.** A transient POSIX helper script run over the same SSH transport commits the
   staging file to its final name atomically: no-clobber creation by default, an automatic
   `name-1.ext`-style conflict rename when requested, and `mv -f` (atomic rename) only for an
   explicit overwrite request. Directories and symlinks at the target name are refused, not
   clobbered.

Operational details:

- SSH invocations are plain argv vectors built from the operator catalog only; the saved target
  string is passed as a single argv entry and never through a shell. Default SSH arguments include
  `BatchMode=yes`, `ConnectTimeout=10`, and keepalives (`ServerAliveInterval=5`,
  `ServerAliveCountMax=2`) so a silently dead peer cannot hold an upload slot.
- At most two ssh/scp upload pipelines run concurrently per bridge process.
- Remote stderr is logged server-side only and never returned to the browser.
- Machine routes pass the same Host allowlist and Origin handling as every other bridge route.
- Uploads to `local` keep the pre-existing local upload behavior; the two-stage pipeline applies
  to saved SSH machines.

## Process lifecycle

On Unix, each ssh/scp child is spawned in its own process group with `kill_on_drop`, and an
overall transfer timeout is enforced. On timeout or cancellation — including the browser dropping
the request mid-flight — the whole owned process group is signalled, so `scp` and its ssh
grandchild are torn down together. On non-Unix bridge platforms the group kill is a no-op and
cleanup relies on the child exiting on its own or timing out.

## Local/Remote workspace zones

The sidebar space list can group spaces by serving machine: spaces served by the local bridge
under `Local`, spaces of enabled remote machines under `Remote`, with per-host subheaders when
several remotes are enabled. This mirrors the CLI client's local-versus-remote split, and the
`Local` header stays hidden while no remote machine exists.

- The mode is a server-side bridge setting stored on the bridge host as
  `workspace-zones/workspace-zones.json` under the bridge state directory (override with
  `HERDR_WEB_WORKSPACE_ZONES_DIR`); selecting the default mode stores nothing and drops any stale
  settings file.
- Modes: `local_remote` (default) and `off`. Exposed via `GET/PUT /api/workspace-zones`
  (`workspace_zones` capability, version 1) and toggled from the space list options menu
  (`Zones: Local / Remote | Off`).
- This is a new host-side setting; existing per-browser legacy UI preferences are unchanged.

## Deployment requirements

- The web service account needs `ssh` and `scp` in its service `PATH`. The target machine
  must expose the native `herdr` CLI to non-interactive SSH commands. Local daemon access
  uses the socket, not a spawned local `herdr` CLI.
- Deploy the bridge binary and `web/dist` from the same commit; replacing only `web/dist` on an
  older bridge leaves machine routing and the reworked menus non-functional.
- Updating the web service does not restart native Herdr. Original Herdr binaries, updates, and
  plugins stay untouched, and remote machines need nothing installed.

## Verified scope and known limits

Verified on Linux (2026-10-28), with matching bridge/UI builds from the same source snapshot,
using isolated loopback bridge instances before production deployment:

- Unit suites: frontend 506 tests across 56 files; bridge 237 passed / 1 ignored; vendored
  compatibility crate 146 tests. Lint, formatting, type-check, and debug build clean; isolated
  Vite production build with zero errors and warnings.
- Runtime-selection regression: the previously deployed bundle reset the machine selector to the
  local bridge; the new bundle keeps a saved machine selected across Local → machine → Local →
  machine switches.
- A real upload through the GUI file input to a saved machine returned HTTP 200; the 73-byte
  payload was verified byte-identical by SHA-256 on the target host; the committed file had mode
  `600` inside a `700` uploads directory; the fixture was removed on both hosts afterwards. During
  the upload the queued remote path was captured for the terminal instead of being typed into the
  user's live PTY, and Input/Resize broadcasts stayed blocked with takeover false.
- The test stand and tunnel were stopped afterwards; the native binary, its configuration files,
  the live `web/dist`, and native Herdr focus were unchanged.

Known limits — documented behavior, not open bugs:

- Staging permissions (`0700` directories, `0600` files) are applied only to directories and files
  the bridge itself creates. Pre-existing ancestor directories of the upload root are trusted
  as-is; deployments where another operating-system user controls an ancestor directory are
  outside the verified scope (verification ran as root on Linux).
- The remote upload directory is derived from the saved account's `$HOME`
  (`~/.local/share/herdr-web/uploads`); accounts with unusual or overridden `HOME` values get
  correspondingly unusual upload locations.
- The no-clobber and atomic-rename commit closes the window against other users, but a competing
  process running as the same user on either host can still race the check-then-rename sequence
  (same-UID TOCTOU). Single-operator bridge hosts are the intended environment.
- The privacy and atomicity guarantees assume a normal POSIX filesystem with rename and hardlink
  semantics; unusual or hardlink-less filesystems degrade these guarantees to whatever the
  filesystem itself provides.
- On non-Unix bridge hosts, cancellation cannot signal the whole process group (see
  [Process lifecycle](#process-lifecycle)).

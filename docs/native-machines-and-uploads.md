# Saved SSH machines, workspace zones, and remote uploads

This document describes saved-machine routing, Local/Remote workspace zones, and two-stage SCP
uploads in `herdr-web`: what the bridge guarantees, which parts are operator-configured, and which
limits are known and accepted rather than fixed. None of this modifies native Herdr — its
updates, plugins, sockets, and panes are untouched — and nothing is installed on remote
machines.

## Discovery: the operator's machine catalog

- The bridge reads Herdr's own client state, `~/.local/state/herdr/client/endpoints.json`, as a
  read-only catalog, re-read on every request, so machines saved or enabled through Herdr appear
  without a bridge restart. A missing or corrupt catalog yields the local bridge alone.
- The catalog is authoritative: the browser never supplies hostnames, users, ports, or paths for
  machine routing. There is no way to make the bridge connect to an arbitrary target from the web
  UI.
- The catalog always contains the serving bridge itself (`local`) plus each enabled saved SSH
  machine; disabled entries are not served.

## Routing and capabilities

Machine-scoped routes are same-origin routes on the serving bridge:

- `GET /api/machines` — the machine list (`machines` capability, version 1).
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

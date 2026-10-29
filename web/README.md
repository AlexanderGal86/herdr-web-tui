# @herdr/web

React + Vite frontend for `herdr-web`.

Run from this directory:

```bash
npm install
npm run dev
npm run lint
npm run test
npm run build
```

The production build is written to `web/dist/` and served by `herdr-web-bridge` through
`scripts/run-bridge.sh`.

For the normal one-command development workflow, start the bridge and Vite from the repository root:

```bash
npm run dev
```

Open `http://127.0.0.1:5173`. Vite proxies `/api` and `/ws` to the managed bridge and hot-reloads
frontend edits. See the root README for address and socket overrides.

To manage the two processes separately instead:

```bash
# terminal 1, from the repository root
npm run bridge:build && scripts/run-bridge.sh

# terminal 2, from the repository root
npm run dev:web
```

`scripts/run-bridge.sh` points debug bridge builds at the stable Herdr socket by default instead of
the debug `herdr-dev` socket. Override `HERDR_SOCKET_PATH` when targeting a named or development
session.

The app expects these bridge routes:

- `/api/capabilities`
- `/api/snapshot`
- `/api/command`
- `/api/launcher-presets`
- `/api/launcher-presets/launch`
- `/api/selection`
- `/api/notes` (and `/api/notes/{note_id}/...` actions)
- `/api/agent-pins` (and `/api/agent-pins/{pane_id}/pin|unpin`)
- `/api/agent-activity`
- `/api/uploads`
- `/api/workspace-zones` (GET/PUT)
- `/api/machines` (GET)
- `/api/machines/add` (POST)
- `/api/machines/{machine_id}/disable` (POST)
- `/api/machines/{machine_id}/snapshot`
- `/api/machines/{machine_id}/capabilities`
- `/api/machines/{machine_id}/command`
- `/api/machines/{machine_id}/selection`
- `/api/machines/{machine_id}/uploads`
- `/api/machines/{machine_id}/ws/events`
- `/api/machines/{machine_id}/ws/terminal`
- `/ws/activity`
- `/ws/events`
- `/ws/ui-events`
- `/ws/terminal`

Machine-scoped routes forward same-origin requests to the operator's saved Herdr SSH machines
over Herdr's hidden remote bridge transports; they are distinct from manually configured HTTP
bridge backends. A machine advertises the `uploads` capability only when an `scp` binary is
reachable in the bridge's `PATH`, so the UI hides upload affordances on machines that cannot
receive them. See [docs/native-machines-and-uploads.md](../docs/native-machines-and-uploads.md)
for discovery, routing, capability semantics, and the two-stage SCP upload pipeline.

Launcher execution belongs to the bridge. The frontend selects a preset and placement; it does not
construct Herdr `agent.start` requests. Built-in agents use Herdr's managed-agent flow after the
bridge creates the destination pane, while custom presets retain their exact configured `argv`.

New space uses the active space on the selected bridge as its launch-directory source.
Herdr still controls the directory policy. Its default in `~/.config/herdr/config.toml` is:

```toml
[terminal]
new_cwd = "follow"
```

This inherits the source space's directory as resolved by Herdr (its active tab's focused
pane, or the space's seed directory).
Other Herdr directory policies remain in effect; the browser does not override `cwd`.
When there is no active space, Herdr chooses its default source.
If another client closes the source space before creation, Herdr rejects the request;
refresh/select an existing space and retry. The browser does not silently switch the
launch directory by retrying without a source.

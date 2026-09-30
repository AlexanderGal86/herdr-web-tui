# OneDev Publication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the complete Herdr TUI fork, with installation documentation, in the user's OneDev at `http://10.0.109.128:6610/`.

**Architecture:** Preserve upstream Git history and license. Publish the existing theme with a Russian entry README, the original README retained separately, and platform installation/troubleshooting guides. Keep build outputs, credentials, and session data out of Git.

**Tech Stack:** Existing React/Vite frontend, Rust bridge, Git, OneDev web UI and Git transport.

---

### Task 1: Prepare documentation

**Files:** `README.md`, `README.upstream.md`, `docs/herdr-tui.md`, `docs/troubleshooting.ru.md`.

- [x] Preserve the original README as `README.upstream.md`.
- [x] Write Linux and Windows clone/build/run instructions, protocol and runtime requirements, SSH forwarding, theme selection, updates, and development preview instructions in `README.md`.
- [x] Document socket, port, build, stale frontend, and Windows-to-Linux line-ending issues in `docs/troubleshooting.ru.md`.
- [x] Review relative links and commands against repository code; keep known Windows test failures and unverified Linux runtime explicit. Independent review corrections addressed Node 24 requirements, Windows development commands, named-session configuration, and ignored uploads.

### Task 2: Verify publication contents

- [x] Run `npm run check`; report platform blockers without claiming full success.
- [x] Independently run frontend lint/tests/build if the aggregate check stops early; inspect all results. Frontend: 440 tests, lint, production build passed; Rust build/format and Git Bash vendor check passed; bridge tests: 136 passed / 16 upstream Windows failures.
- [ ] Run `git diff --check` and inspect staged paths, generated-file exclusion, and accidental secret patterns before committing.
- [ ] Commit the intended source/docs changes with an accurate author identity; preserve upstream ancestry.

### Task 3: Publish and verify

- [ ] Establish authenticated access to the named OneDev server without embedding credentials in Git URLs or repository files.
- [x] Create the empty `herdr-web-tui` project (do not overwrite an existing project; do not widen anonymous access). OneDev project ID: 12.
- [ ] Add a separate `onedev` remote, leaving upstream `origin` unchanged. Push the completed commit as `main` and the working feature branch without force.
- [ ] Verify remote commit hashes and the rendered README/files; report the repository URL and any remaining limitations.

Authentication is required to finish publication. The user has already authorized repository creation and uploading this code; no separate publish confirmation is needed.

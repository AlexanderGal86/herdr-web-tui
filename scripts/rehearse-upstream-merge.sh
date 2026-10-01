#!/usr/bin/env bash
# Rehearse an upstream merge against the fork's theme edits.
#
# Builds a synthetic "upstream churn" patch on top of BASE_REF
# (the upstream base the fork diverged from), then applies it
# onto the current HEAD content with `git apply --3way` inside
# a throwaway worktree, counting conflicts in the 4 shared files.
#
# Usage:
#   BASE_REF=<ref> bash scripts/rehearse-upstream-merge.sh [--strict]
#     BASE_REF is REQUIRED: the upstream commit the fork diverged
#     from (f1312e2 for kcosr/herdr-web). Rehearsing against any
#     other base (e.g. the fork's own origin/main) proves nothing.
#
# Exit codes: 0 no conflicts (or non-strict), 1 conflicts under
# --strict, 2 churn anchor missing (churn spec stale), 3 no churn
# produced, 4 git apply failed unexpectedly.
set -euo pipefail

STRICT=0
for arg in "$@"; do
  case "$arg" in
    --strict) STRICT=1 ;;
    *) echo "unknown arg: $arg" >&2; exit 64 ;;
  esac
done

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

if [ -n "${BASE_REF:-}" ]; then
  BASE="$BASE_REF"
else
  echo "BASE_REF is required (upstream base commit, e.g. f1312e2)" >&2
  exit 64
fi

FILES=(
  web/src/main.tsx
  web/src/terminalRenderer.ts
  web/src/App.tsx
  web/src/TerminalView.tsx
)

TMP="$(mktemp -d)"
WORKTREE="$TMP/wt"
PATCH="$TMP/upstream-sim.patch"
cleanup() {
  git worktree remove --force "$WORKTREE" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

git worktree add -q --detach "$WORKTREE" HEAD
cd "$WORKTREE"
git checkout -q "$BASE" -- "${FILES[@]}"

python3 - <<'PY'
import sys

def edit(path, old, new, count=1):
    with open(path, encoding="utf-8") as f:
        text = f.read()
    if text.count(old) < count:
        print(f"anchor missing in {path}: {old!r}", file=sys.stderr)
        sys.exit(2)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text.replace(old, new, count))

edit(
    "web/src/main.tsx",
    'import { startNativeControls } from "./native";\n',
    'import { startNativeControls } from "./native";\n'
    'import { upstreamTelemetry } from "./upstreamTelemetry";\n',
)
edit(
    "web/src/terminalRenderer.ts",
    "ui-monospace, SFMono-Regular,",
    "system-ui, SFMono-Regular,",
)
edit(
    "web/src/App.tsx",
    "const DEFAULT_SIDEBAR_WIDTH = 320;\n",
    "const DEFAULT_SIDEBAR_WIDTH = 320;\n"
    'const UPSTREAM_SIDEBAR_PRESET = "wide";\n',
)
edit(
    "web/src/TerminalView.tsx",
    "  selected = false,\n",
    "  selected = false,\n"
    '  upstreamLayout = "classic",\n',
)
PY

git diff --no-color -- "${FILES[@]}" > "$PATCH"
if [ ! -s "$PATCH" ]; then
  echo "no churn produced; churn spec stale" >&2
  exit 3
fi

git checkout -q HEAD -- "${FILES[@]}"
APPLY_RC=0
git apply --3way "$PATCH" 2>/dev/null || APPLY_RC=$?
if [ "$APPLY_RC" -gt 1 ]; then
  echo "git apply failed unexpectedly (rc=$APPLY_RC)" >&2
  exit 4
fi

total=0
for f in "${FILES[@]}"; do
  n=$(grep -c '^<<<<<<< ' "$f" 2>/dev/null || true)
  echo "$f: $n conflict(s)"
  total=$((total + n))
done
echo "conflicts: $total"

if [ "$STRICT" -eq 1 ] && [ "$total" -gt 0 ]; then
  exit 1
fi

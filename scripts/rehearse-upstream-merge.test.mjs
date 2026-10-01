import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "scripts/rehearse-upstream-merge.sh");

const BASE_FILES = {
  "web/src/main.tsx": [
    'import "@fontsource-variable/geist/wght.css";',
    'import { App } from "./App";',
    'import { startNativeControls } from "./native";',
    'import "./styles.css";',
    "",
    "startNativeControls();",
  ].join("\n"),
  "web/src/terminalRenderer.ts": [
    "const TERMINAL_FONT_FAMILY =",
    '  "ui-monospace, SFMono-Regular, Menlo, monospace";',
    "",
    "export function render() {",
    "  return TERMINAL_FONT_FAMILY;",
    "}",
  ].join("\n"),
  "web/src/App.tsx": [
    'const DEFAULT_SIDEBAR_WIDTH = 320;',
    'const MIN_SIDEBAR_WIDTH = 260;',
    "",
    "export function App() {",
    '  return "app";',
    "}",
  ].join("\n"),
  "web/src/TerminalView.tsx": [
    'import { useCommandDraft } from "./commandDrafts";',
    "",
    "export function TerminalView({",
    "  selected = false,",
    "}: Props) {",
    '  return "view";',
    "}",
  ].join("\n"),
};

function fixture(t, forkEdits) {
  const directory = mkdtempSync(join(tmpdir(), "herdr-rehearse-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, { cwd: directory, encoding: "utf8" });
  git("init", "--initial-branch=main");
  git("config", "user.name", "rehearse-test");
  git("config", "user.email", "rehearse-test@example.invalid");
  for (const [path, content] of Object.entries(BASE_FILES)) {
    mkdirSync(join(directory, path, ".."), { recursive: true });
    writeFileSync(join(directory, path), `${content}\n`);
  }
  git("add", ".");
  git("commit", "-q", "-m", "base");
  const baseRef = git("rev-parse", "HEAD").trim();
  git("checkout", "-q", "-b", "fork");
  for (const [path, lines] of Object.entries(forkEdits)) {
    const content = BASE_FILES[path].split("\n");
    for (const [anchor, insert] of lines) {
      content.splice(content.indexOf(anchor) + 1, 0, ...insert);
    }
    writeFileSync(join(directory, path), `${content.join("\n")}\n`);
  }
  git("add", ".");
  git("commit", "-q", "-m", "fork theme");
  return { directory, baseRef, git };
}

function runHarness(directory, baseRef, args = []) {
  return execFileSync("bash", [script, ...args], {
    cwd: directory,
    env: { ...process.env, BASE_REF: baseRef },
    encoding: "utf8",
  });
}

test("reports conflict count and exits 0 without --strict", (t) => {
  const { directory, baseRef } = fixture(t, {
    "web/src/main.tsx": [
      ['import { App } from "./App";', ['import { initTheme } from "./theme";']],
    ],
  });
  const stdout = runHarness(directory, baseRef);
  assert.match(stdout, /conflicts:\s*\d+/);
});

test("--strict exits nonzero on an engineered conflict", (t) => {
  const { directory, baseRef } = fixture(t, {
    "web/src/main.tsx": [
      [
        'import { startNativeControls } from "./native";',
        ['import { colliding } from "./colliding";'],
      ],
    ],
  });
  assert.throws(
    () => runHarness(directory, baseRef, ["--strict"]),
    (error) => error.status !== 0,
  );
});

test("cleans up its temporary worktree", (t) => {
  const { directory, baseRef, git } = fixture(t, {
    "web/src/App.tsx": [["const MIN_SIDEBAR_WIDTH = 260;", ["// theme"]]],
  });
  runHarness(directory, baseRef);
  assert.equal(git("worktree", "list").trim().split("\n").length, 1);
});

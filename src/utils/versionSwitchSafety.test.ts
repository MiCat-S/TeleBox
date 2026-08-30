import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import {
  clearSwitchInProgress,
  markSwitchInProgress,
  switchInProgressLock,
} from "./versionSwitchProgress";
import {
  convertNestedToFlat,
  createLayoutMoveJournal,
  detectEdition,
  ensureNestedLayout,
  listPendingInstallScripts,
  resolveSetsidBinary,
  rollbackLayoutMoveJournal,
} from "./versionSwitchPaths";
import type { TeleBoxVersion } from "./versionSwitchState";
import { writePrivateJsonAtomic } from "./apiConfig";

function git(repo: string, args: string[]): void {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function createEditionRepo(repo: string, version: TeleBoxVersion): void {
  fs.mkdirSync(path.join(repo, "scripts"), { recursive: true });
  fs.writeFileSync(
    path.join(repo, "package.json"),
    JSON.stringify({
      dependencies: version === "teleproto" ? { teleproto: "1.0.0" } : { "@mtcute/node": "1.0.0" },
    }),
  );
  fs.writeFileSync(path.join(repo, "scripts", "run-tsx.cjs"), "module.exports = {};");
  git(repo, ["init"]);
  git(repo, [
    "remote",
    "add",
    "origin",
    version === "teleproto"
      ? "https://github.com/TeleBoxOrg/TeleBox.git"
      : "https://github.com/TeleBoxOrg/TeleBox-Next.git",
  ]);
  git(repo, ["add", "."]);
  git(repo, ["-c", "user.name=TeleBox Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture"]);
}

test("switch lock acquisition is atomic and release verifies PID/nonce", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "telebox-lock-"));
  try {
    const owner = markSwitchInProgress(
      { source: "teleproto", target: "mtcute", reason: "test" },
      home,
    );
    assert.throws(
      () => markSwitchInProgress({ source: "teleproto", target: "mtcute" }, home),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "EEXIST",
    );
    assert.equal(
      clearSwitchInProgress({ pid: owner.pid, nonce: `${owner.nonce}wrong` }, home),
      false,
    );
    assert.equal(fs.existsSync(path.join(home, "in-progress.lock")), true);
    assert.equal(clearSwitchInProgress(owner, home), true);
    assert.equal(fs.existsSync(path.join(home, "in-progress.lock")), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("atomic lock acquisition removes an authenticated dead-owner lock and retries", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "telebox-stale-lock-"));
  try {
    fs.writeFileSync(
      switchInProgressLock(home),
      JSON.stringify({
        source: "teleproto",
        target: "mtcute",
        reason: "crashed-test-owner",
        pid: 2_147_483_647,
        nonce: "0123456789abcdef0123456789abcdef",
        startedAt: Date.now(),
      }),
      { mode: 0o600 },
    );
    const owner = markSwitchInProgress({ source: "teleproto", target: "mtcute" }, home);
    assert.equal(owner.pid, process.pid);
    assert.equal(clearSwitchInProgress(owner, home), true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("layout discovery is read-only even when flat and nested candidates coexist", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telebox-layout-discovery-"));
  const previousCwd = process.cwd();
  try {
    const flat = path.join(root, "telebox");
    const nestedCandidate = path.join(root, "telebox-classic");
    createEditionRepo(flat, "teleproto");
    createEditionRepo(nestedCandidate, "teleproto");
    process.chdir(flat);

    const layout = ensureNestedLayout({ prepareMissing: false });
    assert.equal(layout.flat, true);
    assert.equal(fs.existsSync(path.join(flat, "package.json")), true);
    assert.equal(fs.existsSync(path.join(nestedCandidate, "package.json")), true);
    assert.equal(fs.existsSync(path.join(root, "telebox-next")), false);
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("process-local layout transaction rolls back dirty repos without leaving a crash journal", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telebox-layout-"));
  try {
    const home = path.join(root, "legacy-home");
    const teleproto = path.join(home, "telebox-classic");
    const mtcute = path.join(home, "telebox-next");
    createEditionRepo(teleproto, "teleproto");
    createEditionRepo(mtcute, "mtcute");
    fs.writeFileSync(path.join(teleproto, "local-uncommitted.txt"), "keep me");

    const journal = createLayoutMoveJournal(path.join(root, "switch-home"));
    assert.equal(fs.existsSync(path.join(root, "switch-home", "layout-journals")), false);
    const flat = convertNestedToFlat(home, journal, { persistCache: false });
    assert.equal(fs.existsSync(path.join(root, "switch-home", "layout-journals")), false);
    assert.equal(fs.existsSync(teleproto), false);
    assert.equal(fs.existsSync(mtcute), false);
    assert.equal(fs.readFileSync(path.join(flat.roots.teleproto, "local-uncommitted.txt"), "utf8"), "keep me");
    assert.equal(journal.moves.some((entry) => entry.dirty), true);

    rollbackLayoutMoveJournal(journal);
    assert.equal(fs.existsSync(flat.roots.teleproto), false);
    assert.equal(fs.existsSync(flat.roots.mtcute), false);
    assert.equal(fs.readFileSync(path.join(teleproto, "local-uncommitted.txt"), "utf8"), "keep me");
    assert.equal(fs.existsSync(path.join(mtcute, "package.json")), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("layout detection rejects repository symlinks", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telebox-layout-symlink-"));
  try {
    const realRepo = path.join(root, "real");
    const linkedRepo = path.join(root, "telebox");
    createEditionRepo(realRepo, "teleproto");
    fs.symlinkSync(realRepo, linkedRepo, "dir");
    assert.equal(detectEdition(linkedRepo), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("setsid is mandatory for a detached controller", () => {
  assert.throws(() => resolveSetsidBinary([]), /缺少 setsid/);
});

test("npm pending-script check is read-only and parses pending package names", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telebox-npm-pending-"));
  try {
    const fakeNpm = path.join(root, "npm");
    fs.writeFileSync(
      fakeNpm,
      [
        "#!/bin/sh",
        'test "$1" = "approve-scripts" || exit 10',
        'test "$2" = "--allow-scripts-pending" || exit 11',
        'test "$3" = "--json" || exit 12',
        "printf '%s\\n' '{\"allowScripts\":[{\"name\":\"canvas\"},{\"name\":\"sharp\"}]}'",
      ].join("\n"),
      { mode: 0o700 },
    );
    assert.deepEqual(listPendingInstallScripts(root, fakeNpm), ["canvas", "sharp"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("version-switch config writes are atomic and mode 0600", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telebox-switch-config-"));
  try {
    const config = path.join(root, "repo", "config.json");
    writePrivateJsonAtomic(config, { api_id: 1, api_hash: "secret" });
    assert.equal(fs.statSync(config).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(fs.readFileSync(config, "utf8")), {
      api_id: 1,
      api_hash: "secret",
    });
    assert.equal(
      fs.readdirSync(path.dirname(config)).some((name) => name.endsWith(".tmp")),
      false,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

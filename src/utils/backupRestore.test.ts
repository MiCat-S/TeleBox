import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import zlib from "zlib";
import { spawnSync } from "child_process";
import { createGenerationContext } from "./generationContext";
import {
  extractBackupArchive,
  inspectBackupArchive,
  reloadRestoredBackupOrRollback,
  restoreBackupFromStaging,
} from "./backupRestore";

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function writeField(buffer: Buffer, offset: number, length: number, value: string): void {
  buffer.write(value.slice(0, length), offset, "utf8");
}

function writeOctal(buffer: Buffer, offset: number, length: number, value: number): void {
  writeField(buffer, offset, length, `${value.toString(8).padStart(length - 1, "0")}\0`);
}

function createSingleEntryTar(
  file: string,
  name: string,
  type: string,
  linkName = "",
): void {
  const data = type === "0" || type === "" ? Buffer.from("x") : Buffer.alloc(0);
  const header = Buffer.alloc(512);
  writeField(header, 0, 100, name);
  writeOctal(header, 100, 8, 0o600);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, data.length);
  writeOctal(header, 136, 12, Math.floor(Date.now() / 1000));
  header.fill(0x20, 148, 156);
  writeField(header, 156, 1, type || "0");
  writeField(header, 157, 100, linkName);
  writeField(header, 257, 6, "ustar\0");
  writeField(header, 263, 2, "00");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeField(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
  fs.writeFileSync(
    file,
    zlib.gzipSync(Buffer.concat([header, data, padding, Buffer.alloc(1024)])),
  );
}

test("valid backup extracts to staging and atomically restores plugins/assets", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telebox-backup-valid-"));
  try {
    const source = path.join(root, "source", "telebox_backup");
    fs.mkdirSync(path.join(source, "plugins"), { recursive: true });
    fs.mkdirSync(path.join(source, "assets", "demo"), { recursive: true });
    fs.writeFileSync(path.join(source, "plugins", "new.ts"), "new plugin");
    fs.writeFileSync(path.join(source, "assets", "demo", "config.json"), "new config");
    const archive = path.join(root, "backup.tar.gz");
    run("tar", ["-czf", archive, "-C", path.join(root, "source"), "telebox_backup"]);

    const program = path.join(root, "program");
    fs.mkdirSync(path.join(program, "plugins"), { recursive: true });
    fs.mkdirSync(path.join(program, "assets"), { recursive: true });
    fs.writeFileSync(path.join(program, "plugins", "old.ts"), "old plugin");
    fs.writeFileSync(path.join(program, "assets", "old.json"), "old config");

    const lifecycle = createGenerationContext(1);
    const extracted = await extractBackupArchive(archive, lifecycle);
    const restored = restoreBackupFromStaging(extracted, program);
    assert.equal(fs.readFileSync(path.join(program, "plugins", "new.ts"), "utf8"), "new plugin");
    assert.equal(fs.readFileSync(path.join(program, "assets", "demo", "config.json"), "utf8"), "new config");
    assert.equal(fs.readFileSync(path.join(restored.previousFilesDir, "plugins", "old.ts"), "utf8"), "old plugin");
    await lifecycle.drain();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("restore failure rolls both directories back to their previous contents", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telebox-backup-rollback-"));
  const originalRename = fs.renameSync;
  try {
    const extracted = path.join(root, "extracted", "telebox_backup");
    fs.mkdirSync(path.join(extracted, "plugins"), { recursive: true });
    fs.mkdirSync(path.join(extracted, "assets"), { recursive: true });
    fs.writeFileSync(path.join(extracted, "plugins", "new.ts"), "new");
    fs.writeFileSync(path.join(extracted, "assets", "new.json"), "new");

    const program = path.join(root, "program");
    fs.mkdirSync(path.join(program, "plugins"), { recursive: true });
    fs.mkdirSync(path.join(program, "assets"), { recursive: true });
    fs.writeFileSync(path.join(program, "plugins", "old.ts"), "old");
    fs.writeFileSync(path.join(program, "assets", "old.json"), "old");

    fs.renameSync = ((oldPath, newPath) => {
      if (String(oldPath).includes(`${path.sep}staged${path.sep}assets`)) {
        throw new Error("injected assets rename failure");
      }
      return originalRename(oldPath, newPath);
    }) as typeof fs.renameSync;

    assert.throws(
      () => restoreBackupFromStaging(path.dirname(extracted), program),
      /injected assets rename failure/,
    );
    assert.equal(fs.readFileSync(path.join(program, "plugins", "old.ts"), "utf8"), "old");
    assert.equal(fs.readFileSync(path.join(program, "assets", "old.json"), "utf8"), "old");
    assert.equal(fs.existsSync(path.join(program, "plugins", "new.ts")), false);
    assert.equal(fs.existsSync(path.join(program, "assets", "new.json")), false);
  } finally {
    fs.renameSync = originalRename;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("archive limits reject excessive entries, single files, and total size", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telebox-backup-limits-"));
  try {
    const source = path.join(root, "source", "telebox_backup", "plugins");
    fs.mkdirSync(source, { recursive: true });
    for (const name of ["a.ts", "b.ts", "c.ts"]) {
      fs.writeFileSync(path.join(source, name), "1234");
    }
    const archive = path.join(root, "limits.tar.gz");
    run("tar", ["-czf", archive, "-C", path.join(root, "source"), "telebox_backup"]);

    assert.throws(
      () => inspectBackupArchive(archive, { maxEntries: 2, maxFileBytes: 100, maxTotalBytes: 1000 }),
      /条目过多/,
    );
    assert.throws(
      () => inspectBackupArchive(archive, { maxEntries: 100, maxFileBytes: 3, maxTotalBytes: 1000 }),
      /单文件过大/,
    );
    assert.throws(
      () => inspectBackupArchive(archive, { maxEntries: 100, maxFileBytes: 100, maxTotalBytes: 10 }),
      /总大小过大/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("reload false rolls restored plugins/assets back and reloads the old tree", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telebox-backup-reload-"));
  try {
    const extracted = path.join(root, "extracted", "telebox_backup");
    const program = path.join(root, "program");
    fs.mkdirSync(path.join(extracted, "plugins"), { recursive: true });
    fs.mkdirSync(path.join(extracted, "assets"), { recursive: true });
    fs.mkdirSync(path.join(program, "plugins"), { recursive: true });
    fs.mkdirSync(path.join(program, "assets"), { recursive: true });
    fs.writeFileSync(path.join(extracted, "plugins", "new.ts"), "new");
    fs.writeFileSync(path.join(extracted, "assets", "new.json"), "new");
    fs.writeFileSync(path.join(program, "plugins", "old.ts"), "old");
    fs.writeFileSync(path.join(program, "assets", "old.json"), "old");

    const restored = restoreBackupFromStaging(path.dirname(extracted), program);
    const reloadResults = [false, true];
    const result = await reloadRestoredBackupOrRollback(
      restored,
      async () => reloadResults.shift(),
    );
    assert.equal(result, false);
    assert.equal(fs.readFileSync(path.join(program, "plugins", "old.ts"), "utf8"), "old");
    assert.equal(fs.readFileSync(path.join(program, "assets", "old.json"), "utf8"), "old");
    assert.equal(fs.existsSync(path.join(program, "plugins", "new.ts")), false);
    assert.equal(reloadResults.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const malicious of [
  { label: "absolute path", name: "/tmp/telebox-owned", type: "0", link: "" },
  { label: "parent traversal", name: "telebox_backup/../../owned", type: "0", link: "" },
  { label: "symlink", name: "telebox_backup/plugins/link", type: "2", link: "/tmp" },
  { label: "hardlink", name: "telebox_backup/plugins/link", type: "1", link: "telebox_backup/plugins/a" },
  { label: "device", name: "telebox_backup/plugins/device", type: "3", link: "" },
]) {
  test(`backup pre-scan rejects ${malicious.label}`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "telebox-backup-malicious-"));
    try {
      const archive = path.join(root, "bad.tar.gz");
      createSingleEntryTar(archive, malicious.name, malicious.type, malicious.link);
      assert.throws(() => inspectBackupArchive(archive));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

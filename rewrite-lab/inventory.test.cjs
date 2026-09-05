const {test} = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {report} = require("./inventory.cjs");

test("inventory covers repository modules with production extensions marked as priority", () => {
  assert.equal(report.schemaVersion, 2);
  assert.ok(report.counts.extensions >= report.catalog.entries);
  assert.deepEqual(report.catalog.missingSources, []);
  assert.equal(report.sources.filter(s => s.productionPriority).length, 11);
  const core = path.resolve(__dirname, "..");
  const plugins = path.resolve(core, "../TeleBox-Plugins");
  const expected = fs.readdirSync(path.join(core, "src/plugin"))
    .filter(file => file.endsWith(".ts"))
    .map(file => `TeleBox-Core/src/plugin/${file}`);
  for (const base of ["", "outdated"]) {
    for (const entry of fs.readdirSync(path.join(plugins, base), {withFileTypes: true})) {
      if (!entry.isDirectory()) continue;
      const file = path.join(base, entry.name, `${entry.name}.ts`);
      if (fs.existsSync(path.join(plugins, file))) expected.push(`TeleBox-Plugins/${file}`);
    }
  }
  assert.deepEqual(report.sources.filter(s => !s.kind.endsWith("-support")).map(s => s.file).sort(), expected.sort());
  for (const name of ["agent", "kitt", "panel", "sudo", "sure", "switch", "leech"]) {
    assert.ok(report.sources.some(s => s.file.endsWith(`/src/plugin/${name}.ts`)), name);
  }
  assert.ok(report.sources.every(s => /^[a-f0-9]{64}$/.test(s.sha256)));
  assert.equal(new Set(report.sources.map(s => s.file)).size, report.sources.length);
});

test("inventory includes unindexed and archived entry points", () => {
  const unindexed = report.sources.find(s => s.file === "TeleBox-Plugins/sanitizeFileName/sanitizeFileName.ts");
  assert.equal(unindexed.kind, "extension");
  assert.equal(unindexed.catalogued, false);
  assert.ok(report.catalog.unindexedSources.includes(unindexed.file));
  for (const name of ["gemini", "gpt", "q"]) {
    const source = report.sources.find(s => s.file === `TeleBox-Plugins/outdated/${name}/${name}.ts`);
    assert.equal(source.kind, "archived-extension");
    assert.equal(source.productionPriority, false);
  }
  assert.ok(report.sources.some(s => s.file === "TeleBox-Core/src/plugin/exec.ts"));
  assert.ok(report.sources.some(s => s.file === "TeleBox-Plugins/exec/exec.ts"));
});

test("inventory includes core services, web assets and auxiliary runtimes", () => {
  for (const file of [
    "TeleBox-Core/src/utils/generationContext.ts",
    "TeleBox-Core/src/utils/panel/webapp/index.html",
    "TeleBox-Core/scripts/run-tsx.cjs",
    "TeleBox-Core/ecosystem.config.cjs",
    "TeleBox-Plugins/duckduckgo/ddg_fetch.py",
    "TeleBox-Plugins/keep_online/keep_online.sh",
    "TeleBox-Plugins/quote/generate.js",
    "TeleBox-Plugins/quote/vendor/quote-generate/index.js",
  ]) {
    assert.ok(report.sources.some(s => s.file === file), file);
  }
  assert.equal(report.sources.find(s => s.file.endsWith("/ddg_fetch.py")).analysis, "hash-only");
  assert.equal(report.sources.find(s => s.file.endsWith("/vendor/quote-generate/index.js")).vendored, true);
  assert.ok(report.sources.every(s => !/\.(test|spec)\./.test(s.file)));
});

test("inventory finds raw MTProto operations and external runtime dependency", () => {
  const dme = report.sources.find(s => s.file.endsWith("/dme/dme.ts"));
  assert.ok(dme.apiConstructors.includes("Api.channels.GetSendAs"));
  assert.ok(dme.apiConstructors.includes("Api.messages.EditMessage"));
  const ns = report.sources.find(s => s.file.endsWith("/nodeseek/nodeseek.ts"));
  assert.ok(ns.imports.includes("child_process") || ns.imports.includes("node:child_process"));
});

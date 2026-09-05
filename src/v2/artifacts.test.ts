import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { inspect } from "node:util";
import { setImmediate as turn } from "node:timers/promises";
import { inspectArtifact, prepareArtifact, ArtifactError, ARTIFACT_LIMITS,
  type PreparedArtifact, type ArtifactErrorCode } from "./artifacts";

const {buildPlugin} = require(path.resolve(__dirname, "../../scripts/build-v2-plugin.cjs")) as {
  buildPlugin(options: {id: string; packageRoot: string; entry: string; assets: string[]; rootDir: string}): {artifactDir: string};
};
const digest = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");
const DEFAULT_SOURCE = `
  import {definePlugin} from 'telebox/sdk';
  export default function create() {
    return definePlugin({apiVersion: 1, id: 'fixture', description: 'fixture', commands: {}});
  }
`;

function inside(root: string, filename: string): boolean {
  return filename.startsWith(root + path.sep);
}

function removeFixtureCache(root: string): void {
  const entries = Object.entries(require.cache).filter(([filename]) => inside(root, filename));
  const targets = new Set(entries.map(([, mod]) => mod));
  for (const mod of Object.values(require.cache)) {
    if (!mod) continue;
    for (let index = mod.children.length - 1; index >= 0; index--) if (targets.has(mod.children[index])) mod.children.splice(index, 1);
    if (mod.parent && targets.has(mod.parent)) mod.parent = null;
  }
  for (const [filename] of entries) delete require.cache[filename];
}

function fixture(t: TestContext, source = DEFAULT_SOURCE, assets: Record<string, string | Buffer> = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "telebox-artifact-")));
  const packageRoot = path.join(root, "source");
  fs.mkdirSync(packageRoot);
  fs.writeFileSync(path.join(packageRoot, "index.ts"), source);
  for (const [name, bytes] of Object.entries(assets)) {
    fs.mkdirSync(path.dirname(path.join(packageRoot, name)), {recursive: true});
    fs.writeFileSync(path.join(packageRoot, name), bytes);
  }
  const {artifactDir} = buildPlugin({id: "fixture", packageRoot, entry: "index.ts", assets: Object.keys(assets), rootDir: root});
  const handles: PreparedArtifact[] = [];
  t.after(() => {
    for (const handle of handles) handle.release();
    removeFixtureCache(root);
    fs.rmSync(root, {recursive: true, force: true});
  });
  return {root, packageRoot, artifactDir,
    async prepare(directory = artifactDir) {
      const handle = await prepareArtifact(directory);
      handles.push(handle);
      return handle;
    },
  };
}

type MutableManifest = {
  schemaVersion: number; apiVersion: number; id: string; entry: string;
  sources: {file: string; sha256: string}[]; imports: string[];
  files: {file: string; sha256: string}[]; revision: string;
};

function changeManifest(directory: string, change: (manifest: MutableManifest) => void, reseal = true): void {
  const file = path.join(directory, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(file, "utf8")) as MutableManifest;
  change(manifest);
  if (reseal) {
    const {schemaVersion, apiVersion, id, entry, sources, imports, files} = manifest;
    manifest.revision = digest(JSON.stringify({schemaVersion, apiVersion, id, entry, sources, imports, files}));
  }
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
}

function code(expected: ArtifactErrorCode) {
  return (error: unknown): boolean => error instanceof ArtifactError && error.code === expected;
}

function assertNoOwnedReferences(directory: string): void {
  assert.equal(Object.keys(require.cache).some(filename => inside(directory, filename)), false);
  for (const mod of Object.values(require.cache)) {
    if (!mod) continue;
    assert.equal(mod.children.some(child => child.filename && inside(directory, child.filename)), false, "cached parent retains artifact child");
    assert.equal(!!mod.parent?.filename && inside(directory, mod.parent.filename), false, "shared module retains artifact parent");
  }
}

test("inspection accepts builder manifests without executing code or needing original sources", async t => {
  const {artifactDir, packageRoot} = fixture(t, "throw new Error('private-candidate-source'); export default {}", {"data/asset.bin": Buffer.from([0, 255, 1])});
  const before = fs.readFileSync(path.join(artifactDir, "manifest.json"));
  fs.rmSync(packageRoot, {recursive: true});
  const info = await inspectArtifact(artifactDir);
  assert.equal(info.manifest.schemaVersion, 1);
  assert.equal(info.manifest.apiVersion, 1);
  assert.equal(info.manifest.id, "fixture");
  assert.equal(info.entryPath, path.join(artifactDir, "index.cjs"));
  assert.equal(info.manifest.sources[0].file, "index.ts");
  assert.equal(info.totalBytes, info.files.reduce((sum, file) => sum + file.size, 0));
  assert.equal(Object.isFrozen(info.manifest.sources[0]), true);
  assert.equal(Object.isFrozen(info.files), true);
  assert.deepEqual(fs.readFileSync(path.join(artifactDir, "manifest.json")), before);
  assertNoOwnedReferences(artifactDir);
});

test("trusted CJS artifacts can lazily import native dependencies from an awaited handler", async t => {
  const f = fixture(t, `
    import {definePlugin} from 'telebox/sdk';
    export default function create() {
      return definePlugin({apiVersion: 1, id: 'fixture', description: 'lazy fixture', commands: {},
        services: {name: {description: 'path name', async handle(input) {
          const {basename} = await import('node:path');
          return basename(input);
        }}}});
    }
  `);
  const handle = await f.prepare();
  const definition = handle.create();
  assert.equal(await definition.services!.name.handle('/first/second', undefined as never, new AbortController().signal), 'second');
  handle.release();
  assertNoOwnedReferences(f.artifactDir);
});

test("revision checks source fingerprint metadata, not the unavailable original bytes", async t => {
  const {artifactDir, packageRoot} = fixture(t);
  fs.rmSync(packageRoot, {recursive: true});
  changeManifest(artifactDir, manifest => { manifest.sources[0].sha256 = "a".repeat(64); });
  assert.equal((await inspectArtifact(artifactDir)).manifest.sources[0].sha256, "a".repeat(64));
  changeManifest(artifactDir, manifest => { manifest.sources[0].sha256 = "b".repeat(64); }, false);
  await assert.rejects(inspectArtifact(artifactDir), code("INTEGRITY"));
});

for (const [label, change] of [
  ["schema", (manifest: MutableManifest) => { manifest.schemaVersion = 2; }],
  ["API", (manifest: MutableManifest) => { manifest.apiVersion = 2; }],
  ["ID", (manifest: MutableManifest) => { manifest.id = "../private-id"; }],
  ["entry", (manifest: MutableManifest) => { manifest.entry = "entry.js"; }],
  ["hash", (manifest: MutableManifest) => { manifest.files[0].sha256 = "private-invalid-hash"; }],
  ["empty sources", (manifest: MutableManifest) => { manifest.sources = []; }],
  ["duplicate sources", (manifest: MutableManifest) => { manifest.sources.push({...manifest.sources[0]}); }],
  ["duplicate files", (manifest: MutableManifest) => { manifest.files.push({...manifest.files[0]}); }],
  ["legacy import", (manifest: MutableManifest) => { manifest.imports = ["@utils/pluginBase"]; }],
  ["duplicate imports", (manifest: MutableManifest) => { manifest.imports = ["node:fs", "node:fs"]; }],
] as const) {
  test(`inspection rejects incompatible ${label}`, async t => {
    const {artifactDir} = fixture(t);
    changeManifest(artifactDir, change);
    await assert.rejects(inspectArtifact(artifactDir), code("FORMAT"));
    assertNoOwnedReferences(artifactDir);
  });
}

test("inspection detects modified, missing, extra, and revision-mismatched content", async t => {
  for (const change of ["modified", "missing", "extra", "revision"]) {
    const {artifactDir} = fixture(t);
    if (change === "modified") fs.appendFileSync(path.join(artifactDir, "index.cjs"), "// private modification");
    if (change === "missing") fs.unlinkSync(path.join(artifactDir, "index.cjs"));
    if (change === "extra") fs.writeFileSync(path.join(artifactDir, "extra-secret.txt"), "secret");
    if (change === "revision") changeManifest(artifactDir, manifest => {manifest.revision = "0".repeat(64);}, false);
    await assert.rejects(inspectArtifact(artifactDir), code("INTEGRITY"));
  }
});

test("manifest file paths and source metadata reject traversal and platform aliases", async t => {
  for (const value of ["../private.ts", "/private.ts", "C:\\private.ts", "a\\private.ts", "a/../private.ts", "./private.ts", "a//private.ts", "a/private.ts."]) {
    const {artifactDir} = fixture(t);
    changeManifest(artifactDir, manifest => { manifest.sources[0].file = value; });
    await assert.rejects(inspectArtifact(artifactDir), code("BOUNDARY"));
  }
});

test("root, ancestor, manifest, asset, and dangling symlinks are rejected without following targets", async t => {
  for (const location of ["root", "ancestor", "manifest.json", "asset.txt", "dangling"]) {
    const {root, artifactDir} = fixture(t, DEFAULT_SOURCE, {"asset.txt": "asset"});
    let inspected = artifactDir;
    if (location === "root") {
      inspected = path.join(root, "alias");
      fs.symlinkSync(artifactDir, inspected, "dir");
    } else if (location === "ancestor") {
      const alias = path.join(root, "alias");
      fs.symlinkSync(path.join(root, "dist"), alias, "dir");
      inspected = path.join(alias, path.relative(path.join(root, "dist"), artifactDir));
    } else {
      const link = path.join(artifactDir, location);
      const target = path.join(root, "private-target");
      if (location !== "dangling") fs.writeFileSync(target, "must remain untouched");
      fs.rmSync(link, {force: true});
      fs.symlinkSync(target, link);
    }
    await assert.rejects(inspectArtifact(inspected), code("BOUNDARY"));
  }
});

test("manifest, entry, asset, and list sizes are bounded before expensive reads", async t => {
  for (const name of ["manifest.json", "index.cjs", "asset.bin"]) {
    const {artifactDir} = fixture(t, DEFAULT_SOURCE, {"asset.bin": "asset"});
    const limit = name === "manifest.json" ? ARTIFACT_LIMITS.manifestBytes : name === "index.cjs" ? ARTIFACT_LIMITS.moduleBytes : ARTIFACT_LIMITS.fileBytes;
    fs.truncateSync(path.join(artifactDir, name), limit + 1);
    await assert.rejects(inspectArtifact(artifactDir), code("LIMIT"));
  }
  const {artifactDir} = fixture(t);
  changeManifest(artifactDir, manifest => {
    manifest.sources = Array.from({length: ARTIFACT_LIMITS.sources + 1}, (_, index) => ({file: `${index}.ts`, sha256: "0".repeat(64)}));
  });
  await assert.rejects(inspectArtifact(artifactDir), code("LIMIT"));
});

test("large asset hashing streams bounded chunks and closes descriptors on success and failure", async t => {
  const {artifactDir} = fixture(t, DEFAULT_SOURCE, {"large.bin": Buffer.alloc(2_097_152, 173)});
  const asset = path.join(artifactDir, "large.bin");
  let opened = 0;
  let assetChunks = 0;
  const open = fsp.open;
  t.mock.method(fsp, "open", async (...args: Parameters<typeof fsp.open>) => {
    const handle = await open(...args);
    opened++;
    const close = handle.close.bind(handle);
    t.mock.method(handle, "close", async () => {try {await close();} finally {opened--;}});
    const read = handle.read.bind(handle);
    t.mock.method(handle, "read", async (buffer: Buffer, offset: number, length: number, position: number | null) => {
      const result = await read(buffer, offset, length, position);
      if (String(args[0]) === asset && result.bytesRead) {assetChunks++; assert.ok(length <= 65_536);}
      return result;
    });
    return handle;
  });
  t.mock.method(fsp, "readFile", () => {throw new Error("whole-file read must not be used");});
  t.mock.method(fs, "readFileSync", () => {throw new Error("whole-file read must not be used");});
  await inspectArtifact(artifactDir);
  assert.ok(assetChunks >= 32);
  assert.equal(opened, 0);
  await fsp.appendFile(asset, Buffer.from([1]));
  await assert.rejects(inspectArtifact(artifactDir), code("INTEGRITY"));
  assert.equal(opened, 0);
});

test("prepare and create never call setup, cleanup, or settings factories", async t => {
  const {prepare, artifactDir} = fixture(t, `
    import {definePlugin} from 'telebox/sdk';
    export default function create() {
      return definePlugin({apiVersion: 1, id: 'fixture', description: 'fixture', commands: {},
        setup() {throw Error('setup must not run');}, cleanup() {throw Error('cleanup must not run');},
        settings() {throw Error('settings must not run');}});
    }
  `);
  const handle = await prepare();
  const first = handle.create();
  const second = handle.create();
  assert.equal(first.id, "fixture");
  assert.equal(Object.isFrozen(first), true);
  assert.notEqual(first, second);
  handle.release();
  handle.release();
  assert.throws(() => handle.create(), code("RELEASED"));
  assertNoOwnedReferences(artifactDir);
});

test("default export must be a synchronous factory, not a declaration or async/generator function", async t => {
  for (const source of ["export default {}", "export default async function () {}", "export default function* () {}", "module.exports = function () {}"]) {
    const {artifactDir} = fixture(t, source);
    await assert.rejects(prepareArtifact(artifactDir), code("FACTORY"));
    assertNoOwnedReferences(artifactDir);
    await assert.rejects(prepareArtifact(artifactDir), code("FACTORY"));
  }
});

test("factory declarations, identity, hooks, and promise returns are validated without unhandled rejection", async t => {
  for (const [body, expected] of [
    ["return {}", "FACTORY"],
    ["throw Error('private-factory-error')", "FACTORY"],
    ["return Promise.reject(Error('private-promise-error'))", "FACTORY"],
    ["return {apiVersion:1,id:'another',description:'fixture',commands:{}}", "IDENTITY"],
    ["return {apiVersion:1,id:'fixture',description:'fixture',commands:{},cleanup:'private-invalid-hook'}", "FACTORY"],
  ] as const) {
    const {prepare, artifactDir} = fixture(t, `export default function create() {${body}}`);
    const handle = await prepare();
    assert.throws(() => handle.create(), code(expected));
    await assert.rejects(prepareArtifact(artifactDir), code("BUSY"));
    handle.release();
    assertNoOwnedReferences(artifactDir);
  }
  await turn();
});

test("top-level load failures and invalid JSON emit fixed diagnostics and release reservations", async t => {
  const secret = "private-input-secret";
  const {artifactDir} = fixture(t, `throw Error('${secret}'); export default function () {}`);
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(prepareArtifact(artifactDir), error => {
      assert.ok(error instanceof ArtifactError);
      assert.equal(error.code, "LOAD");
      assert.doesNotMatch(String(error) + inspect(error, {showHidden: true}) + JSON.stringify(error), new RegExp(secret));
      return true;
    });
    assertNoOwnedReferences(artifactDir);
  }
  fs.writeFileSync(path.join(artifactDir, "manifest.json"), `{"${secret}":`);
  await assert.rejects(inspectArtifact(artifactDir), error => {
    assert.ok(error instanceof ArtifactError);
    assert.doesNotMatch(inspect(error), new RegExp(secret));
    return true;
  });
});

test("concurrent and relocated duplicate artifacts are rejected without disturbing their owner", async t => {
  const {artifactDir, prepare, root} = fixture(t);
  const results = await Promise.allSettled([prepare(), prepare()]);
  const accepted = results.filter((result): result is PromiseFulfilledResult<PreparedArtifact> => result.status === "fulfilled");
  const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  assert.equal(accepted.length, 1);
  assert.equal(rejected.length, 1);
  assert.ok(code("BUSY")(rejected[0].reason));
  const copy = path.join(root, "relocated");
  fs.cpSync(artifactDir, copy, {recursive: true});
  await assert.rejects(prepareArtifact(copy), code("BUSY"));
  assert.equal(accepted[0].value.create().id, "fixture");
  accepted[0].value.release();
  const relocated = await prepare(copy);
  assert.equal(relocated.create().id, "fixture");
});

test("nested loader errors do not expose artifact paths in diagnostic stacks", async t => {
  const secret = "private-path-secret";
  const {prepare} = fixture(t,
    DEFAULT_SOURCE.replace("return definePlugin", `const file = './${secret}.cjs'; require(file); return definePlugin`),
    {[`${secret}.cjs`]: "require('unsupported:dependency')"});
  const handle = await prepare();
  assert.throws(() => handle.create(), error => {
    assert.ok(error instanceof ArtifactError);
    assert.equal(error.code, "FORMAT");
    assert.doesNotMatch(inspect(error, {showHidden: true}) + JSON.stringify(error), new RegExp(secret));
    return true;
  });
});

test("pre-existing native cache entries are rejected and never evicted", async t => {
  const {artifactDir} = fixture(t, "export default () => ({apiVersion:1,id:'fixture',description:'fixture',commands:{}})");
  const entry = path.join(artifactDir, "index.cjs");
  const loaded: unknown = require(entry);
  const cached = require.cache[entry];
  await assert.rejects(prepareArtifact(artifactDir), code("BUSY"));
  assert.equal(require.cache[entry], cached);
  assert.equal(require(entry), loaded);
});

const LAZY_SOURCE = `
  import {definePlugin} from 'telebox/sdk';
  import shared from 'artifact-shared';
  const helperFile = './helper.cjs';
  export default function create() {
    const helper = require(helperFile);
    if (helper.define !== definePlugin) throw Error('SDK identity mismatch');
    return definePlugin({apiVersion:1,id:'fixture',description:helper.label + shared.label,commands:{}});
  }
`;
const LAZY_ASSETS = {
  "helper.cjs": "module.exports = {define:require('telebox/sdk').definePlugin, label:require('./data.json').label}",
  "data.json": '{"label":"owned-"}',
};

function sharedPackage(root: string): string {
  const dir = path.join(root, "node_modules/artifact-shared");
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"artifact-shared","main":"index.cjs"}');
  const entry = path.join(dir, "index.cjs");
  fs.writeFileSync(entry, "module.exports = {label: 'shared'}");
  return entry;
}

test("lazy owned CJS/JSON and parent links are released while SDK/shared dependencies remain", async t => {
  const {root, artifactDir, prepare} = fixture(t, LAZY_SOURCE, LAZY_ASSETS);
  const sharedFile = sharedPackage(root);
  const sdkFile = require.resolve("./sdk");
  const sdkModule = require.cache[sdkFile];
  const handle = await prepare();
  assert.equal(require.cache[path.join(artifactDir, "helper.cjs")], undefined);
  assert.equal(handle.create().description, "owned-shared");
  const modules = Object.entries(require.cache).filter(([filename]) => inside(artifactDir, filename)).map(([, mod]) => mod!);
  assert.equal(modules.length, 3);
  const sharedModule = require.cache[sharedFile];
  assert.ok(sharedModule);
  handle.release();
  assertNoOwnedReferences(artifactDir);
  assert.equal(require.cache[sdkFile], sdkModule);
  assert.equal(require.cache[sharedFile], sharedModule);
  for (const mod of modules) {
    assert.equal(mod.parent, null);
    assert.equal(mod.children.length, 0);
    assert.throws(() => mod.require("node:fs"), code("RELEASED"));
  }
});

test("50 prepare/create/release cycles do not grow parent children or own cache entries", async t => {
  const {root, artifactDir, prepare} = fixture(t, LAZY_SOURCE, LAZY_ASSETS);
  sharedPackage(root);
  let parentCounts: Map<NodeModule, number> | undefined;
  for (let cycle = 0; cycle < 50; cycle++) {
    const handle = await prepare();
    assert.equal(handle.create().description, "owned-shared");
    handle.release();
    assertNoOwnedReferences(artifactDir);
    if (!parentCounts) parentCounts = new Map(Object.values(require.cache).filter((mod): mod is NodeModule => !!mod).map(mod => [mod, mod.children.length]));
    else for (const [mod, count] of parentCounts) assert.equal(mod.children.length, count);
  }
});

test("owned module bytes are rechecked on lazy load and external relative code cannot execute", async t => {
  const local = fixture(t, DEFAULT_SOURCE.replace("return definePlugin", "const file = './helper.cjs'; require(file); return definePlugin"), {"helper.cjs": "module.exports = {}"});
  const handle = await local.prepare();
  fs.appendFileSync(path.join(local.artifactDir, "helper.cjs"), ";throw Error('private-tamper')");
  assert.throws(() => handle.create(), code("INTEGRITY"));
  handle.release();
  assertNoOwnedReferences(local.artifactDir);
  const escaping = fixture(t, DEFAULT_SOURCE.replace("return definePlugin", "const file = './helper.cjs'; require(file); return definePlugin"),
    {"helper.cjs": "require('../../../../outside.cjs')"});
  fs.writeFileSync(path.join(escaping.root, "outside.cjs"), "throw Error('outside code executed')");
  const outside = await escaping.prepare();
  assert.throws(() => outside.create(), code("BOUNDARY"));
  assert.equal(require.cache[path.join(escaping.root, "outside.cjs")], undefined);
});

test("circular own CJS modules share cache identities and release every edge", async t => {
  const {prepare, artifactDir} = fixture(t,
    DEFAULT_SOURCE.replace("return definePlugin", "const file = './a.cjs'; if (!require(file).cycle) throw Error('cycle'); return definePlugin"), {
      "a.cjs": "exports.started = true; exports.cycle = require('./b.cjs').cycle",
      "b.cjs": "exports.cycle = require('./a.cjs').started",
    });
  const handle = await prepare();
  assert.equal(handle.create().id, "fixture");
  handle.release();
  assertNoOwnedReferences(artifactDir);
});

test("unsupported own ESM/native modules are rejected without native loading", async t => {
  for (const file of ["helper.mjs", "helper.node"]) {
    const {prepare, artifactDir} = fixture(t,
      DEFAULT_SOURCE.replace("return definePlugin", `const file = './${file}'; require(file); return definePlugin`),
      {[file]: "private-unsupported-module"});
    const handle = await prepare();
    assert.throws(() => handle.create(), code("FORMAT"));
    handle.release();
    assertNoOwnedReferences(artifactDir);
  }
});

test("a shared cached parent's child link to an owned module is removed on release", async t => {
  const {artifactDir, prepare} = fixture(t);
  const handle = await prepare();
  const owned = require.cache[path.join(artifactDir, "index.cjs")]!;
  const parent = require.cache[__filename]!;
  parent.children.push(owned);
  const shared = require.cache[require.resolve("./sdk")]!;
  const originalParent = shared.parent;
  shared.parent = owned;
  handle.release();
  assert.equal(parent.children.includes(owned), false);
  assert.equal(shared.parent, null);
  shared.parent = originalParent;
  assertNoOwnedReferences(artifactDir);
});

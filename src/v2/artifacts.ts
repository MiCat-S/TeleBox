import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import path from "node:path";
import Module, { createRequire, isBuiltin } from "node:module";
import { createHash } from "node:crypto";
import { types } from "node:util";
import * as sdk from "./sdk";
import type { PluginDefinition } from "./sdk";

export const ARTIFACT_LIMITS = Object.freeze({
  manifestBytes: 1_048_576,
  moduleBytes: 8_388_608,
  fileBytes: 67_108_864,
  totalBytes: 268_435_456,
  files: 1024,
  sources: 4096,
  imports: 256,
  treeEntries: 8192,
  pathBytes: 1024,
  pathDepth: 32,
});

const MESSAGES = {
  FORMAT: "Unsupported or malformed artifact format",
  BOUNDARY: "Artifact paths must stay within an ordinary, symlink-free directory",
  LIMIT: "Artifact exceeds an inspection or module size limit",
  INTEGRITY: "Artifact integrity verification failed",
  IO: "Artifact files could not be inspected",
  BUSY: "Artifact is already owned or has pre-existing module cache entries",
  LOAD: "Trusted artifact module could not be loaded",
  FACTORY: "Artifact factory must synchronously return a valid plugin declaration",
  IDENTITY: "Artifact factory identity does not match its manifest",
  RELEASED: "Artifact handle has been released",
} as const;
export type ArtifactErrorCode = keyof typeof MESSAGES;

/** Fixed diagnostic text: no paths, source text, original causes, or factory errors. */
export class ArtifactError extends Error {
  readonly code: ArtifactErrorCode;
  constructor(code: ArtifactErrorCode) {
    const safeCode = Object.hasOwn(MESSAGES, code) ? code : "LOAD";
    super(MESSAGES[safeCode]);
    this.code = safeCode;
    this.name = "ArtifactError";
    this.stack = `${this.name}: ${this.message}`;
    Object.freeze(this);
  }
}

export interface ArtifactFingerprint { readonly file: string; readonly sha256: string; }
export interface ArtifactManifest {
  readonly schemaVersion: 1;
  readonly apiVersion: typeof sdk.PLUGIN_API_VERSION;
  readonly id: string;
  readonly entry: "index.cjs";
  readonly sources: readonly ArtifactFingerprint[];
  readonly imports: readonly string[];
  readonly files: readonly ArtifactFingerprint[];
  readonly revision: string;
}
export interface ArtifactFile extends ArtifactFingerprint { readonly size: number; }
export interface InspectedArtifact {
  readonly directory: string;
  readonly entryPath: string;
  readonly manifest: ArtifactManifest;
  readonly files: readonly ArtifactFile[];
  readonly totalBytes: number;
}
export interface PreparedArtifact {
  readonly artifact: InspectedArtifact;
  /** Calls the trusted synchronous factory and validates each returned declaration. */
  create(): PluginDefinition;
  /** Host must finish unloading ALL created instances before calling release. */
  release(): void;
}

const HASH = /^[a-f0-9]{64}$/;
const OPEN_FLAGS = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
const sha256 = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");

function within(root: string, filename: string): boolean {
  if (!path.isAbsolute(filename)) return false;
  const relative = path.relative(root, filename);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function relativeFile(value: unknown): string {
  if (typeof value !== "string" || !value || Buffer.byteLength(value) > ARTIFACT_LIMITS.pathBytes ||
      /[\x00-\x1f\x7f\\:]/.test(value) || path.posix.isAbsolute(value)) throw new ArtifactError("BOUNDARY");
  const parts = value.split("/");
  if (parts.length > ARTIFACT_LIMITS.pathDepth || parts.some(part => !part || part === "." || part === ".." ||
      /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new ArtifactError("BOUNDARY");
  return value;
}

function shape(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function fingerprints(value: unknown, limit: number, compare: (a: string, b: string) => number): readonly ArtifactFingerprint[] {
  if (!Array.isArray(value) || !value.length) throw new ArtifactError("FORMAT");
  if (value.length > limit) throw new ArtifactError("LIMIT");
  const result: ArtifactFingerprint[] = [];
  for (const entry of value) {
    if (!shape(entry, ["file", "sha256"]) || typeof entry.sha256 !== "string" || !HASH.test(entry.sha256)) throw new ArtifactError("FORMAT");
    const file = relativeFile(entry.file);
    if (result.length && compare(result[result.length - 1].file, file) >= 0) throw new ArtifactError("FORMAT");
    result.push(Object.freeze({file, sha256: entry.sha256}));
  }
  return Object.freeze(result);
}

function externalName(value: string): boolean {
  return isBuiltin(value) || /^(?:@[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_-][a-zA-Z0-9_.-]*(?:\/[a-zA-Z0-9_.-]+)*$/.test(value) &&
    !value.split("/").some(part => part === "." || part === "..") && !value.startsWith("@utils/");
}

function manifestFrom(text: string): ArtifactManifest {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new ArtifactError("FORMAT"); }
  if (!shape(value, ["schemaVersion", "apiVersion", "id", "entry", "sources", "imports", "files", "revision"]) ||
      value.schemaVersion !== 1 || value.apiVersion !== sdk.PLUGIN_API_VERSION || value.entry !== "index.cjs" ||
      typeof value.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value.id) ||
      typeof value.revision !== "string" || !HASH.test(value.revision)) throw new ArtifactError("FORMAT");
  const sources = fingerprints(value.sources, ARTIFACT_LIMITS.sources, (a, b) => a < b ? -1 : a > b ? 1 : 0);
  const files = fingerprints(value.files, ARTIFACT_LIMITS.files, (a, b) => a.localeCompare(b, "en"));
  if (!files.some(file => file.file === value.entry) || files.some(file => file.file === "manifest.json" || file.file === "build.json")) throw new ArtifactError("FORMAT");
  if (!Array.isArray(value.imports)) throw new ArtifactError("FORMAT");
  if (value.imports.length > ARTIFACT_LIMITS.imports) throw new ArtifactError("LIMIT");
  const imports: string[] = [];
  for (const name of value.imports) {
    if (typeof name !== "string" || name.length > ARTIFACT_LIMITS.pathBytes || !externalName(name) ||
        imports.length && imports[imports.length - 1] >= name) throw new ArtifactError("FORMAT");
    imports.push(name);
  }
  // This field order is the revision contract in build-v2-plugin.cjs.
  const content = {schemaVersion: 1 as const, apiVersion: sdk.PLUGIN_API_VERSION, id: value.id,
    entry: "index.cjs" as const, sources, imports: Object.freeze(imports), files};
  if (sha256(JSON.stringify(content)) !== value.revision) throw new ArtifactError("INTEGRITY");
  return Object.freeze({...content, revision: value.revision});
}

function directoryParts(directory: string): string[] {
  const base = path.parse(directory).root;
  const result = [base];
  for (const part of directory.slice(base.length).split(path.sep).filter(Boolean)) result.push(path.join(result[result.length - 1], part));
  return result;
}

async function checkDirectory(directory: string): Promise<void> {
  for (const part of directoryParts(directory)) {
    const stat = await fsp.lstat(part);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new ArtifactError("BOUNDARY");
  }
}

function unchanged(before: fs.Stats, after: fs.Stats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size &&
    before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}

async function readHashed(filename: string, limit: number, collect = false): Promise<{size: number; hash: string; bytes?: Buffer}> {
  const target = await fsp.lstat(filename);
  if (target.isSymbolicLink() || !target.isFile()) throw new ArtifactError("BOUNDARY");
  const handle = await fsp.open(filename, OPEN_FLAGS);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new ArtifactError("BOUNDARY");
    if (before.size > limit) throw new ArtifactError("LIMIT");
    const hash = createHash("sha256");
    const chunks: Buffer[] = [];
    let size = 0;
    const buffer = Buffer.alloc(65_536);
    for (;;) {
      const {bytesRead} = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > limit) throw new ArtifactError("LIMIT");
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      if (collect) chunks.push(Buffer.from(chunk));
    }
    const current = await fsp.lstat(filename);
    if (!current.isFile() || current.isSymbolicLink()) throw new ArtifactError("BOUNDARY");
    if (size !== before.size || !unchanged(before, await handle.stat()) || !unchanged(before, current)) throw new ArtifactError("INTEGRITY");
    return {size, hash: hash.digest("hex"), bytes: collect ? Buffer.concat(chunks) : undefined};
  } finally { await handle.close(); }
}

/**
 * Read-only inspection: no candidate code is required or executed. Source hashes
 * are provenance metadata, not signatures; the original source tree is not needed.
 * Files and all directory ancestors must be symlink-free. Roots may be relocated:
 * identity comes from the manifest content, not the directory's basename.
 */
export async function inspectArtifact(directory: string): Promise<InspectedArtifact> {
  try {
    if (typeof directory !== "string" || !directory || directory.includes("\0")) throw new ArtifactError("BOUNDARY");
    const root = path.resolve(directory);
    await checkDirectory(root);
    const metadata = await readHashed(path.join(root, "manifest.json"), ARTIFACT_LIMITS.manifestBytes, true);
    const manifest = manifestFrom(metadata.bytes!.toString("utf8"));
    const expected = new Map(manifest.files.map(file => [file.file, file]));
    const files: ArtifactFile[] = [];
    let totalBytes = 0;
    let entries = 0;
    async function visit(relative: string): Promise<void> {
      const dir = await fsp.opendir(path.join(root, relative));
      for await (const entry of dir) {
        if (++entries > ARTIFACT_LIMITS.treeEntries) throw new ArtifactError("LIMIT");
        const name = relativeFile(relative ? `${relative}/${entry.name}` : entry.name);
        const filename = path.join(root, name);
        const stat = await fsp.lstat(filename);
        if (stat.isSymbolicLink()) throw new ArtifactError("BOUNDARY");
        if (stat.isDirectory()) { await visit(name); continue; }
        if (!stat.isFile()) throw new ArtifactError("BOUNDARY");
        if (name === "manifest.json") continue;
        const fingerprint = expected.get(name);
        if (!fingerprint) throw new ArtifactError("INTEGRITY");
        const limit = Math.min(ARTIFACT_LIMITS.fileBytes, ARTIFACT_LIMITS.totalBytes - totalBytes,
          name === manifest.entry ? ARTIFACT_LIMITS.moduleBytes : ARTIFACT_LIMITS.fileBytes);
        const checked = await readHashed(filename, limit);
        if (checked.hash !== fingerprint.sha256) throw new ArtifactError("INTEGRITY");
        totalBytes += checked.size;
        files.push(Object.freeze({...fingerprint, size: checked.size}));
      }
    }
    await visit("");
    if (files.length !== manifest.files.length) throw new ArtifactError("INTEGRITY");
    await checkDirectory(root);
    if ((await readHashed(path.join(root, "manifest.json"), ARTIFACT_LIMITS.manifestBytes)).hash !== metadata.hash) throw new ArtifactError("INTEGRITY");
    files.sort((a, b) => a.file.localeCompare(b.file, "en"));
    return Object.freeze({directory: root, entryPath: path.join(root, manifest.entry), manifest,
      files: Object.freeze(files), totalBytes});
  } catch (error) {
    throw error instanceof ArtifactError ? error : new ArtifactError("IO");
  }
}

type CommonJSModule = NodeModule & { _compile(source: string, filename: string): void; };
interface Owner {
  artifact: InspectedArtifact;
  identity: string;
  active: boolean;
  factory?: () => unknown;
  modules: Map<string, NodeModule>;
}
const owners = new Map<string, Owner>();
const ownedDirectories = new Set<string>();
const sdkFilename = require.resolve("./sdk");

function captureOwned(owner: Owner): void {
  for (const [filename, mod] of Object.entries(require.cache)) {
    if (mod && within(owner.artifact.directory, filename) && !owner.modules.has(filename)) owner.modules.set(filename, mod);
  }
}

function unlink(targets: Set<NodeModule>): void {
  const parents = new Set<NodeModule>(targets);
  for (const mod of targets) if (mod.parent) parents.add(mod.parent);
  for (const mod of Object.values(require.cache)) if (mod) parents.add(mod);
  for (const mod of parents) {
    for (let index = mod.children.length - 1; index >= 0; index--) if (targets.has(mod.children[index])) mod.children.splice(index, 1);
    if (mod.parent && targets.has(mod.parent)) mod.parent = null;
  }
}

function releasedOperation(): never { throw new ArtifactError("RELEASED"); }

function releaseOwner(owner: Owner): void {
  if (!owner.active) return;
  owner.active = false;
  captureOwned(owner);
  unlink(new Set(owner.modules.values()));
  for (const [filename, mod] of owner.modules) {
    if (require.cache[filename] === mod) delete require.cache[filename];
    mod.parent = null;
    mod.children.length = 0;
    mod.exports = undefined;
    mod.require = releasedOperation;
  }
  owner.modules.clear();
  owner.factory = undefined;
  owners.delete(owner.identity);
  ownedDirectories.delete(owner.artifact.directory);
}

function verifiedModuleBytes(owner: Owner, filename: string): Buffer {
  const relative = path.relative(owner.artifact.directory, filename).split(path.sep).join("/");
  if (!within(owner.artifact.directory, filename)) throw new ArtifactError("BOUNDARY");
  const expected = owner.artifact.files.find(file => file.file === relative);
  if (!expected) throw new ArtifactError("INTEGRITY");
  for (const part of directoryParts(path.dirname(filename))) {
    const stat = fs.lstatSync(part);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new ArtifactError("BOUNDARY");
  }
  const descriptor = fs.openSync(filename, OPEN_FLAGS);
  try {
    const before = fs.fstatSync(descriptor);
    if (!before.isFile()) throw new ArtifactError("BOUNDARY");
    if (before.size > ARTIFACT_LIMITS.moduleBytes) throw new ArtifactError("LIMIT");
    if (before.size !== expected.size) throw new ArtifactError("INTEGRITY");
    const bytes = Buffer.alloc(before.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const count = fs.readSync(descriptor, bytes, size, bytes.length - size, null);
      if (!count) break;
      size += count;
    }
    const result = bytes.subarray(0, size);
    const current = fs.lstatSync(filename);
    if (current.isSymbolicLink() || !current.isFile()) throw new ArtifactError("BOUNDARY");
    if (!unchanged(before, current) || !unchanged(before, fs.fstatSync(descriptor)) || size !== expected.size || sha256(result) !== expected.sha256) throw new ArtifactError("INTEGRITY");
    return result;
  } finally { fs.closeSync(descriptor); }
}

function link(parent: NodeModule | undefined, child: NodeModule | undefined): void {
  if (parent && child && !parent.children.includes(child)) parent.children.push(child);
}

function loadOwned(owner: Owner, filename: string, parent?: NodeModule): unknown {
  if (!owner.active) throw new ArtifactError("RELEASED");
  const cached = require.cache[filename];
  if (cached) {
    if (owner.modules.get(filename) !== cached) throw new ArtifactError("BUSY");
    link(parent, cached);
    return cached.exports;
  }
  const extension = path.extname(filename);
  if (![".cjs", ".js", ".json"].includes(extension)) throw new ArtifactError("FORMAT");
  const source = verifiedModuleBytes(owner, filename).toString("utf8");
  const mod = new Module(filename) as CommonJSModule;
  mod.filename = filename;
  mod.parent = parent ?? null;
  const native = createRequire(filename);
  mod.paths = native.resolve.paths("telebox-artifact-dependency") ?? [];
  const resolveRequest = (request: string): string => {
    if (!owner.active) throw new ArtifactError("RELEASED");
    if (typeof request !== "string") throw new ArtifactError("FORMAT");
    if (request === "telebox/sdk") return sdkFilename;
    if (request.startsWith("./") || request.startsWith("../") || path.isAbsolute(request)) {
      const resolved = native.resolve(request);
      if (!within(owner.artifact.directory, resolved)) throw new ArtifactError("BOUNDARY");
      return resolved;
    }
    if (!externalName(request)) throw new ArtifactError("FORMAT");
    const resolved = native.resolve(request);
    if (within(owner.artifact.directory, resolved)) throw new ArtifactError("BOUNDARY");
    return resolved;
  };
  const scopedRequire = ((request: string): unknown => {
    const resolved = resolveRequest(request);
    if (request === "telebox/sdk") { link(mod, require.cache[sdkFilename]); return sdk; }
    if (within(owner.artifact.directory, resolved)) return loadOwned(owner, resolved, mod);
    // Shared packages are loaded by this runtime module, never owned or evicted.
    const value: unknown = require(resolved);
    link(mod, require.cache[resolved]);
    return value;
  }) as NodeJS.Require;
  scopedRequire.resolve = Object.assign(resolveRequest, {paths: native.resolve.paths});
  scopedRequire.cache = require.cache;
  scopedRequire.extensions = require.extensions;
  scopedRequire.main = require.main;
  mod.require = scopedRequire;
  owner.modules.set(filename, mod);
  require.cache[filename] = mod;
  link(parent, mod);
  try {
    if (extension === ".json") mod.exports = JSON.parse(source);
    else mod._compile(source, filename);
    mod.loaded = true;
    return mod.exports;
  } catch (error) {
    if (require.cache[filename] === mod) delete require.cache[filename];
    unlink(new Set([mod]));
    throw error instanceof ArtifactError ? error : new ArtifactError("LOAD");
  }
}

/**
 * Loads USER-TRUSTED local CJS only. inspectArtifact never executes candidates;
 * prepare evaluates module top level, and create evaluates the default factory.
 * Purity is a caller contract, not something a JS loader can prove or sandbox.
 * Neither function calls plugin setup/cleanup/settings factories or any host API.
 *
 * Rejects duplicate directory or id/revision ownership, including concurrent calls.
 * Keep the handle until the Host has drained/unloaded every created instance, then
 * release explicitly (also after a failed create). release is idempotent; it evicts
 * only artifact-owned CJS/JSON cache entries and removes their parent/child links.
 * Shared SDK/packages/native dependencies stay cached. No ESM/native-module unload
 * is attempted, and no global module-resolution hook is installed.
 *
 * The artifact tree must remain application-owned and immutable while held; source
 * fingerprints are not authenticity proofs. First loads of owned modules recheck
 * their bytes. Out-of-band require/cache mutation and malicious code are unsupported.
 * Runtime assets and external dependencies are not frozen by this handle. Node's
 * Module._compile is the narrow CJS adapter and must be regression-tested on Node 24.
 */
export async function prepareArtifact(directory: string): Promise<PreparedArtifact> {
  const artifact = await inspectArtifact(directory);
  const identity = `${artifact.manifest.id}:${artifact.manifest.revision}`;
  if (owners.has(identity) || ownedDirectories.has(artifact.directory) ||
      Object.keys(require.cache).some(filename => within(artifact.directory, filename))) throw new ArtifactError("BUSY");
  const owner: Owner = {artifact, identity, active: true, modules: new Map()};
  owners.set(identity, owner);
  ownedDirectories.add(artifact.directory);
  try {
    const exports = loadOwned(owner, artifact.entryPath);
    const factory: unknown = exports && (typeof exports === "object" || typeof exports === "function") ? (exports as {default?: unknown}).default : undefined;
    if (typeof factory !== "function" || types.isAsyncFunction(factory) || types.isGeneratorFunction(factory)) throw new ArtifactError("FACTORY");
    owner.factory = factory as () => unknown;
    captureOwned(owner);
  } catch (error) {
    releaseOwner(owner);
    throw error instanceof ArtifactError ? error : new ArtifactError("LOAD");
  }
  return Object.freeze({artifact,
    create(): PluginDefinition {
      if (!owner.active || !owner.factory) throw new ArtifactError("RELEASED");
      try {
        const factory = owner.factory;
        const value = factory();
        if (value && (typeof value === "object" || typeof value === "function") && typeof (value as {then?: unknown}).then === "function") {
          void Promise.resolve(value).catch(() => undefined);
          throw new ArtifactError("FACTORY");
        }
        const definition = sdk.definePlugin(value as PluginDefinition);
        if (definition.setup !== undefined && typeof definition.setup !== "function" ||
            definition.cleanup !== undefined && typeof definition.cleanup !== "function") throw new ArtifactError("FACTORY");
        if (definition.id !== artifact.manifest.id) throw new ArtifactError("IDENTITY");
        return definition;
      } catch (error) {
        throw error instanceof ArtifactError ? error : new ArtifactError("FACTORY");
      } finally { captureOwned(owner); }
    },
    release(): void { releaseOwner(owner); },
  });
}

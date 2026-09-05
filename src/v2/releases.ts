import path from "node:path";
import {prepareArtifact, type PreparedArtifact} from "./artifacts";
import {KeyedExecutor} from "./executor";
import {ResourceScope} from "./lifecycle";
import type {PluginHost} from "./host";
import type {JsonStore} from "./storage";

export interface ReleaseSelection extends Record<string, unknown> {
  current: string;
  previous?: string;
}
export interface ReleaseState extends Record<string, unknown> {
  schemaVersion: 1;
  plugins: Record<string, ReleaseSelection>;
}
export interface ReleaseOptions {
  artifactRoot: string;
  store: Pick<JsonStore<ReleaseState>, "read" | "update">;
  stopTimeoutMs?: number;
  queueCapacity?: number;
}
export type ReleaseErrorCode = "STATE" | "CONFLICT" | "STOP" | "ACTIVATE" | "RESTORE" | "NO_PREVIOUS";
const messages: Record<ReleaseErrorCode, string> = {
  STATE: "Invalid plugin release state",
  CONFLICT: "Plugin release is managed elsewhere or conflicts with another plugin",
  STOP: "Plugin generation has not stopped cleanly",
  ACTIVATE: "Plugin activation failed; the prior selection is unchanged",
  RESTORE: "Plugin activation failed and the prior generation could not be restored",
  NO_PREVIOUS: "No previous plugin release is recorded",
};
export class ReleaseError extends Error {
  constructor(readonly code: ReleaseErrorCode) { super(messages[code]); this.name = "ReleaseError"; }
}
interface Generation { handle: PreparedArtifact; state: "active" | "draining" | "failed"; owner: object; }
const revisionPattern = /^[a-f0-9]{64}$/;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
function validate(state: ReleaseState): void {
  if (!state || state.schemaVersion !== 1 || !state.plugins || typeof state.plugins !== "object" || Array.isArray(state.plugins)) {
    throw new ReleaseError("STATE");
  }
  for (const [id, selection] of Object.entries(state.plugins)) {
    if (!idPattern.test(id) || !selection || typeof selection !== "object" || Array.isArray(selection) ||
        !revisionPattern.test(selection.current) || selection.previous !== undefined && !revisionPattern.test(selection.previous)) {
      throw new ReleaseError("STATE");
    }
  }
}

/**
 * Owns trusted plugin generations, not their data. Commands submit management
 * work through an external coordinator: an active handler cannot unload itself.
 * The store must have a single process owner. Crash-atomic data migrations and
 * inter-process deployment locks belong to the account deployment controller.
 */
export class PluginReleases {
  private readonly scope: ResourceScope;
  private readonly queue: KeyedExecutor;
  private readonly generations = new Map<string, Generation>();
  private readonly stopTimeout: number;

  constructor(private readonly host: PluginHost, private readonly options: ReleaseOptions, parent?: AbortSignal) {
    this.scope = new ResourceScope(parent);
    this.stopTimeout = options.stopTimeoutMs ?? 15000;
    this.scope.assertCanDrain(this.stopTimeout);
    // A single management lane makes command reservations and pointer commits
    // deterministic while ordinary plugins continue in the host's own executor.
    this.queue = new KeyedExecutor(1, options.queueCapacity ?? 16, this.scope.signal);
    this.scope.add("release-generations", async () => {
      const failures: unknown[] = [];
      await Promise.all([this.queue.close(), ...[...this.generations].map(async ([id, generation]) => {
        generation.state = "draining";
        let report;
        do { report = await this.host.unload(id, 15000, generation.owner); }
        while (report && (report.pendingTasks || report.pendingResources));
        if (report && !report.completed) {
          generation.state = "failed";
          failures.push(new ReleaseError("STOP"));
        } else {
          generation.handle.release();
          if (this.generations.get(id) === generation) this.generations.delete(id);
        }
      })]);
      if (failures.length) throw new AggregateError(failures, "Plugin release cleanup failed");
    });
  }

  snapshot() {
    return {generations: [...this.generations].map(([id, generation]) => ({id,
      revision: generation.handle.artifact.manifest.revision, state: generation.state})),
      queue: this.queue.snapshot(), lifecycle: this.scope.snapshot()};
  }

  activate(id: string, revision: string): Promise<void> {
    if (!idPattern.test(id) || !revisionPattern.test(revision)) return Promise.reject(new ReleaseError("STATE"));
    return this.scope.run("release:activate", signal => this.queue.submit(id, () => this.change(id, revision, signal), signal));
  }

  rollback(id: string): Promise<void> {
    if (!idPattern.test(id)) return Promise.reject(new ReleaseError("STATE"));
    return this.scope.run("release:rollback", signal => this.queue.submit(id, async () => {
      const state = await this.options.store.read(signal);
      validate(state);
      const previous = Object.hasOwn(state.plugins, id) ? state.plugins[id].previous : undefined;
      if (!previous) throw new ReleaseError("NO_PREVIOUS");
      await this.change(id, previous, signal);
    }, signal));
  }

  shutdown(timeoutMs = 15000) {
    this.scope.assertCanDrain(timeoutMs);
    for (const [id, generation] of this.generations) this.host.assertCanUnload(id, timeoutMs, generation.owner);
    return this.scope.drain(timeoutMs);
  }

  private async change(id: string, revision: string, signal: AbortSignal): Promise<void> {
    const state = await this.options.store.read(signal);
    validate(state);
    const selected = Object.hasOwn(state.plugins, id) ? state.plugins[id] : undefined;
    const old = this.generations.get(id);
    if (!old && this.host.pluginState(id)) throw new ReleaseError("CONFLICT");
    if (old && this.host.pluginState(id) && !this.host.pluginState(id, old.owner)) throw new ReleaseError("CONFLICT");
    this.host.assertCanUnload(id, this.stopTimeout, old?.owner);
    if (old?.state === "active" && this.host.pluginState(id, old.owner) === "active" && old.handle.artifact.manifest.revision === revision) {
      if (selected?.current !== revision) throw new ReleaseError("STATE");
      return;
    }

    // Prepare checks all hashes before executing the trusted, pure declaration
    // factory. No candidate setup occurs until the old generation fully stops.
    const candidate = old?.handle.artifact.manifest.revision === revision ? old.handle :
      await prepareArtifact(path.join(this.options.artifactRoot, id, revision));
    let candidateOwned = candidate === old?.handle;
    try {
      if (candidate.artifact.manifest.id !== id || candidate.artifact.manifest.revision !== revision) throw new ReleaseError("STATE");
      const definition = candidate.create();
      try { this.host.preflight(definition, old ? id : undefined); }
      catch { throw new ReleaseError("CONFLICT"); }
      signal.throwIfAborted();
      if (old) {
        old.state = "draining";
        const report = await this.host.unload(id, this.stopTimeout, old.owner);
        if (report && !report.completed) throw new ReleaseError("STOP");
      }
      signal.throwIfAborted();
      const generation: Generation = {handle: candidate, state: "draining", owner: Object.freeze({})};
      this.generations.set(id, generation);
      candidateOwned = true;
      try {
        await this.host.load(definition, generation.owner);
        signal.throwIfAborted();
        await this.options.store.update(current => {
          validate(current);
          const existing = Object.hasOwn(current.plugins, id) ? current.plugins[id] : undefined;
          if (existing?.current !== selected?.current || existing?.previous !== selected?.previous) throw new ReleaseError("STATE");
          return {...current, plugins: {...current.plugins, [id]: {...existing, current: revision,
            ...(selected?.current && selected.current !== revision ? {previous: selected.current} : {})}}};
        }, signal);
        generation.state = "active";
        if (old && old.handle !== candidate) old.handle.release();
      } catch {
        generation.state = "draining";
        const report = await this.host.unload(id, this.stopTimeout, generation.owner);
        if (report && !report.completed) {
          generation.state = "failed";
          // A failed candidate still owns its code; the old handle is idle and
          // can be loaded from its immutable artifact on a later recovery.
          if (old && old.handle !== candidate) old.handle.release();
          throw new ReleaseError("RESTORE");
        }
        this.generations.delete(id);
        if (candidate !== old?.handle) { candidate.release(); candidateOwned = false; }
        if (old && !signal.aborted) {
          this.generations.set(id, old);
          try { await this.host.load(old.handle.create(), old.owner); old.state = "active"; }
          catch { old.state = "failed"; throw new ReleaseError("RESTORE"); }
        } else if (old) {
          old.handle.release();
          candidateOwned = false;
        }
        throw new ReleaseError("ACTIVATE");
      }
    } finally {
      if (!candidateOwned) candidate.release();
    }
  }
}

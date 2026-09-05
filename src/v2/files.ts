import path from "node:path";
import {lstat, mkdir, mkdtemp, rm} from "node:fs/promises";
import {ResourceScope} from "./lifecycle";

async function directory(target: string, signal: AbortSignal): Promise<void> {
  let current = path.parse(target).root;
  for (const segment of target.slice(current.length).split(path.sep).filter(Boolean)) {
    signal.throwIfAborted();
    current = path.join(current, segment);
    try { await mkdir(current, {mode: 0o700}); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Plugin path must be an ordinary directory");
  }
  signal.throwIfAborted();
}

function relativeFile(relative: string): void {
  if (!relative || path.isAbsolute(relative) || relative.includes('\\') || /[\x00-\x1f]/.test(relative) ||
      relative.split('/').some(part => !part || part === '.' || part === '..')) throw new Error("Invalid plugin data path");
}

/** Paths are for trusted plugin/native-library use, not a hostile-filesystem sandbox. */
export class ScopedFiles {
  private readonly data: string;
  private readonly temporary: string;

  constructor(private readonly scope: ResourceScope, dataRoot: string, tempRoot: string, pluginId: string) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(pluginId)) throw new Error("Invalid plugin file owner");
    this.data = path.resolve(dataRoot, pluginId);
    this.temporary = path.resolve(tempRoot, pluginId);
  }

  dataDirectory(relative?: string): Promise<string> {
    return this.scope.run('files:directory', async signal => {
      if (relative !== undefined) relativeFile(relative);
      const target = relative === undefined ? this.data : path.join(this.data, relative);
      await directory(target, signal);
      return target;
    });
  }

  /** Resolves a writable data filename; actual I/O must stay inside a tracked task. */
  dataFile(relative: string): Promise<string> {
    return this.scope.run('files:path', async signal => {
      relativeFile(relative);
      const target = path.join(this.data, relative);
      await directory(path.dirname(target), signal);
      try {
        const stat = await lstat(target);
        if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Plugin data target must be a regular file");
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
      signal.throwIfAborted();
      return target;
    });
  }

  /** Temp files survive cancellation until the callback and all its awaited work finish. */
  withTemp<T>(use: (directory: string, signal: AbortSignal) => Promise<T>): Promise<T> {
    return this.scope.run('files:temporary', async signal => {
      await directory(this.temporary, signal);
      const temporary = await mkdtemp(path.join(this.temporary, 'job-'));
      try {
        signal.throwIfAborted();
        const result = await use(temporary, signal);
        signal.throwIfAborted();
        return result;
      } finally {
        await rm(temporary, {recursive: true, force: true});
      }
    });
  }
}

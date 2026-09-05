import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";

export interface DrainReport {
  /** All work settled, without timeout or recorded cleanup failures. */
  completed: boolean;
  timedOut: boolean;
  pendingTasks: number;
  pendingResources: number;
  /** Cleanup failures only; task rejections are returned to their callers. */
  errors: readonly unknown[];
}

export class SelfDrainError extends Error {
  constructor(label: string) {
    super(`Task "${label}" cannot drain its own scope; use an external coordinator`);
    this.name = "SelfDrainError";
  }
}

interface TaskEntry {
  label: string;
}

interface TaskContext {
  entry: TaskEntry;
  parent?: TaskContext;
}

interface ResourceEntry {
  label: string;
  cleanup?: () => void | Promise<void>;
  promise?: Promise<void>;
}

// Context contains only task identities, never scopes, callbacks or results.
const currentTask = new AsyncLocalStorage<TaskContext>();
const DEFAULT_DRAIN_TIMEOUT_MS = 15_000;
/** Each scope retains its most recent 100 cleanup failures, in settlement order. */
export const RESOURCE_SCOPE_ERROR_LIMIT = 100;

function observed<T>(promise: Promise<T>): Promise<T> {
  // Callers still receive rejection, but ignoring a returned promise is safe.
  void promise.catch(() => undefined);
  return promise;
}

export class ResourceScope {
  private readonly controller = new AbortController();
  private readonly tasks = new Set<TaskEntry>();
  private readonly resources = new Set<ResourceEntry>();
  private readonly waiters = new Set<() => void>();
  private readonly errors: unknown[] = [];
  private lifecycleState: "active" | "draining" | "disposed" = "active";
  private drainStarted = false;
  private timedOut = false;
  private detachParent?: () => void;

  constructor(parent?: AbortSignal) {
    if (!parent) return;
    if (parent.aborted) {
      this.abort(parent.reason);
      return;
    }
    const onAbort = (): void => this.abort(parent.reason);
    parent.addEventListener("abort", onAbort, { once: true });
    this.detachParent = () => parent.removeEventListener("abort", onAbort);
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get state(): "active" | "draining" | "disposed" {
    return this.lifecycleState;
  }

  /** Task rejections are observed and returned, but not retained by the scope. */
  run<T>(label: string, fn: (signal: AbortSignal) => T | Promise<T>): Promise<T> {
    if (this.signal.aborted) return observed(Promise.reject(this.signal.reason));

    const entry: TaskEntry = { label };
    this.tasks.add(entry);
    const context: TaskContext = { entry, parent: currentTask.getStore() };
    const result = new Promise<T>((resolve, reject) => {
      currentTask.run(context, () => {
        try {
          resolve(fn(this.signal));
        } catch (error) {
          reject(error);
        }
      });
    });
    return observed(result.then(
      (value) => {
        this.tasks.delete(entry);
        this.settleIfIdle();
        return value;
      },
      (error: unknown) => {
        this.tasks.delete(entry);
        this.settleIfIdle();
        throw error;
      },
    ));
  }

  /** The returned disposer starts cleanup once and reuses its settlement. */
  add(label: string, cleanup: () => void | Promise<void>): () => Promise<void> {
    const entry: ResourceEntry = { label, cleanup };
    this.resources.add(entry);
    if (this.lifecycleState !== "active") {
      this.lifecycleState = "draining";
      this.startResource(entry);
    }
    return () => this.startResource(entry);
  }

  /** Signal cancellation only; an external coordinator must call drain. */
  abort(reason?: unknown): void {
    if (this.signal.aborted) return;
    this.lifecycleState = "draining";
    this.controller.abort(reason);
  }

  /** Synchronous, side-effect-free preflight for coordinators changing host state. */
  assertCanDrain(timeoutMs = DEFAULT_DRAIN_TIMEOUT_MS): void {
    for (let context = currentTask.getStore(); context; context = context.parent) {
      if (this.tasks.has(context.entry)) {
        throw new SelfDrainError(context.entry.label);
      }
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 2_147_483_647) {
      throw new RangeError("timeoutMs must be finite and between 0 and 2147483647");
    }
  }

  /**
   * Each caller has its own deadline covering tasks and cleanup together.
   * Timed-out work remains tracked; subsequent drains can wait for it again.
   * As with any JS timer, synchronous code cannot be preempted.
   */
  drain(timeoutMs = DEFAULT_DRAIN_TIMEOUT_MS): Promise<DrainReport> {
    try {
      this.assertCanDrain(timeoutMs);
    } catch (error) {
      return observed(Promise.reject(error));
    }

    const deadline = performance.now() + timeoutMs;
    this.drainStarted = true;
    this.abort();
    // Snapshot iteration avoids revisiting registrations made by cleanup.
    for (const entry of [...this.resources]) this.startResource(entry);
    this.settleIfIdle();
    if (this.lifecycleState === "disposed") return Promise.resolve(this.snapshot());

    return new Promise<DrainReport>((resolve) => {
      const finish = (timedOut: boolean): void => {
        clearTimeout(timer);
        this.waiters.delete(onSettled);
        if (timedOut && this.lifecycleState !== "disposed") this.timedOut = true;
        const report = this.snapshot();
        resolve({ ...report, completed: !timedOut && report.completed, timedOut });
      };
      const onSettled = (): void => finish(performance.now() >= deadline);
      const timer = setTimeout(() => finish(true), Math.max(0, deadline - performance.now()));
      this.waiters.add(onSettled);
    });
  }

  snapshot(): DrainReport {
    return {
      completed: this.lifecycleState === "disposed" && !this.timedOut && this.errors.length === 0,
      timedOut: this.timedOut,
      pendingTasks: this.tasks.size,
      pendingResources: this.resources.size,
      errors: this.errors.slice(),
    };
  }

  private startResource(entry: ResourceEntry): Promise<void> {
    if (entry.promise) return entry.promise;

    // Publish the promise before calling user code, including reentrant disposers.
    let resolve!: (value: void | PromiseLike<void>) => void;
    let reject!: (reason: unknown) => void;
    const result = new Promise<void>((resolveResult, rejectResult) => {
      resolve = resolveResult;
      reject = rejectResult;
    });
    entry.promise = observed(result.then(
      () => {
        this.resources.delete(entry);
        this.settleIfIdle();
      },
      (error: unknown) => {
        this.recordError(error);
        this.resources.delete(entry);
        this.settleIfIdle();
        throw error;
      },
    ));
    const cleanup = entry.cleanup!;
    entry.cleanup = undefined;
    try {
      resolve(cleanup());
    } catch (error) {
      reject(error);
    }
    return entry.promise;
  }

  private recordError(error: unknown): void {
    if (this.errors.length === RESOURCE_SCOPE_ERROR_LIMIT) this.errors.shift();
    this.errors.push(error);
  }

  private settleIfIdle(): void {
    if (!this.drainStarted || this.tasks.size > 0 || this.resources.size > 0) return;
    this.lifecycleState = "disposed";
    this.timedOut = false;
    this.detachParent?.();
    this.detachParent = undefined;
    for (const waiter of this.waiters) waiter();
  }
}

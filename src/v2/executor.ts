export class QueueFullError extends Error {
  constructor() { super("Execution queue is full"); this.name = "QueueFullError"; }
}

export class ExecutorClosedError extends Error {
  constructor() { super("Execution queue is closed"); this.name = "ExecutorClosedError"; }
}

export class ReentrantExecutionError extends Error {
  constructor() { super("A running task cannot submit to its own executor; use an external coordinator"); this.name = "ReentrantExecutionError"; }
}

interface Job {
  active: boolean;
  key: string;
  signal: AbortSignal;
  run: (signal: AbortSignal) => unknown | Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  detach: () => void;
}

// Pending callbacks are bounded; active work retains its slot until it settles,
// including after cancellation. Keys prevent concurrent work in one dialogue.
export class KeyedExecutor {
  private readonly controller = new AbortController();
  private readonly queue: Job[] = [];
  private readonly activeKeys = new Set<string>();
  private readonly execution = new AsyncLocalStorage<Job>();
  private active = 0;
  private closed = false;
  private idleResolve?: () => void;
  private readonly idle: Promise<void>;
  private detachParent = () => {};

  constructor(readonly concurrency = 4, readonly capacity = 64, parent?: AbortSignal) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || !Number.isSafeInteger(capacity) || capacity < 0) {
      throw new RangeError("Executor requires positive concurrency and non-negative capacity");
    }
    this.idle = new Promise(resolve => { this.idleResolve = resolve; });
    if (parent) {
      const abort = () => { void this.close(parent.reason); };
      parent.addEventListener("abort", abort, {once: true});
      this.detachParent = () => parent.removeEventListener("abort", abort);
      if (parent.aborted) abort();
    }
  }

  snapshot() { return {active: this.active, queued: this.queue.length, closed: this.closed}; }

  submit<T>(key: string, run: (signal: AbortSignal) => T | Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.closed) return Promise.reject(new ExecutorClosedError());
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.execution.getStore()?.active) return Promise.reject(new ReentrantExecutionError());
    const immediate = this.active < this.concurrency && !this.activeKeys.has(key) && !this.queue.some(job => job.key === key);
    if (!immediate && this.queue.length >= this.capacity) return Promise.reject(new QueueFullError());
    const combined = signal ? AbortSignal.any([this.controller.signal, signal]) : this.controller.signal;
    return new Promise<T>((resolve, reject) => {
      const resume = AsyncLocalStorage.snapshot();
      const job: Job = {active: false, key, signal: combined,
        run: signal => resume(() => this.execution.run(job, () => run(signal))),
        resolve: value => resolve(value as T), reject, detach: () => {}};
      const abort = () => {
        const index = this.queue.indexOf(job);
        if (index < 0) return;
        this.queue.splice(index, 1);
        job.detach();
        reject(combined.reason);
        this.pump();
      };
      combined.addEventListener("abort", abort, {once: true});
      job.detach = () => combined.removeEventListener("abort", abort);
      if (immediate) this.start(job);
      else this.queue.push(job);
    });
  }

  private start(job: Job): void {
    this.active++;
    job.active = true;
    this.activeKeys.add(job.key);
    job.detach();
    void Promise.resolve().then(() => {
      job.signal.throwIfAborted();
      return job.run(job.signal);
    }).then(value => {
      job.active = false;
      this.active--;
      this.activeKeys.delete(job.key);
      this.pump();
      job.resolve(value);
    }, error => {
      job.active = false;
      this.active--;
      this.activeKeys.delete(job.key);
      this.pump();
      job.reject(error);
    });
  }

  private pump(): void {
    while (!this.closed && this.active < this.concurrency) {
      const index = this.queue.findIndex(job => !this.activeKeys.has(job.key));
      if (index < 0) break;
      this.start(this.queue.splice(index, 1)[0]);
    }
    if (this.closed && this.active === 0) {
      this.detachParent();
      this.idleResolve?.();
      this.idleResolve = undefined;
    }
  }

  close(reason: unknown = new ExecutorClosedError()): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      // Clear pending work before aborting: abort callbacks cannot mutate this batch.
      const pending = this.queue.splice(0);
      for (const job of pending) { job.detach(); job.reject(reason); }
      this.controller.abort(reason);
      this.pump();
    }
    return this.idle;
  }
}
import {AsyncLocalStorage} from "node:async_hooks";

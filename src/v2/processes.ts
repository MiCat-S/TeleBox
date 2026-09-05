import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { inspect } from "node:util";
import { ExecutorClosedError, KeyedExecutor, QueueFullError } from "./executor";
import { ResourceScope } from "./lifecycle";

export interface ProcessLimits {
  concurrency?: number;
  queueCapacity?: number;
  /** Combined retained stdout + stderr bytes; default 1 MiB. */
  maxOutputBytes?: number;
  /** Per-invocation stdin bytes, including queued input; default 1 MiB. */
  maxInputBytes?: number;
  /** Execution deadline, excluding queue wait; default 30 seconds. */
  timeoutMs?: number;
  /** TERM-to-KILL interval; default 250 ms. Zero schedules immediate escalation. */
  killGraceMs?: number;
}

export interface ProcessRunOptions {
  /** Absolute directory; defaults to the caller's cwd captured at admission. */
  cwd?: string;
  /** Exact environment, not an overlay on process.env; defaults to empty. */
  env?: Readonly<NodeJS.ProcessEnv>;
  input?: string | Uint8Array;
  signal?: AbortSignal;
  /** Per-call overrides can only tighten the runner's limits. */
  timeoutMs?: number;
  killGraceMs?: number;
  maxOutputBytes?: number;
}

export interface ProcessResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
}

type FailureKind = "spawn" | "exit" | "aborted" | "timeout" | "output" | "io" | "control";
export type ProcessErrorCode = "SPAWN_FAILED" | "EXIT_FAILED" | "ABORTED" | "TIMED_OUT" |
  "OUTPUT_LIMIT" | "IO_FAILED" | "CONTROL_FAILED" | "CLOSED";

interface CapturedOutput { stdout: Buffer; stderr: Buffer; exitCode: number | null; signal: NodeJS.Signals | null; }

/** Output is available to the caller, but excluded from normal error inspection/JSON. */
export class ProcessError extends Error {
  declare readonly stdout: Buffer;
  declare readonly stderr: Buffer;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;

  constructor(readonly code: ProcessErrorCode, message: string, output?: CapturedOutput) {
    super(message);
    this.name = "ProcessError";
    this.exitCode = output?.exitCode ?? null;
    this.signal = output?.signal ?? null;
    Object.defineProperties(this, {
      stdout: { value: output?.stdout ?? Buffer.alloc(0) },
      stderr: { value: output?.stderr ?? Buffer.alloc(0) },
    });
  }

  [inspect.custom](): string { return `${this.name}: ${this.message}`; }
}

export class ProcessSpawnError extends ProcessError {
  constructor(output?: CapturedOutput) { super("SPAWN_FAILED", "Helper process could not start", output); this.name = "ProcessSpawnError"; }
}
export class ProcessExitError extends ProcessError {
  constructor(output: CapturedOutput) { super("EXIT_FAILED", "Helper process exited unsuccessfully", output); this.name = "ProcessExitError"; }
}
export class ProcessAbortedError extends ProcessError {
  constructor(output?: CapturedOutput) { super("ABORTED", "Helper process was cancelled", output); this.name = "ProcessAbortedError"; }
}
export class ProcessTimeoutError extends ProcessError {
  constructor(output: CapturedOutput) { super("TIMED_OUT", "Helper process exceeded its execution deadline", output); this.name = "ProcessTimeoutError"; }
}
export class ProcessOutputLimitError extends ProcessError {
  constructor(output: CapturedOutput) { super("OUTPUT_LIMIT", "Helper process exceeded its output limit", output); this.name = "ProcessOutputLimitError"; }
}
export class ProcessClosedError extends ProcessError {
  constructor() { super("CLOSED", "Helper process runner is closed"); this.name = "ProcessClosedError"; }
}

interface Invocation {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  input?: Buffer;
  timeoutMs: number;
  killGraceMs: number;
  maxOutputBytes: number;
}

const POSIX_GROUPS = process.platform !== "win32";
const TIMER_MAX = 2_147_483_647;
const GROUP_POLL_MS = 20;

function integer(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError("Invalid helper process limit");
  }
  return value;
}

function observed<T>(promise: Promise<T>): Promise<T> {
  void promise.catch(() => undefined);
  return promise;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ESRCH";
}

function failure(kind: FailureKind, output: CapturedOutput): ProcessError {
  switch (kind) {
    case "spawn": return new ProcessSpawnError(output);
    case "exit": return new ProcessExitError(output);
    case "aborted": return new ProcessAbortedError(output);
    case "timeout": return new ProcessTimeoutError(output);
    case "output": return new ProcessOutputLimitError(output);
    case "io": return new ProcessError("IO_FAILED", "Helper process pipe failed", output);
    case "control": return new ProcessError("CONTROL_FAILED", "Helper process termination could not be confirmed", output);
  }
}

/**
 * Owns bounded, scope-tracked helper invocations. Commands must be absolute paths;
 * arguments are passed verbatim, shell=false, and environment inheritance is opt-in.
 * close() rejects new work, cancels queued work, and waits for actual reclamation.
 * Use scope.drain(deadline) to observe a bounded shutdown without releasing live work.
 *
 * POSIX: each child leads a new process group (detached, never unref'd). Leader
 * exit ends the invocation: remaining group members receive TERM then KILL even
 * after the leader's pipes close. Settlement requires child close AND ESRCH for
 * the group. Unreaped or unkillable members keep the task/slot pending. A helper
 * that escapes via setsid/setpgid is outside this process-group contract; this is
 * not an untrusted-process sandbox. The systemd cgroup is the outer service boundary.
 *
 * Windows: only the direct child is controlled, using Node's signal emulation;
 * neither graceful POSIX signals nor descendant-tree reclamation is promised.
 * Limits cover captured bytes and queued stdin, not child CPU/RSS or OS pipe buffers.
 * No command, arguments, environment, output, or caller cancellation reason is logged.
 */
export class ScopedProcesses {
  private readonly executor: KeyedExecutor;
  private readonly dispose: () => Promise<void>;
  private readonly limits: Required<ProcessLimits>;
  private closed = false;
  private sequence = 0;

  constructor(private readonly scope: ResourceScope, limits: ProcessLimits = {}) {
    this.limits = {
      concurrency: integer(limits.concurrency ?? 1, 1, Number.MAX_SAFE_INTEGER),
      queueCapacity: integer(limits.queueCapacity ?? 8, 0, Number.MAX_SAFE_INTEGER),
      maxOutputBytes: integer(limits.maxOutputBytes ?? 1_048_576, 0, Number.MAX_SAFE_INTEGER),
      maxInputBytes: integer(limits.maxInputBytes ?? 1_048_576, 0, Number.MAX_SAFE_INTEGER),
      timeoutMs: integer(limits.timeoutMs ?? 30_000, 1, TIMER_MAX),
      killGraceMs: integer(limits.killGraceMs ?? 250, 0, TIMER_MAX),
    };
    this.executor = new KeyedExecutor(this.limits.concurrency, this.limits.queueCapacity, scope.signal);
    this.dispose = scope.add("helper-processes", () => {
      this.closed = true;
      return this.executor.close(new ProcessClosedError());
    });
  }

  snapshot() {
    return { ...this.executor.snapshot(), containment: POSIX_GROUPS ? "process-group" as const : "single-process" as const };
  }

  run(command: string, args: readonly string[] = [], options: ProcessRunOptions = {}): Promise<ProcessResult> {
    try {
      if (this.closed || this.scope.signal.aborted) return observed(Promise.reject(new ProcessClosedError()));
      if (options.signal?.aborted) return observed(Promise.reject(new ProcessAbortedError()));
      const invocation = this.prepare(command, args, options);
      const signal = options.signal ? AbortSignal.any([this.scope.signal, options.signal]) : this.scope.signal;
      const task = this.scope.run("helper-process", () => this.executor.submit(String(++this.sequence),
        signal => this.execute(invocation, signal), signal));
      return observed(task.catch(error => {
        if (signal.aborted && error === signal.reason) {
          throw this.scope.signal.aborted ? new ProcessClosedError() : new ProcessAbortedError();
        }
        if (error instanceof ProcessError || error instanceof QueueFullError) throw error;
        if (error instanceof ExecutorClosedError || this.closed || this.scope.signal.aborted) throw new ProcessClosedError();
        if (signal.aborted) throw new ProcessAbortedError();
        // Native errors may contain argv/path details; never preserve their cause/message.
        throw new ProcessError("IO_FAILED", "Helper process invocation failed");
      }));
    } catch {
      return observed(Promise.reject(new TypeError("Invalid helper process invocation options")));
    }
  }

  close(): Promise<void> { return this.dispose(); }

  private prepare(command: string, args: readonly string[], options: ProcessRunOptions): Invocation {
    if (typeof command !== "string" || !path.isAbsolute(command) || command.includes("\0") ||
        !Array.isArray(args) || args.some(arg => typeof arg !== "string" || arg.includes("\0"))) {
      throw new TypeError("Invalid helper process command");
    }
    const cwd = options.cwd ?? process.cwd();
    if (typeof cwd !== "string" || !path.isAbsolute(cwd) || cwd.includes("\0")) throw new TypeError("Invalid helper cwd");
    const env: NodeJS.ProcessEnv = Object.create(null);
    for (const [key, value] of Object.entries(options.env ?? {})) {
      if (!key || key.includes("=") || key.includes("\0") ||
          (value !== undefined && (typeof value !== "string" || value.includes("\0")))) throw new TypeError("Invalid helper environment");
      if (value !== undefined) env[key] = value;
    }
    let input: Buffer | undefined;
    if (options.input !== undefined) {
      if (typeof options.input !== "string" && !(options.input instanceof Uint8Array)) throw new TypeError("Invalid helper input");
      const size = typeof options.input === "string" ? Buffer.byteLength(options.input) : options.input.byteLength;
      integer(size, 0, this.limits.maxInputBytes);
      input = Buffer.from(options.input);
    }
    return { command, args: [...args], cwd, env, input,
      timeoutMs: integer(options.timeoutMs ?? this.limits.timeoutMs, 1, this.limits.timeoutMs),
      killGraceMs: integer(options.killGraceMs ?? this.limits.killGraceMs, 0, this.limits.killGraceMs),
      maxOutputBytes: integer(options.maxOutputBytes ?? this.limits.maxOutputBytes, 0, this.limits.maxOutputBytes),
    };
  }

  private execute(invocation: Invocation, signal: AbortSignal): Promise<ProcessResult> {
    if (signal.aborted) return Promise.reject(new ProcessAbortedError());
    return new Promise<ProcessResult>((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(invocation.command, invocation.args, {
          cwd: invocation.cwd, env: invocation.env, shell: false, detached: POSIX_GROUPS,
          windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
        });
      } catch {
        reject(new ProcessSpawnError());
        return;
      }
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let retainedBytes = 0;
      let exited = false;
      let closed = false;
      let settled = false;
      let stopping = false;
      let escalated = false;
      let kind: FailureKind | undefined;
      let exitCode: number | null = null;
      let exitSignal: NodeJS.Signals | null = null;
      let poll: ReturnType<typeof setTimeout> | undefined;
      let grace: ReturnType<typeof setTimeout> | undefined;
      let deadline: ReturnType<typeof setTimeout> | undefined;

      const alive = (): boolean => {
        if (!child.pid) return false;
        if (!POSIX_GROUPS) return !exited;
        try { process.kill(-child.pid, 0); return true; }
        catch (error) {
          if (isMissing(error)) return false;
          // Permission/probe failures are not evidence of process-group exit.
          kind ??= "control";
          return true;
        }
      };
      const send = (termination: "SIGTERM" | "SIGKILL"): void => {
        if (!child.pid || (!POSIX_GROUPS && exited)) return;
        try {
          if (POSIX_GROUPS) process.kill(-child.pid, termination);
          else child.kill(termination);
        } catch (error) {
          if (!isMissing(error)) kind ??= "control";
        }
      };
      const finish = (): void => {
        settled = true;
        clearTimeout(deadline); clearTimeout(grace); clearTimeout(poll);
        signal.removeEventListener("abort", onAbort);
        child.off("error", onError); child.off("exit", onExit); child.off("close", onClose);
        child.stdin.off("error", onPipeError);
        child.stdout.off("error", onPipeError); child.stderr.off("error", onPipeError);
        child.stdout.off("data", onStdout); child.stderr.off("data", onStderr);
        const output = {stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), exitCode, signal: exitSignal};
        if (kind) reject(failure(kind, output));
        else if (exitCode !== 0 || exitSignal) reject(new ProcessExitError(output));
        else resolve({stdout: output.stdout, stderr: output.stderr, exitCode: 0});
      };
      const check = (): void => {
        if (settled) return;
        const live = alive();
        if (closed && !live) { finish(); return; }
        if (stopping && !poll) {
          poll = setTimeout(() => {
            poll = undefined;
            if (escalated && alive()) send("SIGKILL");
            check();
          }, GROUP_POLL_MS);
        }
      };
      const stop = (reason?: FailureKind): void => {
        if (settled) return;
        if (reason) kind ??= reason;
        if (!stopping) {
          stopping = true;
          child.stdin.destroy();
          send("SIGTERM");
          grace = setTimeout(() => {
            escalated = true;
            send("SIGKILL");
            check();
          }, invocation.killGraceMs);
        }
        check();
      };
      const capture = (chunks: Buffer[], chunk: Buffer): void => {
        const keep = Math.min(chunk.length, invocation.maxOutputBytes - retainedBytes);
        if (keep > 0) { chunks.push(Buffer.from(chunk.subarray(0, keep))); retainedBytes += keep; }
        if (keep < chunk.length) stop("output");
      };
      const onStdout = (chunk: Buffer): void => capture(stdout, chunk);
      const onStderr = (chunk: Buffer): void => capture(stderr, chunk);
      const onPipeError = (): void => { if (!stopping) stop("io"); };
      const onError = (): void => {
        if (!child.pid) { kind = "spawn"; exited = true; }
        else kind ??= "control";
        stop();
      };
      const onExit = (code: number | null, termination: NodeJS.Signals | null): void => {
        exited = true; exitCode = code; exitSignal = termination;
        stop(code !== 0 || termination ? "exit" : undefined);
      };
      const onClose = (code: number | null, termination: NodeJS.Signals | null): void => {
        closed = true; exited = true; exitCode = code; exitSignal = termination;
        stop(code !== 0 || termination ? "exit" : undefined);
      };
      const onAbort = (): void => stop("aborted");

      child.on("error", onError); child.on("exit", onExit); child.on("close", onClose);
      child.stdin.on("error", onPipeError);
      child.stdout.on("error", onPipeError); child.stderr.on("error", onPipeError);
      child.stdout.on("data", onStdout); child.stderr.on("data", onStderr);
      signal.addEventListener("abort", onAbort, {once: true});
      deadline = setTimeout(() => stop("timeout"), invocation.timeoutMs);
      if (signal.aborted) onAbort();
      else child.stdin.end(invocation.input);
    });
  }
}

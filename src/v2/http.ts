import { ResourceScope } from "./lifecycle";

const messages = {
  ABORTED: "HTTP operation was cancelled",
  TIMEOUT: "HTTP operation exceeded its deadline",
  RESPONSE_TOO_LARGE: "HTTP response exceeded the byte limit",
  INVALID_JSON: "HTTP response is not valid JSON",
  DNS_FAILED: "HTTP hostname resolution failed",
  CONNECTION_REFUSED: "HTTP connection was refused",
  FAILED: "HTTP operation failed",
  CLEANUP_FAILED: "HTTP response cleanup failed",
  CLOSED: "HTTP response lifetime ended",
} as const;

export type HttpErrorCode = keyof typeof messages;

export class HttpError extends Error {
  readonly code: HttpErrorCode;

  constructor(code: HttpErrorCode) {
    super(messages[code]);
    this.name = "HttpError";
    this.code = code;
  }
}

/** Opt-in status policy: throw this from consume when a status is unacceptable. */
export class HttpStatusError extends Error {
  readonly status: number;

  constructor(status: number) {
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      throw new RangeError("HTTP status must be an integer between 100 and 599");
    }
    super(`HTTP response status ${status}`);
    this.name = "HttpStatusError";
    this.status = status;
  }
}

export interface ScopedHttpOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export interface HttpRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

function validateTimeout(timeoutMs: number): void {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 2_147_483_647) {
    throw new RangeError("timeoutMs must be finite and between 0 and 2147483647");
  }
}

function ownErrorValue(error: unknown, key: "code" | "cause"): unknown {
  if (error === null || typeof error !== "object") return undefined;
  try {
    const property = Object.getOwnPropertyDescriptor(error, key);
    return property && "value" in property ? property.value : undefined;
  } catch {
    return undefined;
  }
}

function nativeErrorCode(error: unknown): HttpErrorCode | undefined {
  switch (ownErrorValue(error, "code")) {
    case "ENOTFOUND":
    case "EAI_AGAIN": return "DNS_FAILED";
    case "ECONNREFUSED": return "CONNECTION_REFUSED";
    default: return undefined;
  }
}

function safeError(error: unknown): HttpError | HttpStatusError {
  // Never carry upstream messages, stacks, causes, headers or payloads across this boundary.
  if (error instanceof HttpStatusError && Number.isInteger(error.status) &&
      error.status >= 100 && error.status <= 599) {
    return new HttpStatusError(error.status);
  }
  if (error instanceof HttpError && Object.hasOwn(messages, error.code)) {
    return new HttpError(error.code);
  }
  // Node fetch wraps native errors in one cause; do not traverse chains or invoke getters.
  return new HttpError(nativeErrorCode(error) ?? nativeErrorCode(ownErrorValue(error, "cause")) ?? "FAILED");
}

export class ScopedHttp {
  private readonly scope: ResourceScope;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(scope: ResourceScope, options: ScopedHttpOptions = {}) {
    this.scope = scope;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxResponseBytes = options.maxResponseBytes ?? 2 * 1024 * 1024;
    validateTimeout(this.timeoutMs);
    if (!Number.isSafeInteger(this.maxResponseBytes) || this.maxResponseBytes < 0) {
      throw new RangeError("maxResponseBytes must be a non-negative safe integer");
    }
  }

  /**
   * No retries or implicit status checks. The deadline covers fetch, consume and cleanup.
   * Cancellation requests cooperation; the promise/task stays pending until work settles.
   * Consume must await all its work, not retain/clone the response, and release owned readers
   * in finally. Its signal also closes at callback lifetime end to stop native fetch I/O.
   * Only text/json enforce maxResponseBytes; custom consumers own their streaming limits.
   */
  withResponse<T>(
    url: string | URL,
    init: RequestInit,
    consume: (response: Response, signal: AbortSignal) => Promise<T>,
    options: HttpRequestOptions = {},
  ): Promise<T> {
    let started = false;
    const task = this.scope.run("http", async (scopeSignal) => {
      started = true;
      const timeoutMs = options.timeoutMs ?? this.timeoutMs;
      validateTimeout(timeoutMs);
      const controller = new AbortController();
      const signal = controller.signal;
      let cancellation: HttpError | undefined;
      const cancel = (code: "ABORTED" | "TIMEOUT"): void => {
        cancellation ??= new HttpError(code);
        controller.abort(cancellation);
      };
      const inputs = new Set([scopeSignal, init.signal, options.signal]);
      const onAbort = (): void => cancel("ABORTED");
      let timer: ReturnType<typeof setTimeout> | undefined;
      let response: Response | undefined;
      let value!: T;
      let failure: HttpError | HttpStatusError | undefined;
      try {
        for (const input of inputs) {
          if (!input) continue;
          if (input.aborted) cancel("ABORTED");
          else input.addEventListener("abort", onAbort, { once: true });
        }
        if (timeoutMs === 0) cancel("TIMEOUT");
        if (cancellation) throw cancellation;
        timer = setTimeout(() => cancel("TIMEOUT"), timeoutMs);
        // Do not race cancellation against this promise: ignored signals must stay tracked.
        response = await this.fetchImpl(url, { ...init, signal });
        if (cancellation) throw cancellation;
        value = await consume(response, signal);
      } catch (error) {
        failure = cancellation ?? safeError(error);
      } finally {
        try {
          if (response?.body && !response.body.locked) await response.body.cancel();
        } catch {
          failure ??= new HttpError("CLEANUP_FAILED");
        } finally {
          // Native fetch also cancels a body whose reader is still locked by the consumer.
          controller.abort(cancellation ?? new HttpError("CLOSED"));
          if (timer !== undefined) clearTimeout(timer);
          for (const input of inputs) input?.removeEventListener("abort", onAbort);
        }
      }
      if (cancellation) throw cancellation;
      if (failure) throw failure;
      return value;
    }).catch((error: unknown) => {
      // A pre-aborted scope rejects before invoking the callback; its reason is also private.
      if (!started && this.scope.signal.aborted) throw new HttpError("ABORTED");
      throw safeError(error);
    });
    void task.catch(() => undefined);
    return task;
  }

  /** Returns bounded UTF-8 text for any HTTP status, including non-2xx. */
  text(url: string | URL, init: RequestInit = {}, options: HttpRequestOptions = {}): Promise<string> {
    return this.withResponse(url, init, (response, signal) => this.readText(response, signal), options);
  }

  /** Parsing is tracked too. T is a caller assertion, not runtime schema validation. */
  json<T = unknown>(url: string | URL, init: RequestInit = {}, options: HttpRequestOptions = {}): Promise<T> {
    return this.withResponse(url, init, async (response, signal) => {
      const text = await this.readText(response, signal);
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new HttpError("INVALID_JSON");
      }
    }, options);
  }

  private async readText(response: Response, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    if (!response.body) return "";
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parts: string[] = [];
    let total = 0;
    let done = false;
    let cancellation: Promise<void> | undefined;
    let failure: HttpError | HttpStatusError | undefined;
    const cancel = (): Promise<void> => cancellation ??= reader.cancel(new HttpError("CLOSED"));
    const onAbort = (): void => { void cancel().catch(() => undefined); };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      while (true) {
        signal.throwIfAborted();
        const chunk = await reader.read();
        signal.throwIfAborted();
        if (chunk.done) {
          done = true;
          break;
        }
        // Fetch exposes decompressed bytes; Content-Length can describe compressed data or lie.
        total += chunk.value.byteLength;
        if (total > this.maxResponseBytes) throw new HttpError("RESPONSE_TOO_LARGE");
        if (chunk.value.byteLength > 0) parts.push(decoder.decode(chunk.value, { stream: true }));
      }
      parts.push(decoder.decode());
    } catch (error) {
      failure = safeError(error);
    } finally {
      signal.removeEventListener("abort", onAbort);
      try {
        if (!done) await cancel();
      } catch {
        failure ??= new HttpError("CLEANUP_FAILED");
      } finally {
        reader.releaseLock();
      }
    }
    if (failure) throw failure;
    return parts.join("");
  }
}

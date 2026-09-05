import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { inspect } from "node:util";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { HttpError, HttpStatusError, ScopedHttp } from "./http";
import { ResourceScope } from "./lifecycle";

const URL_ONLY = "https://offline.invalid/resource";
const SECRET = "credential-sentinel-739c";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

function code(expected: string): (error: unknown) => boolean {
  return (error) => {
    assert.ok(error instanceof HttpError);
    assert.equal(error.code, expected);
    return true;
  };
}

function fixture(chunks: Uint8Array[], options: { close?: boolean; cancel?: () => void | Promise<void> } = {}) {
  let cancelled = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      if (options.close !== false) controller.close();
    },
    cancel() { cancelled += 1; return options.cancel?.(); },
  });
  return { body, response: new Response(body), cancelled: () => cancelled };
}

for (const source of ["scope", "init", "options"] as const) {
  test(`pre-aborted ${source} never invokes fetch or consume and keeps reasons private`, async () => {
    const scope = new ResourceScope();
    const controller = new AbortController();
    controller.abort(new Error(SECRET));
    if (source === "scope") scope.abort(new Error(SECRET));
    let calls = 0;
    const http = new ScopedHttp(scope, { fetch: async () => { calls += 1; throw new Error(SECRET); } });
    await assert.rejects(http.withResponse(URL_ONLY,
      source === "init" ? { signal: controller.signal } : {},
      async () => { assert.fail("consume must not run"); },
      source === "options" ? { signal: controller.signal } : {}), code("ABORTED"));
    assert.equal(calls, 0);
    assert.equal(scope.snapshot().pendingTasks, 0);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    assert.equal((await scope.drain()).completed, true);
  });

  test(`${source} cancellation reaches cooperative fetch and detaches input listeners`, async () => {
    const scope = new ResourceScope();
    const initController = new AbortController();
    const optionController = new AbortController();
    let fetchSignal!: AbortSignal;
    let calls = 0;
    const http = new ScopedHttp(scope, { fetch: async (_url, init) => {
      calls += 1;
      fetchSignal = init!.signal!;
      return new Promise<Response>((_resolve, reject) => {
        fetchSignal.addEventListener("abort", () => reject(fetchSignal.reason), { once: true });
      });
    } });
    const result = http.text(URL_ONLY, { signal: initController.signal }, { signal: optionController.signal });
    if (source === "scope") scope.abort(new Error(SECRET));
    else (source === "init" ? initController : optionController).abort(new Error(SECRET));
    await assert.rejects(result, code("ABORTED"));
    assert.equal(fetchSignal.aborted, true);
    assert.equal(inspect(fetchSignal.reason).includes(SECRET), false);
    assert.equal(calls, 1);
    for (const signal of [scope.signal, initController.signal, optionController.signal]) {
      assert.equal(getEventListeners(signal, "abort").length, 0);
    }
    assert.equal((await scope.drain()).completed, true);
  });
}

test("passes URL objects and request fields intact, using the built-in fetch by default", async (t) => {
  const scope = new ResourceScope();
  const url = new URL(URL_ONLY);
  const headers = { Authorization: SECRET };
  const init: RequestInit = { method: "POST", headers, body: SECRET, redirect: "manual" };
  const mock = t.mock.method(globalThis, "fetch", async (input: string | URL | Request, options?: RequestInit) => {
    assert.equal(input, url);
    assert.equal(options?.method, "POST");
    assert.equal(options?.headers, headers);
    assert.equal(options?.body, SECRET);
    assert.equal(options?.redirect, "manual");
    assert.ok(options?.signal instanceof AbortSignal);
    return new Response("ok");
  });
  assert.equal(await new ScopedHttp(scope).text(url, init), "ok");
  assert.equal(init.signal, undefined);
  assert.equal(mock.mock.callCount(), 1);
  await scope.drain();
});

test("deadline defaults to 30 seconds and successful requests clear timers and listeners", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const setTimer = t.mock.method(globalThis, "setTimeout");
  const clearTimer = t.mock.method(globalThis, "clearTimeout");
  const scope = new ResourceScope();
  const external = new AbortController();
  let signal!: AbortSignal;
  const http = new ScopedHttp(scope, { fetch: async (_url, init) => {
    signal = init!.signal!;
    return new Response("done");
  } });
  for (let i = 0; i < 30; i += 1) {
    assert.equal(await http.text(URL_ONLY, { signal: external.signal }, { signal: external.signal }), "done");
    assert.equal(getEventListeners(external.signal, "abort").length, 0);
    assert.equal(getEventListeners(scope.signal, "abort").length, 0);
    assert.equal(signal.aborted, true);
  }
  assert.equal(setTimer.mock.callCount(), 30);
  assert.equal(clearTimer.mock.callCount(), 30);
  const cleared = new Set(clearTimer.mock.calls.map((call) => call.arguments[0]));
  for (const call of setTimer.mock.calls) {
    assert.equal(call.arguments[1], 30_000);
    assert.ok(cleared.has(call.result));
  }
  t.mock.timers.tick(30_000);
  assert.equal(scope.signal.aborted, false);
  await scope.drain();
});

test("per-request deadline overrides constructor timeout and cancels cooperative fetch", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const clearTimer = t.mock.method(globalThis, "clearTimeout");
  const scope = new ResourceScope();
  const http = new ScopedHttp(scope, { timeoutMs: 1000, fetch: async (_url, init) =>
    new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(new Error(SECRET)), { once: true });
    }) });
  const task = http.text(URL_ONLY, {}, { timeoutMs: 10 });
  t.mock.timers.tick(9);
  assert.equal(scope.snapshot().pendingTasks, 1);
  t.mock.timers.tick(1);
  await assert.rejects(task, code("TIMEOUT"));
  assert.equal(clearTimer.mock.callCount(), 1);
  assert.equal(scope.snapshot().pendingTasks, 0);
  await scope.drain();
});

test("timeout does not release an uncooperative fetch; its late response is cancelled", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const scope = new ResourceScope();
  const gate = deferred<Response>();
  const late = fixture([], { close: false });
  const http = new ScopedHttp(scope, { timeoutMs: 10, fetch: async () => gate.promise });
  let settled = false;
  const task = http.withResponse(URL_ONLY, {}, async () => { assert.fail("late consume"); });
  void task.then(() => { settled = true; }, () => { settled = true; });
  t.mock.timers.tick(10);
  await flush();
  assert.equal(settled, false);
  const draining = scope.drain(5);
  t.mock.timers.tick(5);
  const report = await draining;
  assert.equal(report.completed, false);
  assert.equal(report.timedOut, true);
  assert.equal(report.pendingTasks, 1);
  gate.resolve(late.response);
  await assert.rejects(task, code("TIMEOUT"));
  assert.equal(late.cancelled(), 1);
  assert.equal(late.body.locked, false);
  assert.equal((await scope.drain()).completed, true);
});

test("external cancellation of an uncooperative fetch retains the task until rejection", async () => {
  const scope = new ResourceScope();
  const gate = deferred<Response>();
  const controller = new AbortController();
  const http = new ScopedHttp(scope, { fetch: async () => gate.promise });
  const task = http.text(URL_ONLY, {}, { signal: controller.signal });
  controller.abort(SECRET);
  await flush();
  assert.equal(scope.snapshot().pendingTasks, 1);
  gate.reject(new Error(SECRET));
  await assert.rejects(task, code("ABORTED"));
  assert.equal((await scope.drain()).completed, true);
});

test("async consume and its finally remain tracked after cancellation", async () => {
  const scope = new ResourceScope();
  const entered = deferred();
  const work = deferred();
  const cleanup = deferred();
  const cleaning = deferred();
  const body = fixture([], { close: false });
  const controller = new AbortController();
  const http = new ScopedHttp(scope, { fetch: async () => body.response });
  const task = http.withResponse(URL_ONLY, {}, async (_response, signal) => {
    entered.resolve();
    try {
      await work.promise;
      assert.equal(signal.aborted, true);
      return 7;
    } finally {
      cleaning.resolve();
      await cleanup.promise;
    }
  }, { signal: controller.signal });
  await entered.promise;
  controller.abort(SECRET);
  assert.equal(scope.snapshot().pendingTasks, 1);
  work.resolve();
  await cleaning.promise;
  assert.equal(scope.snapshot().pendingTasks, 1);
  assert.equal(body.cancelled(), 0);
  cleanup.resolve();
  await assert.rejects(task, code("ABORTED"));
  assert.equal(body.cancelled(), 1);
  assert.equal(scope.snapshot().pendingTasks, 0);
  await scope.drain();
});

test("deadline includes asynchronous consume, not just response headers", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const scope = new ResourceScope();
  const entered = deferred();
  const work = deferred();
  const body = fixture([], { close: false });
  const http = new ScopedHttp(scope, { timeoutMs: 5, fetch: async () => body.response });
  const task = http.withResponse(URL_ONLY, {}, async (_response, signal) => {
    signal.addEventListener("abort", () => work.resolve(), { once: true });
    entered.resolve();
    await work.promise;
    return "too late";
  });
  await entered.promise;
  t.mock.timers.tick(5);
  await assert.rejects(task, code("TIMEOUT"));
  assert.equal(body.cancelled(), 1);
  await scope.drain();
});

test("finally awaits cancellation of unread and partially read bodies", async () => {
  for (const partial of [false, true]) {
    const scope = new ResourceScope();
    const cleanup = deferred();
    const cancelling = deferred();
    const body = fixture([new Uint8Array([65]), new Uint8Array([66])], {
      close: false,
      cancel: () => { cancelling.resolve(); return cleanup.promise; },
    });
    const http = new ScopedHttp(scope, { fetch: async () => body.response });
    const task = http.withResponse(URL_ONLY, {}, async (response) => {
      if (partial) {
        const reader = response.body!.getReader();
        try { await reader.read(); } finally { reader.releaseLock(); }
      }
      return 17;
    });
    await cancelling.promise;
    assert.equal(scope.snapshot().pendingTasks, 1);
    assert.equal(body.cancelled(), 1);
    cleanup.resolve();
    assert.equal(await task, 17);
    assert.equal(body.body.locked, false);
    assert.equal((await scope.drain()).completed, true);
  }
});

test("deadline stays active during cleanup and noncooperative cleanup remains tracked", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const scope = new ResourceScope();
  const cleanup = deferred();
  const cancelling = deferred();
  const body = fixture([], { close: false, cancel: () => { cancelling.resolve(); return cleanup.promise; } });
  const http = new ScopedHttp(scope, { timeoutMs: 5, fetch: async () => body.response });
  const task = http.withResponse(URL_ONLY, {}, async () => 1);
  await cancelling.promise;
  t.mock.timers.tick(5);
  assert.equal(scope.snapshot().pendingTasks, 1);
  cleanup.resolve();
  await assert.rejects(task, code("TIMEOUT"));
  assert.equal((await scope.drain()).completed, true);
});

test("bounded text decodes split UTF-8, accepts the exact limit, and releases readers", async () => {
  const scope = new ResourceScope();
  const bytes = new TextEncoder().encode("a\u20ac\ud83d\ude80");
  const body = fixture([bytes.slice(0, 2), bytes.slice(2, 6), bytes.slice(6)]);
  const http = new ScopedHttp(scope, { maxResponseBytes: bytes.length, fetch: async () => body.response });
  assert.equal(await http.text(URL_ONLY), "a\u20ac\ud83d\ude80");
  assert.equal(body.body.locked, false);
  assert.equal(body.cancelled(), 0);
  await scope.drain();
});

for (const length of [undefined, "1", "invalid", "999999999"]) {
  test(`actual bytes enforce the limit with Content-Length ${length ?? "absent"}`, async () => {
    const scope = new ResourceScope();
    const body = fixture([new Uint8Array(3), new Uint8Array(3)], { close: false });
    if (length !== undefined) body.response.headers.set("Content-Length", length);
    const http = new ScopedHttp(scope, { maxResponseBytes: 5, fetch: async () => body.response });
    await assert.rejects(http.text(URL_ONLY), code("RESPONSE_TOO_LARGE"));
    assert.equal(body.cancelled(), 1);
    assert.equal(body.body.locked, false);
    assert.equal((await scope.drain()).completed, true);
  });
}

test("default 2 MiB limit rejects oversized text and JSON", async () => {
  for (const method of ["text", "json"] as const) {
    const scope = new ResourceScope();
    const body = fixture([new Uint8Array(1024 * 1024), new Uint8Array(1024 * 1024), new Uint8Array(1)], { close: false });
    const http = new ScopedHttp(scope, { fetch: async () => body.response });
    await assert.rejects(http[method](URL_ONLY), code("RESPONSE_TOO_LARGE"));
    assert.equal(body.cancelled(), 1);
    assert.equal(body.body.locked, false);
    await scope.drain();
  }
});

test("compressed response fixtures are limited by decompressed bytes, entirely offline", async () => {
  const scope = new ResourceScope();
  const compressed = gzipSync(Buffer.alloc(8192, 65));
  assert.ok(compressed.length < 128);
  const source = new ReadableStream<NodeJS.BufferSource>({ start(controller) {
    controller.enqueue(compressed);
    controller.close();
  } });
  const decoded = source.pipeThrough(new DecompressionStream("gzip"));
  const response = new Response(decoded, {
    headers: { "Content-Encoding": "gzip", "Content-Length": String(compressed.length) },
  });
  const http = new ScopedHttp(scope, { maxResponseBytes: 128, fetch: async () => response });
  await assert.rejects(http.text(URL_ONLY), code("RESPONSE_TOO_LARGE"));
  assert.equal(decoded.locked, false);
  await scope.drain();
});

for (const mode of ["abort", "timeout"] as const) {
  test(`${mode} interrupts a pending body read and waits for reader cancellation`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const scope = new ResourceScope();
    const controller = new AbortController();
    const cleanup = deferred();
    const cancelling = deferred();
    const body = fixture([], { close: false, cancel: () => { cancelling.resolve(); return cleanup.promise; } });
    const http = new ScopedHttp(scope, { timeoutMs: 10, fetch: async () => body.response });
    const task = http.text(URL_ONLY, {}, { signal: controller.signal });
    await flush();
    assert.equal(body.body.locked, true);
    if (mode === "abort") controller.abort(SECRET);
    else t.mock.timers.tick(10);
    await cancelling.promise;
    assert.equal(scope.snapshot().pendingTasks, 1);
    assert.equal(body.body.locked, true);
    cleanup.resolve();
    await assert.rejects(task, code(mode === "abort" ? "ABORTED" : "TIMEOUT"));
    assert.equal(body.body.locked, false);
    assert.equal(body.cancelled(), 1);
    await scope.drain();
  });
}

test("reader errors release locks and redact stream error details", async () => {
  const scope = new ResourceScope();
  const body = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(new Error(SECRET)); } });
  const http = new ScopedHttp(scope, { fetch: async () => new Response(body) });
  await assert.rejects(http.text(URL_ONLY), code("FAILED"));
  assert.equal(body.locked, false);
  await scope.drain();
});

test("zero byte limit accepts empty bodies; JSON parsing is explicit and sanitized", async () => {
  const scope = new ResourceScope();
  assert.equal(await new ScopedHttp(scope, { maxResponseBytes: 0, fetch: async () => new Response(null) }).text(URL_ONLY), "");
  assert.equal(await new ScopedHttp(scope, { maxResponseBytes: 0, fetch: async () => new Response("") }).text(URL_ONLY), "");
  assert.deepEqual(await new ScopedHttp(scope, { fetch: async () => Response.json({ answer: 42 }) }).json(URL_ONLY), { answer: 42 });
  await assert.rejects(new ScopedHttp(scope, { fetch: async () => new Response(SECRET) }).json(URL_ONLY), code("INVALID_JSON"));
  await scope.drain();
});

test("non-2xx responses are exposed; callers can explicitly throw HttpStatusError", async () => {
  const scope = new ResourceScope();
  let calls = 0;
  const http = new ScopedHttp(scope, { fetch: async () => {
    calls += 1;
    return new Response('{"error":"unavailable"}', { status: 503, statusText: SECRET });
  } });
  assert.equal(await http.text(URL_ONLY), '{"error":"unavailable"}');
  assert.deepEqual(await http.json(URL_ONLY), { error: "unavailable" });
  assert.equal(await http.withResponse(URL_ONLY, {}, async (response) => response.status), 503);
  await assert.rejects(http.withResponse(URL_ONLY, {}, async (response) => {
    if (!response.ok) throw new HttpStatusError(response.status);
    return response.text();
  }), (error) => {
    assert.ok(error instanceof HttpStatusError);
    assert.equal(error.status, 503);
    assert.equal(inspect(error).includes(SECRET), false);
    return true;
  });
  assert.equal(calls, 4);
  await scope.drain();
});

test("arbitrary errors from fetch, consume, JSON and cleanup cannot expose secrets", async () => {
  const secretUrl = `https://user:${SECRET}@offline.invalid/?token=${SECRET}`;
  for (const phase of ["fetch", "consume", "json", "cleanup", "decorated"] as const) {
    const scope = new ResourceScope();
    let calls = 0;
    const upstream = new Error(`${secretUrl} Authorization: ${SECRET} body=${SECRET}`, { cause: new Error(SECRET) });
    const body = fixture([], { close: false, cancel: () => {
      if (phase === "cleanup") throw upstream;
    } });
    const http = new ScopedHttp(scope, { fetch: async () => {
      calls += 1;
      if (phase === "fetch") throw upstream;
      if (phase === "json") return new Response(SECRET);
      return body.response;
    } });
    const task = phase === "json" ? http.json(secretUrl) : http.withResponse(secretUrl,
      { method: "POST", headers: { Authorization: SECRET }, body: SECRET }, async () => {
        if (phase === "consume") throw upstream;
        if (phase === "decorated") {
          const error = new HttpStatusError(401);
          error.message = SECRET;
          error.cause = upstream;
          throw error;
        }
        return 1;
      });
    await assert.rejects(task, (error) => {
      assert.ok(error instanceof Error);
      assert.equal(inspect(error, { depth: 10 }).includes(SECRET), false);
      assert.equal(JSON.stringify(error).includes(SECRET), false);
      assert.equal(String(error).includes(SECRET), false);
      assert.equal("cause" in error, false);
      if (phase === "cleanup") assert.ok(code("CLEANUP_FAILED")(error));
      return true;
    });
    assert.equal(calls, 1);
    assert.deepEqual(scope.snapshot().errors, []);
    assert.equal((await scope.drain()).completed, true);
  }
});

for (const nativeCode of ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED"] as const) {
  for (const location of ["error", "cause"] as const) {
    test(`sanitizes native ${nativeCode} on ${location} into a structured code`, async () => {
      const scope = new ResourceScope();
      const secretUrl = `https://user:${SECRET}@offline.invalid/?token=${SECRET}`;
      const native = Object.assign(new Error(secretUrl), { code: nativeCode, hostname: SECRET });
      const upstream = location === "error" ? native : new TypeError(SECRET, { cause: native });
      const http = new ScopedHttp(scope, { fetch: async () => { throw upstream; } });
      await assert.rejects(http.text(secretUrl), (error) => {
        assert.ok(error instanceof HttpError);
        assert.equal(error.code, nativeCode === "ECONNREFUSED" ? "CONNECTION_REFUSED" : "DNS_FAILED");
        assert.equal(error.message, nativeCode === "ECONNREFUSED"
          ? "HTTP connection was refused" : "HTTP hostname resolution failed");
        assert.notEqual(error, upstream);
        assert.equal("cause" in error, false);
        assert.equal(inspect(error, { depth: 10 }).includes(SECRET), false);
        assert.equal(JSON.stringify(error).includes(SECRET), false);
        assert.equal(String(error).includes(SECRET), false);
        assert.equal(inspect(error).includes(nativeCode), false);
        return true;
      });
      assert.deepEqual(scope.snapshot().errors, []);
      assert.equal(scope.snapshot().pendingTasks, 0);
      assert.equal((await scope.drain()).completed, true);
    });
  }
}

test("native classification is bounded to own data properties on the error and direct cause", async () => {
  const native = Object.assign(new Error(SECRET), { code: "ENOTFOUND" });
  const cycle = new Error(SECRET, { cause: undefined });
  cycle.cause = cycle;
  let getters = 0;
  const accessor = () => { getters += 1; throw new Error(SECRET); };
  const cases: unknown[] = [
    new Error("ENOTFOUND EAI_AGAIN ECONNREFUSED " + SECRET),
    new Error(SECRET, { cause: new Error(SECRET, { cause: native }) }),
    new AggregateError([native], SECRET),
    cycle, null, undefined, "ENOTFOUND", 42,
    Object.assign(new Error(SECRET), { code: "ENOTFOUND " }),
    Object.assign(new Error(SECRET), { code: "ECONNRESET" }),
    Object.assign(new Error(SECRET), { code: "DNS_FAILED" }),
    Object.assign(new Error(SECRET), { code: { toString: accessor } }),
    Object.create({ code: "ENOTFOUND", cause: native }),
    Object.defineProperties(new Error(SECRET), { code: { get: accessor }, cause: { get: accessor } }),
    new Error(SECRET, { cause: Object.defineProperty({}, "code", { get: accessor }) }),
    new Error(SECRET, { cause: Object.defineProperty({}, "cause", { get: accessor }) }),
  ];
  const scope = new ResourceScope();
  for (const upstream of cases) {
    const http = new ScopedHttp(scope, { fetch: async () => { throw upstream; } });
    await assert.rejects(http.text(URL_ONLY), code("FAILED"));
  }
  assert.equal(getters, 0);
  const primary = Object.assign(new Error(SECRET, { cause: native }), { code: "ECONNREFUSED" });
  await assert.rejects(new ScopedHttp(scope, { fetch: async () => { throw primary; } }).text(URL_ONLY), code("CONNECTION_REFUSED"));
  const wrapper = Object.assign(new Error(SECRET, { cause: native }), { code: "UNKNOWN" });
  await assert.rejects(new ScopedHttp(scope, { fetch: async () => { throw wrapper; } }).text(URL_ONLY), code("DNS_FAILED"));
  assert.equal((await scope.drain()).completed, true);
});

test("native stream failures retain sanitized codes and release the reader", async () => {
  const scope = new ResourceScope();
  const upstream = new TypeError(SECRET, { cause: Object.assign(new Error(SECRET), { code: "ECONNREFUSED" }) });
  const body = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(upstream); } });
  const http = new ScopedHttp(scope, { fetch: async () => new Response(body) });
  await assert.rejects(http.text(URL_ONLY), code("CONNECTION_REFUSED"));
  assert.equal(body.locked, false);
  assert.equal((await scope.drain()).completed, true);
});

test("cancellation and deadline codes take precedence over late native failures", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const mode of ["abort", "timeout"] as const) {
    const scope = new ResourceScope();
    const controller = new AbortController();
    const gate = deferred<Response>();
    const http = new ScopedHttp(scope, { timeoutMs: 10, fetch: async () => gate.promise });
    const task = http.text(URL_ONLY, { signal: controller.signal });
    if (mode === "abort") controller.abort(SECRET);
    else t.mock.timers.tick(10);
    gate.reject(new TypeError(SECRET, { cause: Object.assign(new Error(SECRET), { code: "ENOTFOUND" }) }));
    await assert.rejects(task, code(mode === "abort" ? "ABORTED" : "TIMEOUT"));
    assert.equal((await scope.drain()).completed, true);
  }
});

test("consumer failure still cancels its body and keeps primary error on cleanup failure", async () => {
  const scope = new ResourceScope();
  const body = fixture([], { close: false, cancel: () => { throw new Error(SECRET); } });
  const http = new ScopedHttp(scope, { fetch: async () => body.response });
  await assert.rejects(http.withResponse(URL_ONLY, {}, async () => { throw new HttpStatusError(429); }), HttpStatusError);
  assert.equal(body.cancelled(), 1);
  await scope.drain();
});

test("invalid configuration fails without fetch; zero timeout is an immediate deadline", async () => {
  const scope = new ResourceScope();
  let calls = 0;
  const fetch: typeof globalThis.fetch = async () => { calls += 1; return new Response("ok"); };
  for (const timeoutMs of [-1, NaN, Infinity, 2_147_483_648]) {
    assert.throws(() => new ScopedHttp(scope, { timeoutMs, fetch }), RangeError);
    await assert.rejects(new ScopedHttp(scope, { fetch }).text(URL_ONLY, {}, { timeoutMs }), code("FAILED"));
  }
  for (const maxResponseBytes of [-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => new ScopedHttp(scope, { maxResponseBytes, fetch }), RangeError);
  }
  await assert.rejects(new ScopedHttp(scope, { timeoutMs: 0, fetch }).text(URL_ONLY), code("TIMEOUT"));
  assert.equal(calls, 0);
  assert.equal(scope.snapshot().pendingTasks, 0);
  await scope.drain();
});

test("native Node fetch supports response consumption and final cancellation without network I/O", async () => {
  const scope = new ResourceScope();
  const http = new ScopedHttp(scope);
  const url = "data:application/json,%7B%22value%22%3A42%7D";
  assert.deepEqual(await http.json(url), { value: 42 });
  assert.equal(await http.withResponse(url, {}, async (response) => response.text()), '{"value":42}');
  assert.equal(await http.withResponse(url, {}, async (response) => response.status), 200);
  assert.equal((await scope.drain()).completed, true);
});

test("oversized bodies wait for reader cancellation and preserve byte-limit errors", async () => {
  const scope = new ResourceScope();
  const cleanup = deferred();
  const cancelling = deferred();
  const body = fixture([new Uint8Array(6)], { close: false, cancel: () => {
    cancelling.resolve();
    return cleanup.promise;
  } });
  const http = new ScopedHttp(scope, { maxResponseBytes: 5, fetch: async () => body.response });
  const task = http.text(URL_ONLY);
  await cancelling.promise;
  assert.equal(scope.snapshot().pendingTasks, 1);
  assert.equal(body.body.locked, true);
  cleanup.reject(new Error(SECRET));
  await assert.rejects(task, code("RESPONSE_TOO_LARGE"));
  assert.equal(body.body.locked, false);
  assert.equal(body.cancelled(), 1);
  await scope.drain();
});

test("limit counts UTF-8 bytes rather than JavaScript string length", async () => {
  const scope = new ResourceScope();
  const text = "\u20ac\u20ac";
  assert.equal(text.length, 2);
  const http = new ScopedHttp(scope, { maxResponseBytes: 5, fetch: async () => new Response(text) });
  await assert.rejects(http.text(URL_ONLY), code("RESPONSE_TOO_LARGE"));
  await scope.drain();
});

test("first cancellation reason wins when an external abort is followed by deadline expiry", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const scope = new ResourceScope();
  const controller = new AbortController();
  const gate = deferred<Response>();
  const http = new ScopedHttp(scope, { timeoutMs: 10, fetch: async () => gate.promise });
  const task = http.text(URL_ONLY, { signal: controller.signal });
  controller.abort(new Error(SECRET));
  t.mock.timers.tick(10);
  gate.reject(new Error(SECRET));
  await assert.rejects(task, code("ABORTED"));
  await scope.drain();
});

test("failure paths clear deadline timers and detach every input signal", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const setTimer = t.mock.method(globalThis, "setTimeout");
  const clearTimer = t.mock.method(globalThis, "clearTimeout");
  const scope = new ResourceScope();
  const controller = new AbortController();
  const http = new ScopedHttp(scope, { fetch: async () => { throw new Error(SECRET); } });
  await assert.rejects(http.text(URL_ONLY, { signal: controller.signal }), code("FAILED"));
  assert.equal(setTimer.mock.callCount(), 1);
  assert.equal(clearTimer.mock.callCount(), 1);
  assert.equal(clearTimer.mock.calls[0].arguments[0], setTimer.mock.calls[0].result);
  assert.equal(getEventListeners(scope.signal, "abort").length, 0);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  await scope.drain();
});

import assert from "node:assert/strict";
import { EventEmitter, getEventListeners } from "node:events";
import test from "node:test";
import { RESOURCE_SCOPE_ERROR_LIMIT, ResourceScope, SelfDrainError } from "./lifecycle";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

test("tracks synchronous and asynchronous tasks, then releases their entries", async () => {
  const scope = new ResourceScope();
  assert.equal(scope.state, "active");
  assert.deepEqual(scope.snapshot(), {
    completed: false, timedOut: false, pendingTasks: 0, pendingResources: 0, errors: [],
  });
  const value = { payload: "result" };
  assert.equal(await scope.run("sync", (signal) => {
    assert.equal(signal, scope.signal);
    return value;
  }), value);
  const gate = deferred<number>();
  const task = scope.run("async", () => gate.promise);
  assert.equal(scope.snapshot().pendingTasks, 1);
  gate.resolve(42);
  assert.equal(await task, 42);
  assert.equal(scope.snapshot().pendingTasks, 0);
  assert.equal((await scope.drain()).completed, true);
  assert.equal(scope.state, "disposed");
});

test("manual cleanup remains tracked until settlement and executes exactly once", async () => {
  const scope = new ResourceScope();
  const gate = deferred();
  let calls = 0;
  const dispose = scope.add("pending cleanup", () => {
    calls += 1;
    return gate.promise;
  });
  const first = dispose();
  assert.equal(dispose(), first);
  assert.equal(scope.snapshot().pendingResources, 1);
  const report = await scope.drain(5);
  assert.equal(report.timedOut, true);
  assert.equal(report.completed, false);
  assert.equal(report.pendingResources, 1);
  assert.equal(scope.state, "draining");
  assert.equal(scope.snapshot().timedOut, true);
  gate.resolve();
  await first;
  assert.equal((await scope.drain()).completed, true);
  assert.equal(dispose(), first);
  assert.equal(calls, 1);
  assert.equal(scope.snapshot().pendingResources, 0);
});

test("cleanup is idempotent even when it calls its own disposer", async () => {
  const scope = new ResourceScope();
  let calls = 0;
  let reentrant: Promise<void> | undefined;
  const dispose = scope.add("reentrant", () => {
    calls += 1;
    reentrant = dispose();
  });
  const first = dispose();
  assert.equal(reentrant, first);
  await first;
  await scope.drain();
  assert.equal(calls, 1);
});

test("drain bounds initially pending cleanup, not only task waits", async () => {
  const scope = new ResourceScope();
  const gate = deferred();
  scope.add("cleanup", () => gate.promise);
  const report = await scope.drain(5);
  assert.equal(report.completed, false);
  assert.equal(report.timedOut, true);
  assert.equal(report.pendingTasks, 0);
  assert.equal(report.pendingResources, 1);
  gate.resolve();
  assert.equal((await scope.drain()).completed, true);
});

test("one deadline covers both tasks and cleanup", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const scope = new ResourceScope();
  const taskGate = deferred();
  const cleanupGate = deferred();
  const task = scope.run("task", () => taskGate.promise);
  scope.add("cleanup", () => cleanupGate.promise);
  let settled = false;
  const draining = scope.drain(100).then((report) => {
    settled = true;
    return report;
  });
  t.mock.timers.tick(60);
  taskGate.resolve();
  await task;
  t.mock.timers.tick(39);
  await flush();
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  const report = await draining;
  assert.equal(report.timedOut, true);
  assert.equal(report.completed, false);
  assert.equal(report.pendingTasks, 0);
  assert.equal(report.pendingResources, 1);
  cleanupGate.resolve();
  assert.equal((await scope.drain()).completed, true);
});

test("timed-out tasks stay tracked and can be drained later", async () => {
  const scope = new ResourceScope();
  const gate = deferred();
  const task = scope.run("pending", () => gate.promise);
  const report = await scope.drain(5);
  assert.equal(report.pendingTasks, 1);
  assert.equal(report.timedOut, true);
  assert.equal(report.completed, false);
  gate.resolve();
  await task;
  assert.equal((await scope.drain()).completed, true);
  assert.equal(scope.snapshot().timedOut, false);
});

test("tasks can cancel themselves and an external coordinator drains", async () => {
  const scope = new ResourceScope();
  const reason = new Error("cancelled");
  let cleanups = 0;
  scope.add("resource", () => { cleanups += 1; });
  await scope.run("cancel", async (signal) => {
    scope.abort(reason);
    await Promise.resolve();
    assert.equal(signal.reason, reason);
    assert.equal(scope.state, "draining");
  });
  assert.equal(cleanups, 0);
  let invoked = false;
  await assert.rejects(scope.run("rejected", () => { invoked = true; }), (error) => error === reason);
  assert.equal(invoked, false);
  scope.abort(new Error("second reason"));
  assert.equal(scope.signal.reason, reason);
  assert.equal((await scope.drain()).completed, true);
  assert.equal(cleanups, 1);
});

test("drain signals cancellation to an accepted task", async () => {
  const scope = new ResourceScope();
  const task = scope.run("cooperative", (signal) => new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  }));
  assert.equal((await scope.drain()).completed, true);
  await task;
  assert.equal(getEventListeners(scope.signal, "abort").length, 0);
});

test("own-task drain rejects before changing lifecycle, including after await", async () => {
  const scope = new ResourceScope();
  await scope.run("owner", async () => {
    await assert.rejects(scope.drain(), SelfDrainError);
    await Promise.resolve();
    await assert.rejects(scope.drain(), /owner/);
    assert.equal(scope.state, "active");
    assert.equal(scope.signal.aborted, false);
    scope.abort();
    await assert.rejects(scope.drain(), SelfDrainError);
  });
  assert.equal((await scope.drain()).completed, true);
});

test("self-drain detection follows nested task ancestry across scopes", async () => {
  const outer = new ResourceScope();
  const inner = new ResourceScope();
  await outer.run("outer", () => inner.run("inner", async () => {
    await Promise.resolve();
    await assert.rejects(outer.drain(), SelfDrainError);
    await assert.rejects(inner.drain(), SelfDrainError);
  }));
  assert.equal((await outer.drain()).completed, true);
  assert.equal((await inner.drain()).completed, true);
});

test("assertCanDrain checks task ancestry synchronously without changing scope state", async () => {
  const outer = new ResourceScope();
  const inner = new ResourceScope();
  let cleanups = 0;
  outer.add("resource", () => { cleanups += 1; });
  const before = outer.snapshot();
  assert.doesNotThrow(() => outer.assertCanDrain());
  assert.doesNotThrow(() => outer.assertCanDrain(0));
  assert.deepEqual(outer.snapshot(), before);
  await outer.run("outer", () => inner.run("inner", async () => {
    await Promise.resolve();
    assert.throws(() => outer.assertCanDrain(), SelfDrainError);
    assert.throws(() => inner.assertCanDrain(), SelfDrainError);
    assert.equal(outer.state, "active");
    assert.equal(inner.state, "active");
    assert.equal(outer.signal.aborted, false);
    assert.equal(inner.signal.aborted, false);
    assert.equal(cleanups, 0);
  }));
  assert.doesNotThrow(() => outer.assertCanDrain());
  assert.equal((await outer.drain()).completed, true);
  assert.equal((await inner.drain()).completed, true);
  assert.doesNotThrow(() => outer.assertCanDrain());
  assert.equal(cleanups, 1);
});

test("assertCanDrain and drain share timeout validation without starting cleanup", async () => {
  const scope = new ResourceScope();
  let cleanups = 0;
  scope.add("resource", () => { cleanups += 1; });
  const before = scope.snapshot();
  for (const timeout of [-1, NaN, Infinity, 2_147_483_648]) {
    assert.throws(() => scope.assertCanDrain(timeout), RangeError);
    await assert.rejects(scope.drain(timeout), RangeError);
  }
  for (const timeout of [undefined, 0, 1, 15_000, 2_147_483_647]) {
    assert.doesNotThrow(() => scope.assertCanDrain(timeout));
  }
  assert.deepEqual(scope.snapshot(), before);
  assert.equal(scope.state, "active");
  assert.equal(scope.signal.aborted, false);
  assert.equal(cleanups, 0);
  assert.equal((await scope.drain()).completed, true);
  assert.equal(cleanups, 1);
});

test("inherited context of a settled task does not prevent an external drain", async () => {
  const scope = new ResourceScope();
  const gate = deferred();
  let later!: Promise<unknown>;
  await scope.run("finished", () => {
    later = gate.promise.then(() => scope.drain());
  });
  gate.resolve();
  await later;
  assert.equal(scope.state, "disposed");
});

test("parent cancellation propagates; full disposal detaches parent listener", async () => {
  const parent = new AbortController();
  const scope = new ResourceScope(parent.signal);
  const gate = deferred();
  scope.add("pending", () => gate.promise);
  assert.equal(getEventListeners(parent.signal, "abort").length, 1);
  await scope.drain(5);
  assert.equal(getEventListeners(parent.signal, "abort").length, 1);
  gate.resolve();
  assert.equal((await scope.drain()).completed, true);
  assert.equal(getEventListeners(parent.signal, "abort").length, 0);

  const cancelled = new ResourceScope(parent.signal);
  const reason = new Error("parent cancellation");
  parent.abort(reason);
  assert.equal(cancelled.signal.reason, reason);
  await assert.rejects(cancelled.run("closed", () => 1), (error) => error === reason);
  assert.equal((await cancelled.drain()).completed, true);
  const alreadyCancelled = new ResourceScope(parent.signal);
  assert.equal(alreadyCancelled.signal.reason, reason);
  assert.equal((await alreadyCancelled.drain()).completed, true);
});

test("task failures reach their callers and allow subsequent clean drains", async () => {
  const scope = new ResourceScope();
  const syncError = new Error("sync task");
  const asyncError = new Error("async task");
  await assert.rejects(scope.run("sync failure", () => { throw syncError; }), (error) => error === syncError);
  await assert.rejects(scope.run("async failure", async () => { throw asyncError; }), (error) => error === asyncError);
  assert.deepEqual(scope.snapshot().errors, []);
  assert.equal(scope.snapshot().pendingTasks, 0);
  assert.equal(await scope.run("next task", () => 42), 42);
  let cleaned = false;
  scope.add("cleanup", () => { cleaned = true; });
  const report = await scope.drain();
  assert.equal(report.completed, true);
  assert.equal(report.timedOut, false);
  assert.equal(report.pendingTasks, 0);
  assert.equal(report.pendingResources, 0);
  assert.deepEqual(report.errors, []);
  assert.equal(cleaned, true);
  assert.equal((await scope.drain()).completed, true);
});

test("drain observes all failures and reports only cleanup failures, once", async () => {
  const scope = new ResourceScope();
  const syncError = new Error("sync task");
  const asyncError = new Error("async task");
  const cleanupError = new Error("sync cleanup");
  const asyncCleanupError = new Error("async cleanup");
  // Intentionally ignored promises exercise unhandled-rejection protection.
  scope.run("sync failure", () => { throw syncError; });
  scope.run("async failure", async () => { throw asyncError; });
  const dispose = scope.add("sync cleanup", () => { throw cleanupError; });
  scope.add("async cleanup", async () => { throw asyncCleanupError; });
  const report = await scope.drain();
  assert.equal(report.completed, false);
  assert.equal(report.timedOut, false);
  assert.equal(report.pendingTasks, 0);
  assert.equal(report.pendingResources, 0);
  assert.equal(scope.state, "disposed");
  assert.deepEqual(new Set(report.errors), new Set([cleanupError, asyncCleanupError]));
  await assert.rejects(dispose(), (error) => error === cleanupError);
  assert.deepEqual((await scope.drain()).errors, report.errors);
  await new Promise<void>((resolve) => setImmediate(resolve));
});

test("cleanup error history is bounded and snapshots are independent copies", async () => {
  const scope = new ResourceScope();
  const before = scope.snapshot();
  for (let index = 0; index < RESOURCE_SCOPE_ERROR_LIMIT + 30; index += 1) {
    const dispose = scope.add("failure", () => { throw new Error(String(index)); });
    await assert.rejects(dispose());
  }
  const report = await scope.drain();
  assert.equal(report.errors.length, 100);
  assert.equal((report.errors[0] as Error).message, "30");
  assert.equal((report.errors[99] as Error).message, "129");
  assert.deepEqual(before.errors, []);
  (report.errors as unknown[]).length = 0;
  assert.equal(scope.snapshot().errors.length, 100);
});

test("concurrent drains have independent deadlines and share exactly-once cleanup", async () => {
  const scope = new ResourceScope();
  const gate = deferred();
  let calls = 0;
  scope.add("shared", () => {
    calls += 1;
    return gate.promise;
  });
  const short = scope.drain(5);
  const long = scope.drain(1_000);
  const report = await short;
  assert.equal(report.timedOut, true);
  assert.equal(report.completed, false);
  assert.equal(report.pendingResources, 1);
  gate.resolve();
  assert.equal((await long).completed, true);
  assert.equal(calls, 1);
  assert.equal(scope.snapshot().timedOut, false);
});

test("own-task drain rejects even when another drain is already waiting", async () => {
  const scope = new ResourceScope();
  const gate = deferred();
  const task = scope.run("owner", async () => {
    await gate.promise;
    await assert.rejects(scope.drain(), SelfDrainError);
  });
  const draining = scope.drain();
  gate.resolve();
  await task;
  assert.equal((await draining).completed, true);
});

test("late registration from cancellation, cleanup and task settlement is drained", async () => {
  const scope = new ResourceScope();
  const gate = deferred();
  const events: string[] = [];
  scope.signal.addEventListener("abort", () => {
    scope.add("abort resource", () => { events.push("abort"); });
  }, { once: true });
  scope.add("initial", () => {
    scope.add("nested", () => { events.push("nested"); });
  });
  const task = scope.run("late task", async () => {
    await gate.promise;
    scope.add("task resource", async () => {
      await Promise.resolve();
      scope.add("last resource", () => { events.push("last"); });
    });
  });
  const draining = scope.drain();
  gate.resolve();
  await task;
  const report = await draining;
  assert.equal(report.completed, true);
  assert.deepEqual(events, ["abort", "nested", "last"]);
  assert.equal(report.pendingResources, 0);
});

test("post-disposal and post-timeout cleanup is immediately started and tracked", async () => {
  const scope = new ResourceScope();
  await scope.drain();
  const gate = deferred();
  let calls = 0;
  const dispose = scope.add("late", () => {
    calls += 1;
    return gate.promise;
  });
  assert.equal(calls, 1);
  assert.equal(scope.state, "draining");
  assert.equal(scope.snapshot().completed, false);
  assert.equal((await scope.drain(5)).pendingResources, 1);
  const secondGate = deferred();
  scope.add("after timeout", () => secondGate.promise);
  gate.resolve();
  await dispose();
  assert.equal(scope.snapshot().pendingResources, 1);
  secondGate.resolve();
  assert.equal((await scope.drain()).completed, true);
  assert.equal(calls, 1);
});

test("late cleanup failure remains in the next drain report", async () => {
  const scope = new ResourceScope();
  await scope.drain();
  const error = new Error("late failure");
  scope.add("late failure", async () => { throw error; });
  const report = await scope.drain();
  assert.equal(report.completed, false);
  assert.equal(report.timedOut, false);
  assert.deepEqual(report.errors, [error]);
  assert.equal(report.pendingResources, 0);
});

test("after timeout only cleanup failures appear in the drain report", async () => {
  const scope = new ResourceScope();
  const taskGate = deferred();
  const cleanupGate = deferred();
  const taskError = new Error("task failed after timeout");
  const cleanupError = new Error("cleanup failed after timeout");
  scope.run("late task failure", () => taskGate.promise);
  scope.add("late cleanup failure", () => cleanupGate.promise);
  const timedOut = await scope.drain(5);
  assert.equal(timedOut.timedOut, true);
  assert.equal(timedOut.pendingTasks, 1);
  assert.equal(timedOut.pendingResources, 1);
  taskGate.reject(taskError);
  cleanupGate.reject(cleanupError);
  const report = await scope.drain();
  assert.equal(report.completed, false);
  assert.equal(report.timedOut, false);
  assert.equal(report.pendingTasks, 0);
  assert.equal(report.pendingResources, 0);
  assert.deepEqual(report.errors, [cleanupError]);
  assert.deepEqual(timedOut.errors, []);
  await new Promise<void>((resolve) => setImmediate(resolve));
});

test("task rejection after timeout permits a later clean drain", async () => {
  const scope = new ResourceScope();
  const gate = deferred();
  const error = new Error("cancelled task settled after timeout");
  const task = scope.run("pending", () => gate.promise);
  const timedOut = await scope.drain(5);
  assert.equal(timedOut.completed, false);
  assert.equal(timedOut.timedOut, true);
  assert.equal(timedOut.pendingTasks, 1);
  gate.reject(error);
  await assert.rejects(task, (reason) => reason === error);
  const report = await scope.drain();
  assert.equal(report.completed, true);
  assert.equal(report.timedOut, false);
  assert.equal(report.pendingTasks, 0);
  assert.deepEqual(report.errors, []);
});

test("uncaught self-drain rejects the task and permits external clean drain", async () => {
  const scope = new ResourceScope();
  const task = scope.run("self drain", () => scope.drain());
  const report = await scope.drain();
  await assert.rejects(task, SelfDrainError);
  assert.equal(report.completed, true);
  assert.equal(report.timedOut, false);
  assert.equal(report.pendingTasks, 0);
  assert.deepEqual(report.errors, []);
});

test("registration after abort starts cleanup but leaves final drain to the coordinator", async () => {
  const scope = new ResourceScope();
  scope.abort();
  let calls = 0;
  const dispose = scope.add("after abort", () => { calls += 1; });
  assert.equal(calls, 1);
  await dispose();
  assert.equal(scope.state, "draining");
  assert.equal(scope.snapshot().completed, false);
  assert.equal((await scope.drain()).completed, true);
});

test("repeated timed-out drains release their own timers while work remains tracked", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const setTimer = t.mock.method(globalThis, "setTimeout");
  const clearTimer = t.mock.method(globalThis, "clearTimeout");
  const scope = new ResourceScope();
  const gate = deferred();
  const task = scope.run("pending", () => gate.promise);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const draining = scope.drain(10);
    t.mock.timers.tick(10);
    const report = await draining;
    assert.equal(report.timedOut, true);
    assert.equal(report.completed, false);
    assert.equal(report.pendingTasks, 1);
  }
  assert.equal(setTimer.mock.callCount(), 50);
  assert.equal(clearTimer.mock.callCount(), 50);
  gate.resolve();
  await task;
  assert.equal((await scope.drain()).completed, true);
  assert.equal(clearTimer.mock.callCount(), 50);
});

test("default deadline is 15000ms and successful drains clear their timers", async (t) => {
  const setTimer = t.mock.method(globalThis, "setTimeout");
  const clearTimer = t.mock.method(globalThis, "clearTimeout");
  const scope = new ResourceScope();
  const gate = deferred();
  scope.run("pending", () => gate.promise);
  const draining = scope.drain();
  assert.equal(setTimer.mock.callCount(), 1);
  const delay = setTimer.mock.calls[0].arguments[1]!;
  assert.ok(delay > 14_900 && delay <= 15_000);
  const handle = setTimer.mock.calls[0].result;
  gate.resolve();
  assert.equal((await draining).completed, true);
  assert.ok(clearTimer.mock.calls.some((call) => call.arguments[0] === handle));
  await scope.drain();
  assert.equal(setTimer.mock.callCount(), 1);
});

test("invalid timeouts reject without cancelling; zero timeout preserves pending work", async () => {
  const scope = new ResourceScope();
  for (const timeout of [-1, NaN, Infinity, 2_147_483_648]) {
    await assert.rejects(scope.drain(timeout), RangeError);
  }
  assert.equal(scope.state, "active");
  const gate = deferred();
  scope.run("pending", () => gate.promise);
  const report = await scope.drain(0);
  assert.equal(report.timedOut, true);
  assert.equal(report.completed, false);
  assert.equal(report.pendingTasks, 1);
  gate.resolve();
  assert.equal((await scope.drain()).completed, true);
  assert.equal((await new ResourceScope().drain(0)).completed, true);
});

test("50 lifecycle cycles release tasks, cleanup, parent listeners and drain timers", async (t) => {
  const parent = new AbortController();
  const emitter = new EventEmitter();
  const setTimer = t.mock.method(globalThis, "setTimeout");
  const clearTimer = t.mock.method(globalThis, "clearTimeout");
  let cleanups = 0;
  for (let cycle = 0; cycle < 50; cycle += 1) {
    const scope = new ResourceScope(parent.signal);
    const listener = (): void => undefined;
    emitter.on("event", listener);
    scope.add("listener", () => {
      emitter.off("event", listener);
      cleanups += 1;
    });
    const interval = setInterval(() => undefined, 60_000);
    scope.add("interval", () => clearInterval(interval));
    scope.run("cooperative", (signal) => new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
    }));
    const reports = await Promise.all([scope.drain(), scope.drain()]);
    assert.ok(reports.every((report) => report.completed));
    assert.equal(scope.snapshot().pendingTasks, 0);
    assert.equal(scope.snapshot().pendingResources, 0);
    assert.equal(emitter.listenerCount("event"), 0);
    assert.equal(getEventListeners(parent.signal, "abort").length, 0);
    assert.equal(getEventListeners(scope.signal, "abort").length, 0);
  }
  assert.equal(cleanups, 50);
  assert.equal(setTimer.mock.callCount(), 100);
  const cleared = new Set(clearTimer.mock.calls.map((call) => call.arguments[0]));
  for (const call of setTimer.mock.calls) assert.ok(cleared.has(call.result));
});

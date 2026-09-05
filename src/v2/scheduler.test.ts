import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { createRequire } from "node:module";
import test, { type TestContext } from "node:test";
import type { CronJob } from "cron";
import { ResourceScope, SelfDrainError } from "./lifecycle";
import { PluginScheduler, type ScheduledJob } from "./scheduler";

const annual: ScheduledJob = { cron: "0 0 0 1 1 *", timeZone: "UTC", description: "fixture" };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

async function fixture(t: TestContext) {
  const cron = await import("cron");
  const factory = t.mock.method(cron.CronJob, "from");
  const logs: { event: string; fields?: Readonly<Record<string, string | number | boolean>> }[] = [];
  const scheduler = new PluginScheduler({ error: (event, fields) => { logs.push({ event, fields }); } });
  const scopes: ResourceScope[] = [];
  const scope = (): ResourceScope => {
    const result = new ResourceScope();
    scopes.push(result);
    return result;
  };
  const jobs = (): CronJob[] => factory.mock.calls.map((call) => call.result).filter(Boolean) as CronJob[];
  t.after(async () => {
    for (const current of scopes) {
      const report = await current.drain(100);
      assert.equal(report.pendingTasks, 0);
      assert.equal(report.pendingResources, 0);
    }
    for (const job of jobs()) assert.equal(job.isActive, false);
    assert.deepEqual(scheduler.snapshot(), { jobs: 0, running: 0 });
  });
  return { scheduler, scope, jobs, logs, cron };
}

test("cron loads only on first register and cancellation during import registers no timer", async () => {
  const require = createRequire(__filename);
  const cronPath = require.resolve("cron");
  assert.equal(require.cache[cronPath], undefined);
  const scheduler = new PluginScheduler({ error() {} });
  assert.deepEqual(scheduler.snapshot(), { jobs: 0, running: 0 });
  assert.equal(require.cache[cronPath], undefined);
  const scope = new ResourceScope();
  const reason = new Error("cancel during import");
  const registering = scheduler.register("plugin", "job", annual, scope, () => assert.fail("must not run"));
  assert.equal(scope.snapshot().pendingTasks, 1);
  scope.abort(reason);
  await assert.rejects(registering, (error) => error === reason);
  assert.ok(require.cache[cronPath]);
  assert.deepEqual(scheduler.snapshot(), { jobs: 0, running: 0 });
  assert.equal((await scope.drain()).completed, true);
  const replacement = new ResourceScope();
  const dispose = await scheduler.register("plugin", "job", annual, replacement, () => undefined);
  await dispose();
  assert.equal((await replacement.drain()).completed, true);
});

test("late registration into an aborted or disposed scope rejects cleanly", async (t) => {
  const f = await fixture(t);
  for (const disposed of [false, true]) {
    const scope = f.scope();
    if (disposed) await scope.drain();
    else scope.abort(new Error("cancelled"));
    await assert.rejects(f.scheduler.register("plugin", "late", annual, scope, () => undefined),
      (error) => error === scope.signal.reason);
  }
  assert.equal(f.jobs().length, 0);
  assert.deepEqual(f.scheduler.snapshot(), { jobs: 0, running: 0 });
});

test("drain waits for registration bookkeeping before allowing a replacement", async (t) => {
  const f = await fixture(t);
  const scope = f.scope();
  const registering = f.scheduler.register("plugin", "replace", annual, scope, () => undefined);
  const rejected = assert.rejects(registering);
  const report = await scope.drain();
  assert.equal(report.completed, true);
  await f.scheduler.register("plugin", "replace", annual, f.scope(), () => undefined);
  await rejected;
});

test("simultaneous duplicate names reject explicitly and preserve the first job", async (t) => {
  const f = await fixture(t);
  const scope = f.scope();
  const first = f.scheduler.register("plugin", "same", annual, scope, () => undefined);
  await assert.rejects(f.scheduler.register("plugin", "same", annual, scope, () => undefined), /already registered/);
  const dispose = await first;
  await assert.rejects(f.scheduler.register("plugin", "same", annual, scope, () => undefined), /already registered/);
  assert.equal(f.jobs().length, 1);
  assert.equal(f.jobs()[0].isActive, true);
  assert.deepEqual(f.scheduler.snapshot(), { jobs: 1, running: 0 });
  await dispose();
});

test("job identity uses plugin and job components without delimiter collisions", async (t) => {
  const f = await fixture(t);
  const scope = f.scope();
  const disposers = await Promise.all([
    f.scheduler.register("first", "same", annual, scope, () => undefined),
    f.scheduler.register("second", "same", annual, scope, () => undefined),
    f.scheduler.register("a:b", "c", annual, scope, () => undefined),
    f.scheduler.register("a", "b:c", annual, scope, () => undefined),
  ]);
  assert.equal(f.scheduler.snapshot().jobs, 4);
  await Promise.all(disposers.map((dispose) => dispose()));
});

test("real cron supports five fields, weekday names, ranges and configured time zones", async (t) => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.parse("2026-09-04T09:59:59Z") });
  await f.scheduler.register("plugin", "weekdays", {
    cron: "*/15 9-17 * * MON-FRI", timeZone: "Asia/Shanghai", description: "weekdays",
  }, f.scope(), () => undefined);
  const job = f.jobs()[0];
  assert.equal(job.cronTime.timeZone, "Asia/Shanghai");
  assert.equal(job.nextDate().toISO(), "2026-09-07T09:00:00.000+08:00");
  assert.deepEqual(job.nextDates(2).map((date) => date.toISO()), [
    "2026-09-07T09:00:00.000+08:00", "2026-09-07T09:15:00.000+08:00",
  ]);
});

test("real cron advances a spring DST gap to the first available local instant", async (t) => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.parse("2026-03-08T06:59:59Z") });
  await f.scheduler.register("plugin", "spring", {
    cron: "0 30 2 * * *", timeZone: "America/New_York", description: "spring",
  }, f.scope(), () => undefined);
  assert.equal(f.jobs()[0].nextDate().toISO(), "2026-03-08T03:00:00.000-04:00");
});

test("real cron schedules the fall DST fold once and then advances to the next day", async (t) => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.parse("2026-11-01T04:00:00Z") });
  await f.scheduler.register("plugin", "fall", {
    cron: "0 30 1 * * *", timeZone: "America/New_York", description: "fall",
  }, f.scope(), () => undefined);
  assert.deepEqual(f.jobs()[0].nextDates(2).map((date) => date.toISO()), [
    "2026-11-01T01:30:00.000-04:00", "2026-11-02T01:30:00.000-05:00",
  ]);
});

test("invalid cron and timezone reject without resource leaks or raw diagnostic data", async (t) => {
  const f = await fixture(t);
  const scope = f.scope();
  for (const spec of [
    { ...annual, cron: "secret-invalid-expression" },
    { ...annual, timeZone: "secret-invalid-zone" },
  ]) {
    await assert.rejects(f.scheduler.register("secret-plugin", "secret-id", spec, scope, () => undefined),
      (error) => error instanceof Error && error.message === "Invalid scheduled job");
    assert.deepEqual(f.scheduler.snapshot(), { jobs: 0, running: 0 });
    assert.equal(scope.snapshot().pendingResources, 0);
    assert.equal(scope.snapshot().pendingTasks, 0);
    assert.deepEqual(scope.snapshot().errors, []);
  }
  assert.equal(f.logs.length, 2);
  assert.equal(JSON.stringify(f.logs).includes("secret"), false);
  await f.scheduler.register("secret-plugin", "secret-id", annual, scope, () => undefined);
});

test("one job suppresses overlap while independent jobs can run concurrently", async (t) => {
  const f = await fixture(t);
  const scope = f.scope();
  const gate = deferred();
  let calls = 0;
  t.after(() => gate.resolve());
  await f.scheduler.register("plugin", "first", annual, scope, async (signal) => {
    assert.equal(signal, scope.signal);
    calls += 1;
    await gate.promise;
  });
  await f.scheduler.register("plugin", "second", annual, scope, () => gate.promise);
  const [first, second] = f.jobs();
  await first.fireOnTick();
  await first.fireOnTick();
  await second.fireOnTick();
  assert.equal(calls, 1);
  assert.equal(scope.snapshot().pendingTasks, 2);
  assert.deepEqual(f.scheduler.snapshot(), { jobs: 2, running: 2 });
  gate.resolve();
  await flush();
  assert.equal(f.scheduler.snapshot().running, 0);
  await first.fireOnTick();
  await flush();
  assert.equal(calls, 2);
});

test("real timer ticks suppress overlap and resume after callback settlement", async (t) => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.parse("2026-01-01T00:00:00Z") });
  const gate = deferred();
  let calls = 0;
  const dispose = await f.scheduler.register("plugin", "seconds", {
    cron: "* * * * * *", timeZone: "UTC", description: "every second",
  }, f.scope(), async () => { calls += 1; await gate.promise; });
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(calls, 1);
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(calls, 1);
  gate.resolve();
  await flush();
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(calls, 2);
  await dispose();
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(calls, 2);
});

test("stopping a timer preserves actual running work in scope and scheduler snapshots", async (t) => {
  const f = await fixture(t);
  const scope = f.scope();
  const gate = deferred();
  const dispose = await f.scheduler.register("plugin", "pending", annual, scope, () => gate.promise);
  await f.jobs()[0].fireOnTick();
  await dispose();
  assert.equal(f.jobs()[0].isActive, false);
  assert.deepEqual(f.scheduler.snapshot(), { jobs: 0, running: 1 });
  const report = await scope.drain(5);
  assert.equal(report.completed, false);
  assert.equal(report.timedOut, true);
  assert.equal(report.pendingTasks, 1);
  assert.equal(report.pendingResources, 0);
  gate.resolve();
  assert.equal((await scope.drain()).completed, true);
  assert.deepEqual(f.scheduler.snapshot(), { jobs: 0, running: 0 });
});

test("scope cancellation stops timers immediately and preserves pending callbacks", async (t) => {
  const f = await fixture(t);
  const scope = f.scope();
  const gate = deferred();
  let calls = 0;
  await f.scheduler.register("plugin", "cancel", annual, scope, async () => { calls += 1; await gate.promise; });
  const job = f.jobs()[0];
  await job.fireOnTick();
  scope.abort();
  assert.equal(job.isActive, false);
  assert.deepEqual(f.scheduler.snapshot(), { jobs: 0, running: 1 });
  await job.fireOnTick();
  assert.equal(calls, 1);
  assert.equal(getEventListeners(scope.signal, "abort").length, 0);
  gate.resolve();
  assert.equal((await scope.drain()).completed, true);
});

test("stale disposer and old scope cleanup cannot stop a replacement", async (t) => {
  const f = await fixture(t);
  const oldScope = f.scope();
  const newScope = f.scope();
  let calls = 0;
  const oldDispose = await f.scheduler.register("plugin", "replace", annual, oldScope, () => undefined);
  await oldDispose();
  const newDispose = await f.scheduler.register("plugin", "replace", annual, newScope, () => { calls += 1; });
  await oldDispose();
  await oldScope.drain();
  assert.equal(f.jobs()[1].isActive, true);
  assert.equal(f.scheduler.snapshot().jobs, 1);
  await f.jobs()[0].fireOnTick();
  await f.jobs()[1].fireOnTick();
  await flush();
  assert.equal(calls, 1);
  await newDispose();
});

test("sync and async callback failures log static events and permit future runs and clean drain", async (t) => {
  const f = await fixture(t);
  const scope = f.scope();
  let calls = 0;
  await f.scheduler.register("secret-plugin", "secret-id", { ...annual, description: "secret-description" }, scope, () => {
    calls += 1;
    if (calls === 1) throw new Error("secret-error");
    if (calls === 2) return Promise.reject({ private: "secret-payload" });
  });
  const job = f.jobs()[0];
  for (let index = 0; index < 3; index += 1) {
    await job.fireOnTick();
    await flush();
    assert.equal(f.scheduler.snapshot().running, 0);
    assert.equal(scope.snapshot().pendingTasks, 0);
  }
  assert.equal(calls, 3);
  assert.deepEqual(f.logs, [
    { event: "scheduler.callback_failed", fields: undefined },
    { event: "scheduler.callback_failed", fields: undefined },
  ]);
  assert.equal((await scope.drain()).completed, true);
  assert.deepEqual(scope.snapshot().errors, []);
  await new Promise<void>((resolve) => setImmediate(resolve));
});

test("callback own-scope drain rejects with SelfDrainError; external drain succeeds", async (t) => {
  const f = await fixture(t);
  const scope = f.scope();
  await f.scheduler.register("plugin", "self-drain", annual, scope, async () => {
    await assert.rejects(scope.drain(), SelfDrainError);
  });
  await f.jobs()[0].fireOnTick();
  await flush();
  assert.deepEqual(f.logs, []);
  assert.equal((await scope.drain()).completed, true);
});

test("throwing diagnostic logger does not reject timer callbacks or retain running slots", async (t) => {
  const f = await fixture(t);
  const scheduler = new PluginScheduler({ error() { throw new Error("logger unavailable"); } });
  const scope = f.scope();
  let calls = 0;
  await scheduler.register("plugin", "failure", annual, scope, () => { calls += 1; throw new Error("callback"); });
  for (let index = 0; index < 2; index += 1) {
    await f.jobs()[0].fireOnTick();
    await flush();
  }
  assert.equal(calls, 2);
  assert.equal(scheduler.snapshot().running, 0);
  assert.equal((await scope.drain()).completed, true);
  assert.deepEqual(scheduler.snapshot(), { jobs: 0, running: 0 });
  await new Promise<void>((resolve) => setImmediate(resolve));
});

test("a start failure stops an allocated timer and releases the name reservation", async (t) => {
  const f = await fixture(t);
  const start = f.cron.CronJob.prototype.start;
  const mocked = t.mock.method(f.cron.CronJob.prototype, "start", function (this: CronJob) {
    start.call(this);
    throw new Error("secret-start-failure");
  });
  const scope = f.scope();
  await assert.rejects(f.scheduler.register("plugin", "retry", annual, scope, () => undefined),
    (error) => error instanceof Error && error.message === "Scheduled job could not start");
  assert.equal(f.jobs()[0].isActive, false);
  assert.deepEqual(f.scheduler.snapshot(), { jobs: 0, running: 0 });
  assert.equal(scope.snapshot().pendingResources, 0);
  assert.equal(getEventListeners(scope.signal, "abort").length, 0);
  mocked.mock.restore();
  await f.scheduler.register("plugin", "retry", annual, scope, () => undefined);
});

test("50 register-run-dispose cycles release timers, listeners, callbacks and scope resources", async (t) => {
  const f = await fixture(t);
  const setTimer = t.mock.method(globalThis, "setTimeout");
  const clearTimer = t.mock.method(globalThis, "clearTimeout");
  let calls = 0;
  for (let cycle = 0; cycle < 50; cycle += 1) {
    const scope = f.scope();
    const dispose = await f.scheduler.register("plugin", "cycle", annual, scope, () => { calls += 1; });
    const job = f.jobs()[cycle];
    await job.fireOnTick();
    await flush();
    const first = dispose();
    assert.equal(dispose(), first);
    await first;
    assert.equal((await scope.drain()).completed, true);
    assert.equal(scope.snapshot().pendingTasks, 0);
    assert.equal(scope.snapshot().pendingResources, 0);
    assert.equal(getEventListeners(scope.signal, "abort").length, 0);
    assert.deepEqual(f.scheduler.snapshot(), { jobs: 0, running: 0 });
  }
  assert.equal(calls, 50);
  assert.equal(setTimer.mock.callCount(), 50);
  const cleared = new Set(clearTimer.mock.calls.map((call) => call.arguments[0]));
  for (const call of setTimer.mock.calls) assert.ok(cleared.has(call.result));
});

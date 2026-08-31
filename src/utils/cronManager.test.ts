import test from "node:test";
import assert from "node:assert/strict";
import type { CronJob } from "cron";
import { cronManager } from "./cronManager";

type CronTaskSnapshot = {
  job: CronJob | null;
  running: number;
  executionsStarted: number;
  executionsFinished: number;
};

test("a cron task skips overlapping executions", async () => {
  const name = `cron-overlap-${process.pid}`;
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const dispose = cronManager.set(name, "0 0 0 1 1 *", async () => {
    calls += 1;
    await gate;
  });

  try {
    const tasks = cronManager.ls(true) as Map<string, CronTaskSnapshot>;
    const task = tasks.get(name);
    assert.ok(task?.job);
    task.job.fireOnTick();
    task.job.fireOnTick();
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(calls, 1);
    assert.equal(task.running, 1);
    assert.equal(task.executionsStarted, 1);

    release();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(task.running, 0);
    assert.equal(task.executionsFinished, 1);
  } finally {
    release();
    await dispose();
  }
});

test("a synchronous cron failure releases the running guard", async () => {
  const name = `cron-sync-failure-${process.pid}`;
  let calls = 0;
  const originalError = console.error;
  console.error = () => undefined;
  const dispose = cronManager.set(name, "0 0 0 1 1 *", () => {
    calls += 1;
    if (calls === 1) throw new Error("injected synchronous failure");
  });

  try {
    const tasks = cronManager.ls(true) as Map<string, CronTaskSnapshot>;
    const task = tasks.get(name);
    assert.ok(task?.job);

    task.job.fireOnTick();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(task.running, 0);
    assert.equal(task.executionsFinished, 1);

    task.job.fireOnTick();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(calls, 2);
    assert.equal(task.running, 0);
    assert.equal(task.executionsFinished, 2);
  } finally {
    console.error = originalError;
    await dispose();
  }
});

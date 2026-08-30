import test from "node:test";
import assert from "node:assert/strict";
import { createGenerationContext } from "./generationContext";

test("drain sweeps disposables registered while a tracked task is settling", async () => {
  const context = createGenerationContext(100);
  const events: string[] = [];
  let settleTask!: () => void;
  const task = new Promise<void>((resolve) => {
    settleTask = () => {
      context.trackDisposable(() => {
        events.push("task-late-disposable");
      });
      resolve();
    };
  });
  context.trackTask(task);
  queueMicrotask(settleTask);

  const result = await context.drain();
  assert.equal(result.completed, true);
  assert.deepEqual(events, ["task-late-disposable"]);
  assert.equal(result.pendingDisposables, 0);
});

test("registering a disposable after drain disposes it immediately and once", async () => {
  const context = createGenerationContext(101);
  await context.drain();
  let disposeCount = 0;
  const cleanup = context.trackDisposable(() => {
    disposeCount += 1;
  });

  assert.equal(disposeCount, 1);
  await cleanup();
  assert.equal(disposeCount, 1);
});

test("late disposable rejection is reported by drain", async () => {
  const context = createGenerationContext(102);
  let settleTask!: () => void;
  const task = new Promise<void>((resolve) => {
    settleTask = () => {
      context.trackDisposable(async () => {
        throw new Error("late cleanup failed");
      }, { label: "late-failure" });
      resolve();
    };
  });
  context.trackTask(task);
  queueMicrotask(settleTask);

  const result = await context.drain();
  assert.equal(result.completed, false);
  assert.equal(result.timedOut, false);
  assert.equal(result.errors.length, 1);
  assert.match(String(result.errors[0]), /late cleanup failed/);
});

test("a rejection registered after disposal is reported by the next drain", async () => {
  const context = createGenerationContext(103);
  await context.drain();
  context.trackDisposable(async () => {
    throw new Error("post-drain cleanup failed");
  });

  const result = await context.drain();
  assert.equal(result.completed, false);
  assert.equal(result.errors.length, 1);
  assert.match(String(result.errors[0]), /post-drain cleanup failed/);
});

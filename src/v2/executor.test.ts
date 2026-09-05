import test from "node:test";
import assert from "node:assert/strict";
import {KeyedExecutor, QueueFullError, ExecutorClosedError, ReentrantExecutionError} from "./executor";
import {ResourceScope, SelfDrainError} from "./lifecycle";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return {promise, resolve};
}

test("executor preserves per-key order while other keys can run", async () => {
  const executor = new KeyedExecutor(2, 3);
  const release = deferred();
  const order: string[] = [];
  const first = executor.submit("a", async () => { order.push("a1"); await release.promise; });
  const second = executor.submit("a", () => { order.push("a2"); });
  await executor.submit("b", () => { order.push("b1"); });
  assert.deepEqual(order, ["a1", "b1"]);
  release.resolve();
  await Promise.all([first, second]);
  await executor.close();
  assert.deepEqual(order, ["a1", "b1", "a2"]);
  assert.deepEqual(executor.snapshot(), {active: 0, queued: 0, closed: true});
});

test("executor rejects overflow before invoking the callback", async () => {
  const executor = new KeyedExecutor(1, 1);
  const release = deferred();
  const first = executor.submit("a", () => release.promise);
  const second = executor.submit("b", () => 2);
  await assert.rejects(executor.submit("c", () => assert.fail("overflow admitted")), QueueFullError);
  release.resolve();
  assert.equal(await second, 2);
  await first;
  await executor.close();
});

test("queued cancellation frees capacity and active cancellation waits for settlement", async () => {
  const executor = new KeyedExecutor(1, 1);
  const started = deferred();
  const release = deferred();
  const first = executor.submit("a", async signal => { started.resolve(); await release.promise; return signal.aborted; });
  await started.promise;
  const abort = new AbortController();
  const queued = executor.submit("a", () => assert.fail("cancelled work ran"), abort.signal);
  const rejected = assert.rejects(queued);
  abort.abort(new Error("test cancel"));
  await rejected;
  assert.equal(executor.snapshot().queued, 0);
  let closed = false;
  const closing = executor.close().then(() => { closed = true; });
  await Promise.resolve();
  assert.equal(closed, false);
  assert.equal(executor.snapshot().active, 1);
  release.resolve();
  assert.equal(await first, true);
  await closing;
  await assert.rejects(executor.submit("b", () => 1), ExecutorClosedError);
});

test("synchronous task failure releases the key and slot", async () => {
  const executor = new KeyedExecutor(1, 1);
  const failed = assert.rejects(executor.submit("a", () => { throw new Error("failure"); }), /failure/);
  const next = executor.submit("a", () => 7);
  await failed;
  assert.equal(await next, 7);
  await executor.close();
});

test("completion releases capacity before the caller can submit again", async () => {
  const executor = new KeyedExecutor(1, 0);
  assert.equal(await executor.submit("a", () => 1), 1);
  assert.equal(executor.snapshot().active, 0);
  assert.equal(await executor.submit("a", () => 2), 2);
  await assert.rejects(executor.submit("a", () => { throw new Error("failed"); }));
  assert.equal(await executor.submit("b", () => 3), 3);
  await executor.close();
});

test("queued work restores its own submitting scope across shared executors", async () => {
  const executor = new KeyedExecutor(1, 3);
  const firstScope = new ResourceScope();
  const secondScope = new ResourceScope();
  const release = deferred();
  const first = firstScope.run("first", () => executor.submit("same-chat", () => release.promise));
  const second = secondScope.run("second", () => executor.submit("same-chat", async () => {
    await assert.rejects(secondScope.drain(5), SelfDrainError);
    assert.equal(secondScope.signal.aborted, false);
    assert.equal((await firstScope.drain(1000)).completed, true);
  }));
  release.resolve();
  await Promise.all([first, second]);
  assert.equal((await secondScope.drain()).completed, true);
  await executor.close();
});

test("reentrant submissions reject instead of waiting for their own queue slot", async () => {
  const executor = new KeyedExecutor(1, 5);
  const other = new KeyedExecutor(1, 0);
  await executor.submit('parent', async () => {
    await assert.rejects(executor.submit('parent', () => 1), ReentrantExecutionError);
    await assert.rejects(executor.submit('other-key', () => 1), ReentrantExecutionError);
    assert.equal(await other.submit('parent', () => 2), 2);
  });
  assert.equal(await executor.submit('parent', () => 3), 3);
  await executor.close();
  await other.close();
});

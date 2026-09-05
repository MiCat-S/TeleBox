import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import childProcess, { type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inspect } from "node:util";
import { setTimeout as delay, setImmediate as turn } from "node:timers/promises";
import { ResourceScope } from "./lifecycle";
import { QueueFullError } from "./executor";
import {
  ScopedProcesses, ProcessError, ProcessSpawnError, ProcessExitError,
  ProcessAbortedError, ProcessTimeoutError, ProcessOutputLimitError, ProcessClosedError,
  type ProcessLimits,
} from "./processes";

const POSIX = process.platform !== "win32";
const OPTIONS = { timeout: 15_000 };
const node = process.execPath;

async function until(check: () => boolean | Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await check())) {
    if (Date.now() >= deadline) assert.fail(message);
    await delay(10);
  }
}

async function exists(file: string): Promise<boolean> {
  try { await fs.access(file); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function fixture(t: TestContext, limits: ProcessLimits = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "telebox-processes-")));
  const scope = new ResourceScope();
  const runner = new ScopedProcesses(scope, {timeoutMs: 5_000, ...limits});
  const children: ChildProcessWithoutNullStreams[] = [];
  const originalSpawn = childProcess.spawn;
  t.mock.method(childProcess, "spawn", (...args: Parameters<typeof childProcess.spawn>) => {
    const child = originalSpawn(...args) as ChildProcessWithoutNullStreams;
    children.push(child);
    return child;
  });
  t.after(async () => {
    await runner.close();
    assert.equal((await scope.drain(5_000)).completed, true);
    for (const child of children) {
      assert.equal(child.stdin.destroyed, true, "stdin descriptor closed");
      assert.equal(child.stdout.destroyed, true, "stdout descriptor closed");
      assert.equal(child.stderr.destroyed, true, "stderr descriptor closed");
    }
    await fs.rm(root, {recursive: true, force: true});
  });
  return {root, scope, runner, children};
}

test("passes argv verbatim, uses explicit cwd/env, and sends binary stdin with EOF", OPTIONS, async t => {
  const {root, runner} = await fixture(t);
  const argument = "space ; $(never-execute) * \" quote";
  const input = Buffer.from([0, 255, 10, 65]);
  const code = `
    const chunks = [];
    process.stdin.on('data', chunk => chunks.push(chunk));
    process.stdin.on('end', () => {
      process.stdout.write(JSON.stringify({arg: process.argv[1], cwd: process.cwd(), token: process.env.TOKEN, input: Buffer.concat(chunks).toString('hex')}));
      process.stderr.write('diagnostic');
    });
  `;
  const result = await runner.run(node, ["-e", code, argument], {cwd: root, env: {TOKEN: "explicit"}, input});
  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout.toString()), {arg: argument, cwd: root, token: "explicit", input: input.toString("hex")});
  assert.equal(result.stderr.toString(), "diagnostic");
  assert.equal(runner.snapshot().active, 0);
});

test("does not inherit ambient environment and snapshots queued argv/env/input", OPTIONS, async t => {
  const {runner} = await fixture(t);
  const key = "TELEBOX_TEST_PROCESS_SECRET";
  const before = process.env[key];
  process.env[key] = "ambient-secret";
  t.after(() => { if (before === undefined) delete process.env[key]; else process.env[key] = before; });
  const empty = await runner.run(node, ["-e", `process.stdout.write(String(process.env.${key}))`]);
  assert.equal(empty.stdout.toString(), "undefined");
  const first = runner.run(node, ["-e", "setTimeout(() => {}, 150)"]);
  const args = ["-e", "process.stdin.pipe(process.stdout); process.stderr.write(process.argv[1] + ':' + process.env.VALUE)", "original"];
  const env = {VALUE: "original"};
  const input = Buffer.from("original");
  const queued = runner.run(node, args, {env, input});
  args[2] = "changed"; env.VALUE = "changed"; input.fill(120);
  await first;
  const result = await queued;
  assert.equal(result.stdout.toString(), "original");
  assert.equal(result.stderr.toString(), "original:original");
});

test("defaults admit one active process and eight queued jobs, rejecting overflow before spawn", OPTIONS, async t => {
  const {runner, children, scope} = await fixture(t);
  const jobs = Array.from({length: 9}, () => runner.run(node, ["-e", "setInterval(() => {}, 1000)"]).catch(error => error));
  await assert.rejects(runner.run(node, ["-e", "throw new Error('must not start')"]), QueueFullError);
  assert.equal(runner.snapshot().active, 1);
  assert.equal(runner.snapshot().queued, 8);
  assert.equal(children.length, 1);
  await runner.close();
  const outcomes = await Promise.all(jobs);
  assert.ok(outcomes.every(result => result instanceof ProcessError));
  assert.equal(children.length, 1);
  assert.equal(scope.snapshot().pendingTasks, 0);
  await assert.rejects(runner.run(node), ProcessClosedError);
});

test("configured concurrency is bounded and zero queue permits sequential awaited calls", OPTIONS, async t => {
  const {runner} = await fixture(t, {concurrency: 2, queueCapacity: 0});
  const first = runner.run(node, ["-e", "setTimeout(() => {}, 100)"]);
  const second = runner.run(node, ["-e", "setTimeout(() => {}, 100)"]);
  await assert.rejects(runner.run(node), QueueFullError);
  assert.equal(runner.snapshot().active, 2);
  await Promise.all([first, second]);
  for (let index = 0; index < 3; index++) await runner.run(node, ["-e", ""]);
});

test("queued cancellation releases capacity without spawning and does not leak its reason", OPTIONS, async t => {
  const {runner, children} = await fixture(t, {queueCapacity: 1});
  const first = runner.run(node, ["-e", "setTimeout(() => {}, 150)"]);
  const controller = new AbortController();
  const cancelled = runner.run(node, ["-e", "throw Error('must not run')"], {signal: controller.signal});
  const rejected = assert.rejects(cancelled, error => {
    assert.ok(error instanceof ProcessAbortedError);
    assert.doesNotMatch(inspect(error), /secret-reason/);
    return true;
  });
  controller.abort(new ProcessError("ABORTED", "secret-reason"));
  await rejected;
  assert.equal(runner.snapshot().queued, 0);
  const next = runner.run(node, ["-e", "process.stdout.write('next')"]);
  await first;
  assert.equal((await next).stdout.toString(), "next");
  assert.equal(children.length, 2);
});

test("pre-aborted signals and cancelled scopes reject before spawn", OPTIONS, async t => {
  const {runner, children, scope} = await fixture(t);
  const controller = new AbortController();
  controller.abort(new Error("secret-reason"));
  await assert.rejects(runner.run(node, [], {signal: controller.signal}), ProcessAbortedError);
  scope.abort(new Error("secret-scope-reason"));
  await assert.rejects(runner.run(node), ProcessClosedError);
  assert.equal(children.length, 0);
});

test("spawn and exit failures expose bounded output only to the caller, not error formatting", OPTIONS, async t => {
  const {runner, root} = await fixture(t);
  const secret = "fixture-private-output-and-argv";
  await assert.rejects(runner.run(path.join(root, secret), [secret], {env: {TOKEN: secret}}), error => {
    assert.ok(error instanceof ProcessSpawnError);
    assert.equal(error.stdout.length + error.stderr.length, 0);
    assert.doesNotMatch(inspect(error, {showHidden: true}) + JSON.stringify(error) + error.stack, new RegExp(secret));
    return true;
  });
  await assert.rejects(runner.run(node, ["-e", "process.stdout.write(process.argv[1]); process.stderr.write(process.env.TOKEN); process.exitCode = 7", secret], {env: {TOKEN: secret}}), error => {
    assert.ok(error instanceof ProcessExitError);
    assert.equal(error.exitCode, 7);
    assert.equal(error.stdout.toString(), secret);
    assert.equal(error.stderr.toString(), secret);
    assert.doesNotMatch(inspect(error, {showHidden: true}) + JSON.stringify(error) + error.stack, new RegExp(secret));
    return true;
  });
});

for (const stream of ["stdout", "stderr"] as const) {
  test(`${stream} flood enforces a byte limit and reclaims the process before rejection`, OPTIONS, async t => {
    const {runner, children} = await fixture(t, {maxOutputBytes: 1024});
    await assert.rejects(runner.run(node, ["-e", `setInterval(() => process.${stream}.write(Buffer.alloc(65536, 255)), 1)`]), error => {
      assert.ok(error instanceof ProcessOutputLimitError);
      assert.equal(error.stdout.length + error.stderr.length, 1024);
      assert.equal(error[stream].length, 1024);
      return true;
    });
    assert.equal(runner.snapshot().active, 0);
    if (POSIX) assert.equal(alive(-children[0].pid!), false);
  });
}

test("stdout and stderr share a cumulative cap and exact-limit output succeeds", OPTIONS, async t => {
  const {runner} = await fixture(t, {maxOutputBytes: 8});
  const exact = await runner.run(node, ["-e", "process.stdout.write('1234'); process.stderr.write('5678')"]);
  assert.equal(exact.stdout.length + exact.stderr.length, 8);
  await assert.rejects(runner.run(node, ["-e", "process.stdout.write('1234'); process.stderr.write('56789')"]), error => {
    assert.ok(error instanceof ProcessOutputLimitError);
    assert.equal(error.stdout.length + error.stderr.length, 8);
    return true;
  });
});

test("execution timeout waits for child close and clears its task", OPTIONS, async t => {
  const {runner, scope, children} = await fixture(t);
  await assert.rejects(runner.run(node, ["-e", "setInterval(() => {}, 1000)"], {timeoutMs: 100}), ProcessTimeoutError);
  assert.equal(runner.snapshot().active, 0);
  assert.equal(scope.snapshot().pendingTasks, 0);
  if (POSIX) assert.equal(alive(-children[0].pid!), false);
});

test("scope drain timeout retains live tasks/slots until TERM grace and KILL complete", {...OPTIONS, skip: !POSIX}, async t => {
  const {runner, root, scope, children} = await fixture(t, {killGraceMs: 300});
  const ready = path.join(root, "ready");
  const term = path.join(root, "term");
  const task = runner.run(node, ["-e", `
    const fs = require('node:fs');
    process.on('SIGTERM', () => fs.writeFileSync(process.argv[2], 'TERM'));
    fs.writeFileSync(process.argv[1], String(process.pid));
    setInterval(() => {}, 1000);
  `, ready, term]);
  const rejected = assert.rejects(task, error => {
    assert.ok(error instanceof ProcessAbortedError);
    assert.equal(error.signal, "SIGKILL");
    return true;
  });
  await until(() => exists(ready), "child did not become ready");
  const report = await scope.drain(5);
  assert.equal(report.completed, false);
  assert.equal(report.timedOut, true);
  assert.equal(report.pendingTasks, 1);
  assert.equal(report.pendingResources, 1);
  assert.equal(runner.snapshot().active, 1);
  await until(() => exists(term), "TERM was not delivered before KILL");
  assert.equal(alive(-children[0].pid!), true);
  await assert.rejects(runner.run(node), ProcessClosedError);
  await rejected;
  assert.equal(alive(-children[0].pid!), false);
  assert.equal((await scope.drain(1000)).completed, true);
});

test("cooperative TERM exit is awaited and caller abort reasons stay private", {...OPTIONS, skip: !POSIX}, async t => {
  const {runner, root} = await fixture(t);
  const ready = path.join(root, "ready");
  const controller = new AbortController();
  const task = runner.run(node, ["-e", `
    process.on('SIGTERM', () => { process.stdout.write('term-observed', () => process.exit(0)); });
    require('node:fs').writeFileSync(process.argv[1], 'ready');
    setInterval(() => {}, 1000);
  `, ready], {signal: controller.signal});
  const rejected = assert.rejects(task, error => {
    assert.ok(error instanceof ProcessAbortedError);
    assert.equal(error.stdout.toString(), "term-observed");
    assert.equal(error.exitCode, 0);
    assert.doesNotMatch(inspect(error), /private-abort-reason/);
    return true;
  });
  await until(() => exists(ready), "child did not become ready");
  controller.abort(new Error("private-abort-reason"));
  await rejected;
  assert.equal((await runner.run(node, ["-e", "process.stdout.write('still-open')"])).stdout.toString(), "still-open");
});

test("leader close with closed pipes still waits for and kills a live forked descendant", {...OPTIONS, skip: !POSIX}, async t => {
  const {runner, root, scope, children} = await fixture(t, {killGraceMs: 400});
  const descendant = path.join(root, "descendant.cjs");
  const pidFile = path.join(root, "descendant.pid");
  const termFile = path.join(root, "descendant.term");
  await fs.writeFile(descendant, `
    const fs = require('node:fs');
    process.on('SIGTERM', () => fs.writeFileSync(process.argv[3], 'TERM'));
    fs.writeFileSync(process.argv[2], String(process.pid));
    process.send('ready');
    setInterval(() => {}, 1000);
  `);
  let settled = false;
  const running = runner.run(node, ["-e", `
    const {fork} = require('node:child_process');
    const child = fork(process.argv[1], process.argv.slice(2), {execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc']});
    child.once('message', () => { child.disconnect(); process.exit(0); });
  `, descendant, pidFile, termFile]).finally(() => { settled = true; });
  void running.catch(() => undefined);
  await until(() => exists(termFile), "descendant did not receive group TERM");
  const pid = Number(await fs.readFile(pidFile, "utf8"));
  await until(() => children[0].stdout.destroyed && children[0].stderr.destroyed, "leader pipes did not close");
  assert.equal(alive(pid), true);
  assert.equal(settled, false);
  assert.equal(runner.snapshot().active, 1);
  assert.equal(scope.snapshot().pendingTasks, 1);
  const result = await running;
  assert.equal(result.exitCode, 0);
  assert.equal(alive(pid), false);
  assert.equal(alive(-children[0].pid!), false);
});

test("abort kills a forked descendant that inherited output pipes", {...OPTIONS, skip: !POSIX}, async t => {
  const {runner, root, children} = await fixture(t, {killGraceMs: 200});
  const descendant = path.join(root, "descendant.cjs");
  const pidFile = path.join(root, "descendant.pid");
  await fs.writeFile(descendant, `
    process.on('SIGTERM', () => {});
    require('node:fs').writeFileSync(process.argv[2], String(process.pid));
    process.send('ready');
    setInterval(() => {}, 1000);
  `);
  const ready = path.join(root, "ready");
  const controller = new AbortController();
  const task = runner.run(node, ["-e", `
    const {fork} = require('node:child_process');
    const child = fork(process.argv[1], [process.argv[2]], {execArgv: [], stdio: ['ignore', 'inherit', 'inherit', 'ipc']});
    child.once('message', () => require('node:fs').writeFileSync(process.argv[3], 'ready'));
    setInterval(() => {}, 1000);
  `, descendant, pidFile, ready], {signal: controller.signal});
  const rejected = assert.rejects(task, ProcessAbortedError);
  await until(() => exists(ready), "descendant did not become ready");
  const pid = Number(await fs.readFile(pidFile, "utf8"));
  controller.abort();
  await rejected;
  assert.equal(alive(pid), false);
  assert.equal(alive(-children[0].pid!), false);
});

test("uncertain group liveness does not release the slot or claim drain completion", {...OPTIONS, skip: !POSIX}, async t => {
  const {runner, scope, children} = await fixture(t, {killGraceMs: 20});
  const kill = process.kill.bind(process);
  let markProbed!: () => void;
  const probed = new Promise<void>(resolve => { markProbed = resolve; });
  let uncertain = true;
  t.mock.method(process, "kill", (pid: number, signal?: string | number) => {
    if (children[0]?.pid && pid === -children[0].pid && signal === 0 && uncertain) {
      markProbed();
      throw Object.assign(new Error("private-probe-error"), {code: "EPERM"});
    }
    return kill(pid, signal);
  });
  const running = runner.run(node, ["-e", "process.exit(0)"]);
  const rejected = assert.rejects(running, error => error instanceof ProcessError && error.code === "CONTROL_FAILED");
  try {
    // The failed probe must establish the first failure before drain aborts the scope.
    await probed;
    await until(() => children[0].stdout.destroyed, "child did not close");
    const report = await scope.drain(30);
    assert.equal(report.timedOut, true);
    assert.equal(report.pendingTasks, 1);
    assert.equal(runner.snapshot().active, 1);
  } finally { uncertain = false; }
  await rejected;
  assert.equal((await scope.drain(1000)).completed, true);
});

test("stdin EPIPE is observed, terminates the helper, and closes every pipe", OPTIONS, async t => {
  const {runner} = await fixture(t);
  await assert.rejects(runner.run(node, ["-e", "require('node:fs').closeSync(0); setInterval(() => {}, 1000)"], {input: Buffer.alloc(1_048_576)}), error => {
    assert.ok(error instanceof ProcessError);
    assert.equal(error.code, "IO_FAILED");
    return true;
  });
});

test("invalid options and oversized UTF-8 input reject without spawning or revealing values", OPTIONS, async t => {
  const {runner, children} = await fixture(t, {maxInputBytes: 2});
  const invalid = [
    runner.run("relative-secret-command"),
    runner.run(node, ["secret\0argument"]),
    runner.run(node, [], {cwd: "relative-secret-directory"}),
    runner.run(node, [], {env: {SECRET: "secret\0value"}}),
    runner.run(node, [], {input: "\u20ac"}),
    runner.run(node, [], {timeoutMs: 0}),
    runner.run(node, [], {timeoutMs: 6000}),
    runner.run(node, [], {killGraceMs: -1}),
    runner.run(node, [], {maxOutputBytes: Infinity}),
  ];
  for (const task of invalid) await assert.rejects(task, error => {
    assert.ok(error instanceof TypeError);
    assert.doesNotMatch(inspect(error), /secret/);
    return true;
  });
  assert.equal(children.length, 0);
});

test("50 sequential invocations leave no tasks, process handles, pipes, or runner timers", OPTIONS, async t => {
  const baseline = process.getActiveResourcesInfo();
  const {runner, scope, children} = await fixture(t, {queueCapacity: 0});
  for (let index = 0; index < 50; index++) {
    const result = await runner.run(node, ["-e", "process.stdout.write('ok')"]);
    assert.equal(result.stdout.toString(), "ok");
    assert.equal(runner.snapshot().active, 0);
    assert.equal(scope.snapshot().pendingTasks, 0);
  }
  await runner.close();
  assert.equal(scope.snapshot().pendingResources, 0);
  assert.equal(children.length, 50);
  // Child close can precede libuv's final ProcessWrap close callback.
  await turn();
  await turn();
  const resources = process.getActiveResourcesInfo();
  for (const type of ["ProcessWrap", "PipeWrap", "Timeout"]) {
    assert.ok(resources.filter(value => value === type).length <= baseline.filter(value => value === type).length,
      `resource count increased: ${type}`);
  }
});

test("ignored run rejections are observed and close is idempotent", OPTIONS, async t => {
  const {runner, scope} = await fixture(t);
  void runner.run(node, ["-e", "process.exit(9)"]);
  await until(() => scope.snapshot().pendingTasks === 0, "ignored failed task did not settle");
  const closing = runner.close();
  assert.equal(runner.close(), closing);
  await closing;
  void runner.run(node);
  await turn();
});

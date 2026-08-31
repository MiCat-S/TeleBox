import test from "node:test";
import assert from "node:assert/strict";
import { logger, LogLevel } from "./logger";

type LoggerInternals = {
  level: LogLevel;
  formatLog(level: string, args: unknown[]): string;
  constructor: {
    downgradeLastLogged: Map<string, number>;
    shouldLogDowngraded(rateKey: string, now: number): boolean;
    originalWarn: (...args: unknown[]) => void;
  };
};

const internals = logger as unknown as LoggerInternals;

test("silent logging does not grow the downgraded-error cache", () => {
  const cache = internals.constructor.downgradeLastLogged;
  const previousLevel = internals.level;
  cache.clear();
  internals.level = LogLevel.SILENT;
  try {
    for (let i = 10_000_000; i < 10_000_010; i++) {
      console.error(`PERSISTENT_TIMESTAMP_OUTDATED channel gap for ${i}`);
    }
    assert.equal(cache.size, 0);
  } finally {
    internals.level = previousLevel;
    cache.clear();
  }
});

test("downgraded-error cache remains bounded while warnings are enabled", () => {
  const cache = internals.constructor.downgradeLastLogged;
  cache.clear();
  try {
    for (let i = 0; i < 1_000; i++) {
      internals.constructor.shouldLogDowngraded(`channel:${i}`, Date.now());
    }
    assert.ok(cache.size <= 200, `cache grew to ${cache.size} entries`);
  } finally {
    cache.clear();
  }
});

test("GramJS formatting avoids capturing a caller stack", () => {
  const ErrorWithStackHook = Error as ErrorConstructor & {
    prepareStackTrace?: (error: Error, stack: NodeJS.CallSite[]) => unknown;
  };
  const previousPrepareStackTrace = ErrorWithStackHook.prepareStackTrace;
  let captures = 0;
  ErrorWithStackHook.prepareStackTrace = (_error, stack) => {
    captures += 1;
    return stack.map(String).join("\n");
  };
  try {
    internals.formatLog("INFO ", [
      "[2026-08-31T00:00:00.000] [INFO] - connected",
    ]);
    assert.equal(captures, 0);

    internals.formatLog("INFO ", ["ordinary application log"]);
    assert.equal(captures, 1);
  } finally {
    ErrorWithStackHook.prepareStackTrace = previousPrepareStackTrace;
  }
});

test("logger.warn emits one console warning", () => {
  const constructor = internals.constructor;
  const previousOriginalWarn = constructor.originalWarn;
  const previousLevel = internals.level;
  let calls = 0;
  constructor.originalWarn = () => {
    calls += 1;
  };
  internals.level = LogLevel.WARNING;
  try {
    logger.warn("one warning");
    assert.equal(calls, 1);
  } finally {
    internals.level = previousLevel;
    constructor.originalWarn = previousOriginalWarn;
  }
});

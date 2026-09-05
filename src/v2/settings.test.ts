import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test, { type TestContext } from "node:test";
import { ResourceScope } from "./lifecycle";
import {
  SettingsRegistry, SettingsError, type SettingsAdapter, type SettingsField,
  type SettingsErrorCode,
} from "./settings";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const isError = (code: SettingsErrorCode) => (error: unknown): boolean =>
  error instanceof SettingsError && error.code === code && !error.message.includes("private-value");

function fixture(t: TestContext, fields: SettingsField[] = [
  { key: "name", label: "Name", type: "string" },
], initial: Record<string, unknown> = {}) {
  const registry = new SettingsRegistry();
  const scope = new ResourceScope();
  const calls = { schema: 0, read: 0, update: 0 };
  const values = { ...initial };
  const patches: Record<string, unknown>[] = [];
  const adapter: SettingsAdapter = {
    id: "legacy-id", title: "Settings", description: "Description", category: "Plugin", icon: "icon",
    getSchema(signal) {
      assert.equal(signal, scope.signal);
      assert.ok(scope.snapshot().pendingTasks > 0);
      calls.schema += 1;
      return fields;
    },
    getValues(signal) {
      assert.equal(signal, scope.signal);
      assert.ok(scope.snapshot().pendingTasks > 0);
      calls.read += 1;
      return values;
    },
    setValues(patch, signal) {
      assert.equal(signal, scope.signal);
      assert.ok(scope.snapshot().pendingTasks > 0);
      calls.update += 1;
      patches.push(patch);
      Object.assign(values, patch);
    },
  };
  t.after(async () => {
    const report = await scope.drain(100);
    assert.equal(report.completed, true);
    assert.equal(report.pendingTasks, 0);
    assert.equal(report.pendingResources, 0);
    assert.deepEqual(await registry.list(), []);
  });
  return { registry, scope, adapter, calls, values, fields, patches,
    register: () => registry.register("plugin", adapter, scope) };
}

test("registration is callback-free and list is tracked without schema/read side effects", async (t) => {
  const f = fixture(t);
  f.register();
  assert.deepEqual(f.calls, { schema: 0, read: 0, update: 0 });
  assert.equal(f.scope.snapshot().pendingTasks, 0);
  assert.equal(f.scope.snapshot().pendingResources, 1);
  const listing = f.registry.list();
  assert.equal(f.scope.snapshot().pendingTasks, 1);
  assert.deepEqual(await listing, [{
    pluginId: "plugin", id: "legacy-id", title: "Settings", description: "Description", category: "Plugin", icon: "icon",
  }]);
  assert.deepEqual(f.calls, { schema: 0, read: 0, update: 0 });
  assert.equal(f.scope.snapshot().pendingTasks, 0);
});

test("schema preserves every supported field type and declared UI metadata", async (t) => {
  const fields: SettingsField[] = [
    { key: "text", label: "Text", type: "string", description: "Details", placeholder: "Input", default: "initial", required: true, min: 1, max: 10 },
    { key: "count", label: "Count", type: "number", min: 0, max: 20, default: 2 },
    { key: "enabled", label: "Enabled", type: "boolean", default: false },
    { key: "mode", label: "Mode", type: "select", options: [{ value: "one", label: "One" }], default: "one" },
    { key: "body", label: "Body", type: "textarea", placeholder: "Body" },
    { key: "data", label: "Data", type: "json", default: { nested: [1, true] } },
    { key: "password", label: "Password", type: "password", secret: false, default: "private-value" },
    { key: "providers", label: "Providers", type: "provider-list", providerColumns: "name|url|key", providerAddLabel: "Add", default: "private-value" },
    { key: "prompts", label: "Prompts", type: "prompt-map", promptKeyPlaceholder: "Short name", promptValuePlaceholder: "Prompt" },
    { key: "tags", label: "Tags", type: "tag-list", tagPlaceholder: "Tag", tagAllowDuplicates: true },
  ];
  const f = fixture(t, fields);
  f.register();
  const schema = await f.registry.schema("plugin");
  assert.deepEqual(schema.slice(0, 6), fields.slice(0, 6));
  assert.deepEqual(schema.slice(8), fields.slice(8));
  assert.equal(schema[6].secret, true);
  assert.equal(schema[7].secret, true);
  assert.equal(Object.hasOwn(schema[6], "default"), false);
  assert.equal(Object.hasOwn(schema[7], "default"), false);
  assert.equal(schema[7].providerColumns, "name|url|key");
  assert.equal(schema[7].providerAddLabel, "Add");
  assert.equal(JSON.stringify(schema).includes("private-value"), false);
  schema[0].label = "mutated";
  (schema[3].options as { value: string; label: string }[])[0].value = "mutated";
  assert.equal((await f.registry.schema("plugin"))[0].label, "Text");
  assert.equal(fields[3].options![0].value, "one");
});

test("read returns only declared public fields and secret presence, including entire provider lists", async (t) => {
  const f = fixture(t, [
    { key: "visible", label: "Visible", type: "string" },
    { key: "flag", label: "Flag", type: "boolean" },
    { key: "token", label: "Token", type: "string", secret: true },
    { key: "password", label: "Password", type: "password" },
    { key: "providers", label: "Providers", type: "provider-list", providerColumns: "name|host|credentials" },
    { key: "empty", label: "Empty", type: "password" },
    { key: "missing", label: "Missing", type: "password" },
  ], {
    visible: "public", flag: false, token: "private-value-token", password: "private-value-password",
    providers: "server | host | private-value-key", empty: "", undeclared: "private-value-hidden",
  });
  f.register();
  const result = await f.registry.read("plugin");
  assert.deepEqual(result, {
    values: { visible: "public", flag: false },
    secretSet: { token: true, password: true, providers: true, empty: false, missing: false },
  });
  assert.equal(JSON.stringify(result).includes("private-value"), false);
  assert.equal(Object.hasOwn(result.values, "password"), false);
});

test("secret options and defaults are not exposed by schema", async (t) => {
  const f = fixture(t, [{ key: "choice", label: "Choice", type: "select", secret: true,
    options: [{ value: "private-value", label: "Private credential" }], default: "private-value" }]);
  f.register();
  assert.deepEqual(await f.registry.schema("plugin"), [{ key: "choice", label: "Choice", type: "select", secret: true }]);
  await f.registry.patch("plugin", { choice: "private-value" });
  assert.deepEqual((await f.registry.read("plugin")).secretSet, { choice: true });
});

test("read does not access unknown values or return mutable adapter-owned objects", async (t) => {
  const f = fixture(t, [{ key: "data", label: "Data", type: "json" }], { data: { nested: [1, 2] } });
  let getterCalls = 0;
  Object.defineProperty(f.values, "undeclared", { enumerable: true, get() { getterCalls += 1; throw new Error("private-value"); } });
  f.register();
  const result = await f.registry.read("plugin");
  (result.values.data as { nested: number[] }).nested.push(3);
  assert.deepEqual(f.values.data, { nested: [1, 2] });
  assert.equal(getterCalls, 0);
});

test("partial patches preserve omitted required fields and secrets without sentinel values", async (t) => {
  const f = fixture(t, [
    { key: "name", label: "Name", type: "string", required: true, default: "default" },
    { key: "password", label: "Password", type: "password", required: true },
  ], { name: "before", password: "private-value", hidden: "preserved" });
  f.register();
  await f.registry.patch("plugin", { name: "after" });
  assert.deepEqual(f.patches, [{ name: "after" }]);
  assert.equal(f.calls.read, 0);
  assert.equal(f.values.password, "private-value");
  assert.equal(f.values.hidden, "preserved");
  await f.registry.patch("plugin", (await f.registry.read("plugin")).values);
  assert.equal(f.values.password, "private-value");
  await f.registry.patch("plugin", { password: "********" });
  assert.equal(f.values.password, "********");
  const updates = f.calls.update;
  await f.registry.patch("plugin", {});
  assert.equal(f.calls.update, updates);
});

test("patch accepts legacy complex-field wire forms without coercing them", async (t) => {
  const f = fixture(t, [
    { key: "json", label: "JSON", type: "json" },
    { key: "prompts", label: "Prompts", type: "prompt-map" },
    { key: "tags", label: "Tags", type: "tag-list" },
    { key: "providers", label: "Providers", type: "provider-list" },
  ]);
  f.register();
  const text = { json: '{"enabled":true}', prompts: '{"short":"Prompt"}', tags: "one two", providers: "name | url | private-value" };
  await f.registry.patch("plugin", text);
  assert.deepEqual(f.patches[0], text);
  await f.registry.patch("plugin", { json: { array: [null, false, 3] }, prompts: { key: "value" }, tags: ["one", "two"] });
  assert.deepEqual(f.patches[1], { json: { array: [null, false, 3] }, prompts: { key: "value" }, tags: ["one", "two"] });
  assert.equal((await f.registry.read("plugin")).secretSet.providers, true);
});

test("bad basic types, required values, ranges and options never call update", async (t) => {
  const f = fixture(t, [
    { key: "text", label: "Text", type: "string", required: true, min: 2, max: 5 },
    { key: "number", label: "Number", type: "number", required: true, min: 0, max: 10 },
    { key: "boolean", label: "Boolean", type: "boolean", required: true },
    { key: "select", label: "Select", type: "select", options: [{ value: "a", label: "A" }] },
    { key: "password", label: "Password", type: "password", required: true },
    { key: "providers", label: "Providers", type: "provider-list", required: true },
    { key: "json", label: "JSON", type: "json" },
    { key: "prompts", label: "Prompts", type: "prompt-map", required: true },
    { key: "tags", label: "Tags", type: "tag-list", required: true, max: 2 },
  ]);
  f.register();
  for (const patch of [
    { text: "" }, { text: " " }, { text: 3 }, { text: "longer" },
    { number: "3" }, { number: -1 }, { number: 11 }, { number: Infinity }, { number: NaN },
    { boolean: "false" }, { boolean: 1 }, { select: "private-value" }, { password: "" },
    { providers: [] }, { providers: "" }, { json: "sourceexpr:private-value" },
    { prompts: { key: 3 } }, { prompts: "[]" }, { prompts: {} },
    { tags: ["one", "one"] }, { tags: "one one" }, { tags: [] }, { tags: ["one", "two", "three"] },
    { tags: [3] }, { text: null }, { text: undefined }, { text: true },
  ]) {
    await assert.rejects(f.registry.patch("plugin", patch), isError("invalid_patch"));
    assert.equal(f.calls.update, 0);
  }
  await f.registry.patch("plugin", { text: "good", number: 0, boolean: false, select: "a" });
  assert.equal(f.calls.update, 1);
});

test("unknown keys reject the entire patch before update and defaults are not added", async (t) => {
  const f = fixture(t, [{ key: "name", label: "Name", type: "string", default: "default" }]);
  f.register();
  await assert.rejects(f.registry.patch("plugin", { name: "valid", "private-value-unknown": "private-value" }), isError("invalid_patch"));
  await assert.rejects(f.registry.patch("plugin", { secretSet: {} }), isError("invalid_patch"));
  assert.equal(f.calls.update, 0);
  assert.deepEqual(f.values, {});
});

test("prototype pollution keys are rejected at every structured-data boundary", async (t) => {
  const f = fixture(t, [
    { key: "data", label: "Data", type: "json" }, { key: "prompts", label: "Prompts", type: "prompt-map" },
  ]);
  f.register();
  for (const key of ["__proto__", "constructor", "prototype"]) {
    const polluted = JSON.parse(`{"${key}":{"polluted":true}}`);
    for (const patch of [polluted, { data: polluted }, { data: [polluted] },
      { data: JSON.stringify(polluted) }, { prompts: JSON.stringify(polluted) }]) {
      await assert.rejects(f.registry.patch("plugin", patch), isError("invalid_patch"));
    }
  }
  await assert.rejects(f.registry.patch("plugin", { __proto__: { polluted: true }, data: {} }), isError("invalid_patch"));
  assert.equal(f.calls.update, 0);
  assert.equal(Object.hasOwn(Object.prototype, "polluted"), false);
});

test("non-data patches, accessors, cycles and excessive nesting are rejected without executing getters", async (t) => {
  const f = fixture(t, [{ key: "data", label: "Data", type: "json" }]);
  f.register();
  let executed = 0;
  const accessor = Object.defineProperty({}, "data", { enumerable: true, get() { executed += 1; return "private-value"; } });
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  let deep: unknown = {};
  for (let index = 0; index < 70; index += 1) deep = { child: deep };
  const symbol = { data: {}, [Symbol("private-value")]: "private-value" };
  for (const patch of [null, [], "data", 1, accessor, symbol, { data: cycle }, { data: deep },
    { data: () => undefined }, { data: new Date() }, { data: BigInt(1) }, { data: new Map() }, { data: Array(2) }]) {
    await assert.rejects(f.registry.patch("plugin", patch), isError("invalid_patch"));
  }
  assert.equal(executed, 0);
  assert.equal(f.calls.update, 0);
});

test("schema source expressions are inert metadata and JSON source text is never evaluated", async (t) => {
  const field = { key: "data", label: "Data", type: "json", sourceexpr: "globalThis.privateValueExecuted = true" } as SettingsField;
  const f = fixture(t, [field]);
  let executed = 0;
  Object.defineProperty(field, "sourceexpr", { get() { executed += 1; return "private-value"; } });
  f.register();
  assert.deepEqual(await f.registry.schema("plugin"), [{ key: "data", label: "Data", type: "json" }]);
  await assert.rejects(f.registry.patch("plugin", { data: "(()=>{throw 'private-value'})()" }), isError("invalid_patch"));
  assert.equal(executed, 0);
  assert.equal(f.calls.update, 0);
});

test("malformed schemas reject reads and writes without invoking value callbacks", async (t) => {
  const f = fixture(t);
  const invalid: unknown[] = [
    null, {}, Array(1), [{ key: "name", label: "Name", type: "sourceexpr" }],
    [{ key: "constructor", label: "Unsafe", type: "string" }],
    [{ key: "name", label: "Name", type: "string" }, { key: "name", label: "Duplicate", type: "string" }],
    [{ key: "name", label: "Name", type: "number", min: 3, max: 1 }],
    [{ key: "name", label: "Name", type: "select", options: [] }],
    [{ key: "name", label: "Name", type: "string", required: "yes" }],
  ];
  let current: unknown;
  f.adapter.getSchema = () => current as SettingsField[];
  f.register();
  for (current of invalid) {
    await assert.rejects(f.registry.schema("plugin"), isError("invalid_schema"));
    await assert.rejects(f.registry.read("plugin"), isError("invalid_schema"));
    await assert.rejects(f.registry.patch("plugin", { name: "value" }), isError("invalid_schema"));
  }
  assert.equal(f.calls.read, 0);
  assert.equal(f.calls.update, 0);
});

test("adapter callback errors are sanitized and do not poison a later clean drain", async (t) => {
  for (const callback of ["getSchema", "getValues", "setValues"] as const) {
    await t.test(callback, async (child) => {
      const f = fixture(child);
      f.adapter[callback] = () => { throw new Error("private-value"); };
      f.register();
      const action = callback === "getSchema" ? f.registry.schema("plugin") :
        callback === "getValues" ? f.registry.read("plugin") : f.registry.patch("plugin", { name: "ok" });
      await assert.rejects(action, isError("adapter_failed"));
      assert.deepEqual(f.scope.snapshot().errors, []);
    });
  }
});

test("patch snapshots input before asynchronous schema and invokes update with a detached copy", async (t) => {
  const f = fixture(t, [{ key: "data", label: "Data", type: "json" }]);
  const gate = deferred<SettingsField[]>();
  f.adapter.getSchema = () => gate.promise;
  f.register();
  const patch: Record<string, unknown> = { data: { value: 1 } };
  const pending = f.registry.patch("plugin", patch);
  (patch.data as { value: number }).value = 2;
  patch.unknown = "private-value";
  gate.resolve(f.fields);
  await pending;
  assert.deepEqual(f.patches, [{ data: { value: 1 } }]);
  assert.notEqual(f.patches[0].data, patch.data);
});

test("unloading while schema is pending prevents value callbacks and releases only after settlement", async (t) => {
  for (const operation of ["schema", "read", "patch"] as const) {
    await t.test(operation, async (child) => {
      const f = fixture(child);
      const gate = deferred<SettingsField[]>();
      f.adapter.getSchema = () => gate.promise;
      f.register();
      const pending = operation === "patch" ? f.registry.patch("plugin", { name: "value" }) : f.registry[operation]("plugin");
      const rejection = assert.rejects(pending, isError("unavailable"));
      const report = await f.scope.drain(5);
      assert.equal(report.timedOut, true);
      assert.equal(report.pendingTasks, 1);
      assert.equal(report.pendingResources, 0);
      assert.deepEqual(await f.registry.list(), []);
      gate.resolve(f.fields);
      await rejection;
      assert.equal(f.calls.read, 0);
      assert.equal(f.calls.update, 0);
    });
  }
});

test("cancelled read never releases values and cancelled accepted update stays tracked", async (t) => {
  for (const operation of ["read", "patch"] as const) {
    await t.test(operation, async (child) => {
      const f = fixture(child);
      const started = deferred();
      const gate = deferred();
      f.adapter.getValues = async (signal) => {
        started.resolve(); await gate.promise;
        assert.equal(signal.aborted, true);
        return { name: "private-value" };
      };
      f.adapter.setValues = async (_patch, signal) => {
        started.resolve(); await gate.promise;
        assert.equal(signal.aborted, true);
      };
      f.register();
      const pending = operation === "read" ? f.registry.read("plugin") : f.registry.patch("plugin", { name: "value" });
      const rejection = assert.rejects(pending, isError("unavailable"));
      await started.promise;
      const report = await f.scope.drain(5);
      assert.equal(report.pendingTasks, 1);
      assert.equal(report.timedOut, true);
      gate.resolve();
      await rejection;
    });
  }
});

test("disposer is idempotent and old pending reads cannot target a replacement slot", async (t) => {
  const f = fixture(t);
  const gate = deferred<Record<string, unknown>>();
  const started = deferred();
  f.adapter.getValues = () => { started.resolve(); return gate.promise; };
  const dispose = f.register();
  const pending = f.registry.read("plugin");
  const rejected = assert.rejects(pending, isError("unavailable"));
  await started.promise;
  const first = dispose();
  assert.equal(dispose(), first);
  await first;
  const freshScope = new ResourceScope();
  f.registry.register("plugin", { title: "Replacement", getSchema: () => f.fields,
    getValues: () => ({ name: "fresh" }), setValues() {} }, freshScope);
  gate.resolve({ name: "private-value" });
  await rejected;
  await dispose();
  await f.scope.drain();
  assert.deepEqual((await f.registry.read("plugin")).values, { name: "fresh" });
  assert.equal((await freshScope.drain()).completed, true);
});

test("missing, cancelled and disposed registrations reject all calls and duplicate slots fail", async (t) => {
  const f = fixture(t);
  f.register();
  assert.throws(() => f.register(), isError("duplicate"));
  for (const id of ["missing", "__proto__"]) {
    await assert.rejects(f.registry.schema(id), isError("unavailable"));
    await assert.rejects(f.registry.read(id), isError("unavailable"));
    await assert.rejects(f.registry.patch(id, {}), isError("unavailable"));
  }
  f.scope.abort(new Error("private-value"));
  assert.throws(() => f.register(), isError("unavailable"));
  await assert.rejects(f.registry.read("plugin"), isError("unavailable"));
  await f.scope.drain();
  await assert.rejects(f.registry.patch("plugin", {}), isError("unavailable"));
});

test("invalid adapters fail registration without callbacks or resources", async (t) => {
  const f = fixture(t);
  let executed = 0;
  const getterAdapter = { ...f.adapter };
  Object.defineProperty(getterAdapter, "getSchema", { get() { executed += 1; return () => []; } });
  for (const adapter of [null, {}, { ...f.adapter, title: 1 }, { ...f.adapter, getValues: undefined }, getterAdapter]) {
    assert.throws(() => f.registry.register("plugin", adapter as SettingsAdapter, f.scope), isError("invalid_adapter"));
  }
  assert.equal(executed, 0);
  assert.equal(f.scope.snapshot().pendingResources, 0);
  assert.deepEqual(f.calls, { schema: 0, read: 0, update: 0 });
});

test("boundary exceptions and modified error messages never expose raw private values", async (t) => {
  const f = fixture(t);
  const hostile = new Proxy({}, { getPrototypeOf() { throw new Error("private-value"); } });
  assert.throws(() => f.registry.register("plugin", hostile as SettingsAdapter, f.scope), isError("invalid_adapter"));
  const error = new SettingsError("invalid_patch");
  error.message = "private-value";
  const modified = new Proxy({}, { getPrototypeOf() { throw error; } });
  f.register();
  await assert.rejects(f.registry.patch("plugin", hostile), isError("adapter_failed"));
  await assert.rejects(f.registry.patch("plugin", modified), isError("invalid_patch"));
  assert.equal(f.calls.update, 0);
});

test("schema array accessors are rejected without executing schema entries", async (t) => {
  const f = fixture(t);
  let executed = 0;
  const fields = Array(1);
  Object.defineProperty(fields, "0", { get() { executed += 1; return f.fields[0]; } });
  f.adapter.getSchema = () => fields;
  f.register();
  await assert.rejects(f.registry.schema("plugin"), isError("invalid_schema"));
  assert.equal(executed, 0);
});

test("list tracks every slot and returns detached metadata without adapter methods", async (t) => {
  const f = fixture(t);
  f.register();
  const secondScope = new ResourceScope();
  f.registry.register("second", { ...f.adapter, id: undefined, title: "Second" }, secondScope);
  const listing = f.registry.list();
  assert.equal(f.scope.snapshot().pendingTasks, 1);
  assert.equal(secondScope.snapshot().pendingTasks, 1);
  const result = await listing;
  assert.equal(result[1].id, "second");
  assert.equal(Object.hasOwn(result[0], "getValues"), false);
  result[0].title = "changed";
  assert.equal((await f.registry.list())[0].title, "Settings");
  await secondScope.drain();
});

test("50 settings cycles leave no listeners, slots, tasks, resources or timers", async (t) => {
  const registry = new SettingsRegistry();
  const setTimer = t.mock.method(globalThis, "setTimeout");
  let writes = 0;
  for (let cycle = 0; cycle < 50; cycle += 1) {
    const scope = new ResourceScope();
    const dispose = registry.register("plugin", { title: "Settings",
      getSchema: () => [{ key: "enabled", label: "Enabled", type: "boolean" }],
      getValues: () => ({ enabled: false }), setValues: () => { writes += 1; } }, scope);
    await registry.list();
    await registry.schema("plugin");
    await registry.read("plugin");
    await registry.patch("plugin", { enabled: true });
    await dispose();
    assert.equal((await scope.drain()).completed, true);
    assert.equal(scope.snapshot().pendingTasks, 0);
    assert.equal(scope.snapshot().pendingResources, 0);
    assert.equal(getEventListeners(scope.signal, "abort").length, 0);
    assert.deepEqual(await registry.list(), []);
  }
  assert.equal(writes, 50);
  assert.equal(setTimer.mock.callCount(), 0);
});

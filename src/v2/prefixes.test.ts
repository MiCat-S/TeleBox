import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { parse } from "dotenv";
import { PrefixEnvStore, prefixesFromEnv, updatePrefixEnv } from "./prefixes";

const SECRET = "prefix-secret-fixture-981";
const signal = () => new AbortController().signal;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t: TestContext, content?: string | Buffer) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "telebox-v2-prefix-env-")));
  const file = path.join(root, ".env");
  if (content !== undefined) await fs.writeFile(file, content, { mode: 0o600 });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, file, store: new PrefixEnvStore(file), read: () => fs.readFile(file, "utf8") };
}

test("environment mapping retains legacy defaults, development override and explicit order", () => {
  assert.deepEqual(prefixesFromEnv({}), [".", "。", "$"]);
  assert.deepEqual(prefixesFromEnv({ TB_PREFIX: " \r\n\t", NODE_ENV: "production" }), [".", "。", "$"]);
  assert.deepEqual(prefixesFromEnv({ NODE_ENV: "development" }), ["!", "！"]);
  assert.deepEqual(prefixesFromEnv({ TB_PREFIX: "", NODE_ENV: "development" }), ["!", "！"]);
  assert.deepEqual(prefixesFromEnv({ TB_PREFIX: " ! \t🙂\r\n! ", NODE_ENV: "development" }), ["!", "🙂", "!"]);
  const first = prefixesFromEnv({});
  first.push("mutated");
  assert.deepEqual(prefixesFromEnv({}), [".", "。", "$"]);
});

const documents = {
  empty: "",
  comments: `# header\nTOKEN=${SECRET} # tail\nUNKNOWN=unchanged`,
  crlf: `\uFEFF# header\r\nexport TB_PREFIX = '.' # retain\r\nTOKEN=${SECRET}\r\n`,
  duplicates: `TB_PREFIX=.\nexport TB_PREFIX='!'\nTB_PREFIX: old\n`,
  multiline: `TOKEN="first\nTB_PREFIX=not-a-key\n${SECRET}"\nexport TB_PREFIX="old\nvalue" # retain\nOTHER='x\ny'\n`,
  quoted: "A='a\\n'\nB=\"b\\n\\r\"\nC=`both'\"quotes`\nTB_PREFIX='old\\value'\n",
  unknown: `export unknown.field-name: "${SECRET}"\nINVALID LINE\nOTHER=\n`,
  carriage: `TOKEN=${SECRET}\rTB_PREFIX=old\r`,
};

for (const [name, content] of Object.entries(documents)) {
  test(`dotenv edit preserves every original byte and other parsed fields: ${name}`, () => {
    const next = updatePrefixEnv(content, "! 🙂 <&>");
    assert.ok(next.startsWith(content));
    const before = parse(content);
    const after = parse(next);
    assert.equal(after.TB_PREFIX, "! 🙂 <&>");
    delete before.TB_PREFIX;
    delete after.TB_PREFIX;
    assert.deepEqual(after, before);
    assert.equal(updatePrefixEnv(next, "! 🙂 <&>"), next);
  });
}

for (const value of ["a'b", 'a"b', "a`b", "\\n \\r \\\\", "line\nbreak", "both'\"quotes", "#hash = :", "trail\\"]) {
  test(`dotenv literal round-trip ${JSON.stringify(value)}`, () => {
    assert.equal(parse(updatePrefixEnv("TOKEN=retained\n", value)).TB_PREFIX, value);
  });
}

test("unsafe dotenv representations fail with a fixed error", () => {
  for (const value of ["'\"`#\n", "\0", "\ud800"]) {
    assert.throws(() => updatePrefixEnv(`TOKEN=${SECRET}\n`, value), error => {
      assert.equal((error as Error).message, "Prefix environment persistence failed safely");
      return true;
    });
  }
  assert.throws(() => updatePrefixEnv("KEY=\0", "."));
  // Closing an existing unfinished quote would change TOKEN's dotenv value.
  const content = `TOKEN='${SECRET}\n`;
  const updated = updatePrefixEnv(content, "!");
  assert.equal(parse(updated).TOKEN, parse(content).TOKEN);
});

test("store construction is lazy and requires an explicit absolute path", async t => {
  const f = await fixture(t);
  assert.throws(() => new PrefixEnvStore(".env"));
  assert.deepEqual(await fs.readdir(f.root), []);
  await f.store.persist(["!", "🙂"], signal());
  assert.equal(parse(await f.read()).TB_PREFIX, "! 🙂");
  assert.equal((await fs.stat(f.file)).mode & 0o777, 0o600);
  assert.deepEqual(await fs.readdir(f.root), [".env"]);
});

test("atomic store preserves source content, CRLF and existing permission bits", async t => {
  const content = documents.crlf + documents.multiline;
  const f = await fixture(t, content);
  await fs.chmod(f.file, 0o640);
  await f.store.persist(["\\n", "'\"", "<&"], signal());
  const result = await f.read();
  assert.ok(result.startsWith(content));
  assert.equal(parse(result).TB_PREFIX, "\\n '\" <&");
  assert.ok(result.endsWith("\r\n"));
  assert.equal((await fs.stat(f.file)).mode & 0o777, 0o640);
  assert.deepEqual(await fs.readdir(f.root), [".env"]);
});

test("read-only files fail before replacement and retain their contents", async t => {
  const f = await fixture(t, `TOKEN=${SECRET}\n`);
  await fs.chmod(f.file, 0o400);
  await assert.rejects(f.store.persist(["!"], signal()), /failed safely/);
  assert.equal(await f.read(), `TOKEN=${SECRET}\n`);
  assert.equal((await fs.stat(f.file)).mode & 0o777, 0o400);
  assert.deepEqual(await fs.readdir(f.root), [".env"]);
});

test("special mode bits are rejected instead of silently changing permissions", async t => {
  const f = await fixture(t, `TOKEN=${SECRET}\n`);
  await fs.chmod(f.file, 0o1600);
  await assert.rejects(f.store.persist(["!"], signal()), /failed safely/);
  assert.equal(await f.read(), `TOKEN=${SECRET}\n`);
  assert.equal((await fs.stat(f.file)).mode & 0o7777, 0o1600);
});

test("symlink, hardlink and directory targets are rejected", async t => {
  const f = await fixture(t);
  const original = path.join(f.root, "original");
  await fs.writeFile(original, SECRET);
  await fs.symlink(original, f.file);
  await assert.rejects(f.store.persist(["!"], signal()));
  assert.equal((await fs.lstat(f.file)).isSymbolicLink(), true);
  await fs.unlink(f.file);
  await fs.link(original, f.file);
  await assert.rejects(f.store.persist(["!"], signal()));
  await fs.unlink(f.file);
  await fs.mkdir(f.file);
  await assert.rejects(f.store.persist(["!"], signal()));
  assert.equal(await fs.readFile(original, "utf8"), SECRET);
});

test("symlink parents and missing parents do not create or modify files", async t => {
  const f = await fixture(t, SECRET);
  await fs.symlink(f.root, path.join(f.root, "link"));
  await assert.rejects(new PrefixEnvStore(path.join(f.root, "link", ".env")).persist(["!"], signal()));
  await assert.rejects(new PrefixEnvStore(path.join(f.root, "missing", ".env")).persist(["!"], signal()));
  assert.equal(await f.read(), SECRET);
  assert.deepEqual((await fs.readdir(f.root)).sort(), [".env", "link"]);
});

test("invalid UTF-8 and NUL content is never rewritten", async t => {
  for (const bytes of [Buffer.from([0xff, 0xfe, 0x61]), Buffer.from("TOKEN=\0")]) {
    const f = await fixture(t, bytes);
    await assert.rejects(f.store.persist(["!"], signal()), /failed safely/);
    assert.deepEqual(await fs.readFile(f.file), bytes);
  }
});

test("invalid prefix lists cannot write an environment file", async t => {
  const f = await fixture(t, SECRET);
  for (const prefixes of [[], [""], ["two words"], ["line\nbreak"], ["\0"]]) {
    await assert.rejects(f.store.persist(prefixes, signal()));
    assert.equal(await f.read(), SECRET);
  }
});

test("50 queued writes across separate store instances settle in order", async t => {
  const f = await fixture(t, `TOKEN=${SECRET}\n`);
  await Promise.all(Array.from({ length: 50 }, (_, index) =>
    new PrefixEnvStore(f.file).persist([`!${index}`], signal())));
  assert.equal(parse(await f.read()).TB_PREFIX, "!49");
  assert.equal(parse(await f.read()).TOKEN, SECRET);
  assert.deepEqual(await fs.readdir(f.root), [".env"]);
});

test("already cancelled writes leave the file untouched and do not poison the queue", async t => {
  const f = await fixture(t, SECRET);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(f.store.persist(["!"], controller.signal), { name: "AbortError" });
  assert.equal(await f.read(), SECRET);
  await f.store.persist(["?"], signal());
  assert.equal(parse(await f.read()).TB_PREFIX, "?");
});

test("rename failures redact error details and clean the temporary file", async t => {
  const f = await fixture(t, `TOKEN=${SECRET}\n`);
  const rename = t.mock.method(fs, "rename", async () => { throw new Error(SECRET); });
  await assert.rejects(f.store.persist(["!"], signal()), { message: "Prefix environment persistence failed safely" });
  assert.equal(await f.read(), `TOKEN=${SECRET}\n`);
  assert.deepEqual(await fs.readdir(f.root), [".env"]);
  rename.mock.restore();
  await f.store.persist(["?"], signal());
});

test("cancellation before commit preserves the original and cleans partial writes", async t => {
  const f = await fixture(t, `TOKEN=${SECRET}\n`);
  const controller = new AbortController();
  const originalOpen = fs.open;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    if (String(args[0]).endsWith(".tmp")) {
      const originalSync = handle.sync.bind(handle);
      t.mock.method(handle, "sync", async () => { await originalSync(); controller.abort(); });
    }
    return handle;
  });
  await assert.rejects(f.store.persist(["!"], controller.signal), { name: "AbortError" });
  assert.equal(await f.read(), `TOKEN=${SECRET}\n`);
  assert.deepEqual(await fs.readdir(f.root), [".env"]);
});

test("submitted rename retains ownership until actual settlement even after cancellation", async t => {
  const f = await fixture(t, `TOKEN=${SECRET}\n`);
  const entered = deferred();
  const release = deferred();
  const controller = new AbortController();
  const originalRename = fs.rename;
  let count = 0;
  t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    count += 1;
    if (count === 1) { entered.resolve(); await release.promise; }
    return originalRename(...args);
  });
  let settled = false;
  const first = f.store.persist(["!"], controller.signal).then(() => { settled = true; });
  await entered.promise;
  controller.abort();
  const queuedAbort = new AbortController();
  const cancelled = new PrefixEnvStore(f.file).persist(["skipped"], queuedAbort.signal);
  const rejected = assert.rejects(cancelled, { name: "AbortError" });
  queuedAbort.abort();
  const last = f.store.persist(["?"], signal());
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    assert.equal(count, 1);
    assert.equal(await f.read(), `TOKEN=${SECRET}\n`);
  } finally { release.resolve(); }
  await Promise.all([first, rejected, last]);
  assert.equal(count, 2);
  assert.equal(parse(await f.read()).TB_PREFIX, "?");
  assert.deepEqual(await fs.readdir(f.root), [".env"]);
});

test("external edits detected before commit are preserved", async t => {
  const f = await fixture(t, `TOKEN=${SECRET}\n`);
  const originalOpen = fs.open;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    if (String(args[0]).endsWith(".tmp")) {
      const originalSync = handle.sync.bind(handle);
      t.mock.method(handle, "sync", async () => {
        await originalSync();
        await fs.writeFile(f.file, "OTHER=external\n");
      });
    }
    return handle;
  });
  await assert.rejects(f.store.persist(["!"], signal()), /failed safely/);
  assert.equal(await f.read(), "OTHER=external\n");
  assert.deepEqual(await fs.readdir(f.root), [".env"]);
});

test("1000 changes replace the managed suffix with bounded length and preserve user assignments", () => {
  const original = documents.multiline + documents.duplicates + documents.quoted;
  let content = original;
  let maximum = 0;
  for (let index = 0; index < 1000; index += 1) {
    const value = `!${String(index).padStart(4, "0")}`;
    content = updatePrefixEnv(content, value);
    maximum = Math.max(maximum, content.length);
    assert.ok(content.startsWith(original));
    assert.equal(parse(content).TB_PREFIX, value);
    assert.equal(content.split("# telebox-prefix:v2 ").length, 2);
  }
  assert.equal(content.length, maximum);
  assert.ok(maximum < original.length + 200);
  const before = parse(original);
  const after = parse(content);
  delete before.TB_PREFIX;
  delete after.TB_PREFIX;
  assert.deepEqual(after, before);
});

test("100 disk updates retain a single bounded block and all original bytes", async t => {
  const f = await fixture(t, documents.multiline + documents.duplicates);
  const original = await f.read();
  for (let index = 0; index < 100; index += 1) {
    await new PrefixEnvStore(f.file).persist([`!${index}`], signal());
    const content = await f.read();
    assert.ok(content.startsWith(original));
    assert.ok(content.length < original.length + 200);
    assert.equal(parse(content).TB_PREFIX, `!${index}`);
  }
});

test("modified or malformed management blocks fail instead of consuming user content", () => {
  const content = updatePrefixEnv(`TOKEN=${SECRET}\n`, "!");
  for (const changed of [
    content.replace("TB_PREFIX='!'", "TB_PREFIX='?'"),
    content.replace(/v2 \d+/u, "v2 999999999999999999999"),
    content.replace(/v2 \d+/u, "v2 1"),
    content.replace("# telebox-prefix:end\n", ""),
    content.replace("# telebox-prefix:end", "# user-edited-end"),
    content + updatePrefixEnv("", "second-block"),
    "# telebox-prefix:v1 malformed\nTB_PREFIX=original\n",
    'TOKEN="line\n# telebox-prefix:v1 quoted\nend"\n',
  ]) assert.throws(() => updatePrefixEnv(changed, "next"), /failed safely/);
});

test("refused managed-block edits leave the actual file byte-identical", async t => {
  const content = updatePrefixEnv(`TOKEN=${SECRET}\n`, "!").replace("TB_PREFIX='!'", "TB_PREFIX='changed'") + "USER_FIELD=retain\n";
  const f = await fixture(t, content);
  await assert.rejects(f.store.persist(["?"], signal()), /failed safely/);
  assert.equal(await f.read(), content);
  assert.deepEqual(await fs.readdir(f.root), [".env"]);
});

function assertOtherFieldsUnchanged(before: string, after: string): void {
  const left = parse(before);
  const right = parse(after);
  delete left.TB_PREFIX;
  delete right.TB_PREFIX;
  assert.deepEqual(right, left);
}

test("editing fields before the managed block preserves the edits and permits further updates", () => {
  const original = `# header\nAPI_KEY=${SECRET}\nTB_PREFIX='user-original'\n`;
  const initial = updatePrefixEnv(original, "!");
  const changedBase = original.replace(SECRET, "user-edited-key") + 'MODEL="new model"\n';
  const edited = changedBase + initial.slice(original.length);
  const next = updatePrefixEnv(edited, "?");
  assert.ok(next.startsWith(changedBase));
  assert.equal(parse(next).TB_PREFIX, "?");
  assertOtherFieldsUnchanged(edited, next);
  assert.equal(next.split("# telebox-prefix:v2 ").length, 2);
});

for (const tail of [
  'API_KEY="new-key"\nMODEL=model-name\n',
  'API_KEY="line one\nline two"\nexport TB_PREFIX="user override"\nUNKNOWN=retain',
  "TB_PREFIX='?'\n# user comment\n",
  "export TB_PREFIX='override-1'\nTB_PREFIX: override-2\n",
]) {
  test(`appended user fields remain byte-identical when moving the managed block to EOF: ${JSON.stringify(tail)}`, () => {
    const original = documents.multiline + documents.duplicates;
    const changed = updatePrefixEnv(original, "!") + tail;
    const next = updatePrefixEnv(changed, "?");
    assert.ok(next.startsWith(original + tail));
    assert.equal(parse(next).TB_PREFIX, "?");
    assertOtherFieldsUnchanged(changed, next);
    assert.equal(next.split("# telebox-prefix:v2 ").length, 2);
    assert.ok(next.endsWith("# telebox-prefix:end\n"));
    assert.equal(updatePrefixEnv(next, "?"), next);
  });
}

test("CRLF and multiline managed assignments are exactly delimited before appended fields", () => {
  const original = documents.crlf;
  const tail = 'EXTRA="line one\r\nline two"\r\nexport TB_PREFIX=override\r\n';
  const initial = updatePrefixEnv(original, "line\nbreak");
  const next = updatePrefixEnv(initial + tail, "🙂!");
  assert.ok(next.startsWith(original + tail));
  assertOtherFieldsUnchanged(initial + tail, next);
  assert.equal(parse(next).TB_PREFIX, "🙂!");
  assert.ok(next.endsWith("# telebox-prefix:end\r\n"));
});

test("1000 updates after user edits and appended overrides keep length bounded", () => {
  const original = documents.multiline;
  const changedBase = original.replace(SECRET, "changed-secret");
  const tail = 'API_URL="fixture://local"\nexport TB_PREFIX=manual\n';
  let content = updatePrefixEnv(original, "!").replace(SECRET, "changed-secret") + tail;
  const userContent = changedBase + tail;
  for (let index = 0; index < 1000; index += 1) {
    const next = updatePrefixEnv(content, `!${String(index).padStart(4, "0")}`);
    assert.ok(next.startsWith(userContent));
    assertOtherFieldsUnchanged(content, next);
    assert.ok(next.length < userContent.length + 200);
    assert.equal(next.split("# telebox-prefix:v2 ").length, 2);
    content = next;
  }
  assert.equal(parse(content).TB_PREFIX, "!0999");
});

test("disk persistence accepts daily config edits and appended TB_PREFIX overrides", async t => {
  const original = documents.multiline + documents.duplicates;
  const f = await fixture(t, original);
  await f.store.persist(["!"], signal());
  const changedBase = original.replace(SECRET, "changed-key");
  const tail = 'API_KEY="new key"\nexport TB_PREFIX="manual override"\n';
  const edited = (await f.read()).replace(SECRET, "changed-key") + tail;
  await fs.writeFile(f.file, edited);
  for (let index = 0; index < 100; index += 1) {
    await new PrefixEnvStore(f.file).persist([`?${index}`], signal());
    const next = await f.read();
    assert.ok(next.startsWith(changedBase + tail));
    assertOtherFieldsUnchanged(edited, next);
    assert.equal(parse(next).TB_PREFIX, `?${index}`);
    assert.ok(next.length < changedBase.length + tail.length + 200);
  }
  assert.deepEqual(await fs.readdir(f.root), [".env"]);
});

test("a valid block quoted inside a user value is not removed even if another assignment shadows it", () => {
  const block = updatePrefixEnv("", "!");
  const content = `TOKEN="before\n${block}after"\nTOKEN=shadowing-value\n`;
  assert.throws(() => updatePrefixEnv(content, "?"), /failed safely/);
});

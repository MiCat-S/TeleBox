const assert = require("node:assert/strict");
const test = require("node:test");
const { createRequire } = require("node:module");
const qs = require("qs");

test("qs enforces comma-separated array limits for bracket and plain keys", () => {
  const options = { comma: true, arrayLimit: 3, throwOnLimitExceeded: true };
  for (const query of ["a[]=1,2,3,4", "a=1,2,3,4"]) {
    assert.throws(() => qs.parse(query, options), RangeError);
  }
});

test("qs safely round-trips non-callable constructor.isBuffer input", () => {
  const query = "x%5Bconstructor%5D%5BisBuffer%5D=y";
  for (const options of [{ plainObjects: true }, { allowPrototypes: true }]) {
    const parsed = qs.parse(query, options);
    assert.doesNotThrow(() => qs.stringify(parsed));
  }
});

test("qs preserves normal nested form data and Buffer serialization", () => {
  const value = { user: { name: "Cat" }, tags: ["one", "two"] };
  assert.deepEqual(qs.parse(qs.stringify(value)), value);
  assert.equal(qs.stringify({ data: Buffer.from("hello") }), "data=hello");
});

test("Express and body-parser resolve the same locked qs package", () => {
  const expressRequire = createRequire(require.resolve("express"));
  const bodyParserRequire = createRequire(expressRequire.resolve("body-parser"));
  assert.equal(expressRequire.resolve("qs"), require.resolve("qs"));
  assert.equal(bodyParserRequire.resolve("qs"), require.resolve("qs"));
  assert.equal(
    require("qs/package.json").version,
    require("../package-lock.json").packages["node_modules/qs"].version,
  );
});

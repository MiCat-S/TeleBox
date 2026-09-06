const fs = require("node:fs");
const path = require("node:path");
const {loadSource} = require("./source-harness.cjs");
const Database = require("../node_modules/better-sqlite3");

const directory = process.argv[2];
if (!directory || !fs.statSync(directory).isDirectory()) throw Error("A test directory is required");
const helper = {createDirectoryInAssets: () => {throw Error("Live assets access forbidden");}};
const files = [];
for (const [name, relative, exported] of [
  ["alias", "src/utils/aliasDB.ts", "AliasDB"],
  ["sudo", "src/utils/sudoDB.ts", "SudoDB"],
  ["sure", "src/utils/sureDB.ts", "SureDB"],
  ["sendlog", "src/utils/sendLogDB.ts", "SendLogDB"],
  ["leech", "src/utils/leech/leechDB.ts", "LeechDB"],
]) {
  const file = path.join(directory, `${name}.db`);
  if (fs.existsSync(file)) throw Error("Fixture output already exists");
  const Class = loadSource(relative, {
    "better-sqlite3": Database, path,
    "./pathHelpers": helper, "@utils/pathHelpers": helper,
    "./json": {safeJsonStringify: JSON.stringify},
  })[exported];
  const instance = new Class(file);
  if (name === "alias") instance.set("go now", "ping dc1");
  if (name === "sudo" || name === "sure") {
    instance.add(101, "synthetic user");
    instance.addChat(202, "synthetic chat");
  }
  if (name === "sendlog") instance.setTarget("me");
  instance.close();
  const db = new Database(file);
  // Future/unknown fields and full-width integers must survive file migration.
  db.exec("CREATE TABLE rewrite_fixture (id INTEGER PRIMARY KEY, payload BLOB, nullable TEXT, extension_json TEXT)");
  db.prepare("INSERT INTO rewrite_fixture VALUES (?, ?, ?, ?)")
    .run(9007199254740993n, Buffer.from([0, 255, 1]), null, '{"unknown":{"keep":true}}');
  db.close();
  files.push({name, file});
}
process.stdout.write(JSON.stringify(files));

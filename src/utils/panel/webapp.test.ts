import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const appSource = fs.readFileSync(
  path.join(__dirname, "webapp", "app.js"),
  "utf8",
);
const serverSource = fs.readFileSync(
  path.join(__dirname, "httpServer.ts"),
  "utf8",
);

test("TPM update stream uses one cancellable authenticated fetch", () => {
  assert.doesNotMatch(appSource, /new EventSource\s*\(/);
  assert.match(appSource, /new AbortController\s*\(\)/);
  assert.match(appSource, /signal:\s*streamAbortController\.signal/);
  assert.match(
    appSource,
    /const closeProgress = \(\) => \{[\s\S]*?streamAbortController\.abort\(\)[\s\S]*?overlay\.remove\(\)/,
  );
  assert.match(appSource, /addEventListener\("pagehide",\s*abortOnPageHide/);
  assert.match(appSource, /removeEventListener\("pagehide",\s*abortOnPageHide/);
});

test("TPM update stream removes its server progress listener on disconnect", () => {
  assert.match(serverSource, /tpmUpdateEmitter\.on\(TPM_UPDATE_EVENT, onProgress\)/);
  assert.match(serverSource, /tpmUpdateEmitter\.off\(TPM_UPDATE_EVENT, onProgress\)/);
  assert.match(serverSource, /req\.on\("close", cleanup\)/);
});

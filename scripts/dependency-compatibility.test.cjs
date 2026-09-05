const assert = require("node:assert/strict");
const test = require("node:test");
const http = require("node:http");
const { getEventListeners, once } = require("node:events");
const axios = require("axios");
const { Api } = require("teleproto");
const bigInt = require("big-integer");
const { downloadFile } = require("teleproto/client/downloads");

test("installed upgraded packages match the lockfile", () => {
  const lock = require("../package-lock.json");
  for (const name of ["axios", "teleproto"]) {
    assert.equal(require(`${name}/package.json`).version, lock.packages[`node_modules/${name}`].version);
  }
});

test("Axios preserves JSON, headers and cancellation on a local HTTP endpoint", async () => {
  let seen;
  const server = http.createServer((request, response) => {
    if (request.url === "/wait") return;
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      seen = { headers: request.headers, body: JSON.parse(body) };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ text: "translated" }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseURL = `http://127.0.0.1:${server.address().port}`;
  const agent = new http.Agent({ keepAlive: true });
  const client = axios.create({ baseURL, proxy: false, httpAgent: agent, timeout: 2000 });
  try {
    const result = await client.post("/translate", {
      model: "test-model", reasoning_effort: "low", service_tier: "auto",
      messages: [{ role: "user", content: "Hello" }],
    }, { headers: { Authorization: "Bearer test-key", "User-Agent": "telebox-test" } });
    assert.equal(result.data.text, "translated");
    assert.equal(seen.headers.authorization, "Bearer test-key");
    assert.equal(seen.headers["user-agent"], "telebox-test");
    assert.equal(seen.body.reasoning_effort, "low");
    assert.equal(seen.body.service_tier, "auto");
    const controller = new AbortController();
    const request = client.get("/wait", { signal: controller.signal });
    controller.abort();
    await assert.rejects(request, (error) => error.code === "ERR_CANCELED");
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    await assert.rejects(client.get("/wait", { timeout: 20 }), (error) => error.code === "ECONNABORTED");
  } finally {
    agent.destroy();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Axios releases ejected interceptor entries", () => {
  const client = axios.create();
  for (let i = 0; i < 100; i++) {
    const id = client.interceptors.request.use((config) => config);
    client.interceptors.request.eject(id);
  }
  assert.equal(client.interceptors.request.handlers.length, 0);
});

function location() {
  return new Api.InputDocumentFileLocation({
    id: bigInt(1), accessHash: bigInt(2), fileReference: Buffer.alloc(0), thumbSize: "",
  });
}

function downloadClient(getFile) {
  return {
    session: { dcId: 1 },
    _media: {
      opts: { partSize: 4096, download: { maxSessions: 2, maxWindow: 4096 } },
      getFile,
    },
  };
}

test("teleproto routes all known-DC download chunks to the file DC and removes abort listeners", async () => {
  const calls = [];
  const data = Buffer.alloc(8192, 7);
  const client = downloadClient(async (dc, _location, offset, size) => {
    calls.push(dc);
    return data.subarray(offset.toJSNumber(), offset.toJSNumber() + size);
  });
  const controller = new AbortController();
  const result = await downloadFile(client, location(), {
    dcId: 4, fileSize: bigInt(data.length), signal: controller.signal,
  });
  assert.deepEqual(result, data);
  assert.deepEqual(calls, [4, 4]);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("teleproto reuses the migrated DC after the first download chunk", async () => {
  const calls = [];
  const data = Buffer.alloc(12288, 9);
  const client = downloadClient(async (dc, _location, offset, size, _signal, onMigrate) => {
    calls.push(dc);
    if (calls.length === 1) onMigrate(4);
    return data.subarray(offset.toJSNumber(), offset.toJSNumber() + size);
  });
  const result = await downloadFile(client, location(), { fileSize: bigInt(data.length) });
  assert.deepEqual(result, data);
  assert.deepEqual(calls, [1, 4, 4]);
});

test("teleproto removes forwarded abort listeners after failed downloads", async () => {
  const controller = new AbortController();
  const client = downloadClient(async () => { throw new Error("download failure"); });
  await assert.rejects(
    downloadFile(client, location(), { signal: controller.signal, requestTimeout: 5000 }),
    /download failure/,
  );
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

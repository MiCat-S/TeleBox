const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const {spawnSync} = require("node:child_process");

const root = __dirname;
const tools = path.join(root, ".tools");
const rustVersion = "1.98.1";
const tdRevision = "d1085f9cebc5a62379991ae1652673954f229c1f";

async function download(url) {
  const response = await fetch(url, {signal: AbortSignal.timeout(120000)});
  if (!response.ok) throw new Error(`Download failed: ${response.status} ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

function run(command, args, env = {}) {
  const result = spawnSync(command, args, {cwd: root, stdio: "inherit", env: {...process.env, ...env}});
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed: status=${result.status} signal=${result.signal}`);
}

async function main() {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("This bootstrap is scoped to the inspected macOS arm64 host");
  }
  const mode = process.argv[2];
  if (!["rust", "tdlib"].includes(mode)) throw new Error("Usage: node prepare-native.cjs rust|tdlib");
  fs.mkdirSync(tools, {recursive: true});
  if (mode === "rust") {
    const url = "https://static.rust-lang.org/rustup/dist/aarch64-apple-darwin/rustup-init";
    const data = await download(url);
    const expected = (await download(url + ".sha256")).toString("utf8").trim().split(/\s+/)[0];
    const sha256 = crypto.createHash("sha256").update(data).digest("hex");
    if (!/^[a-f0-9]{64}$/.test(expected) || sha256 !== expected) throw new Error("rustup checksum mismatch");
    const installer = path.join(tools, "rustup-init");
    fs.writeFileSync(installer, data, {mode: 0o700});
    console.log(JSON.stringify({url, sha256, rustVersion}));
    run(installer, ["-y", "--no-modify-path", "--profile", "minimal", "--default-toolchain", rustVersion], {
      RUSTUP_HOME: path.join(tools, "rustup"), CARGO_HOME: path.join(tools, "cargo"),
    });
  } else {
    const destination = path.join(tools, "tdlib");
    if (fs.existsSync(destination)) throw new Error("TDLib source already exists; inspect it before reusing");
    const url = `https://codeload.github.com/tdlib/td/tar.gz/${tdRevision}`;
    const archive = await download(url);
    const tarball = path.join(tools, "tdlib.tar.gz");
    fs.writeFileSync(tarball, archive);
    fs.mkdirSync(destination);
    run("tar", ["-xzf", tarball, "--strip-components=1", "-C", destination]);
    console.log(JSON.stringify({revision: tdRevision, url, sha256: crypto.createHash("sha256").update(archive).digest("hex")}));
  }
}
main().catch(error => {console.error(error); process.exitCode = 1;});

// Source-only inventory: never load plugins or inspect credentials/assets.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const cp = require("node:child_process");
const ts = require("typescript");

const core = path.resolve(__dirname, "..");
const plugins = path.resolve(core, "../TeleBox-Plugins");
const installed = ["ai", "da", "dc", "dme", "gt", "ids", "ip", "nodeseek", "rate", "sum", "yvlu"];

function inspect(file) {
  const text = fs.readFileSync(file, "utf8");
  const parsed = /\.[cm]?[jt]sx?$/.test(file);
  const ast = parsed ? ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true) : null;
  const imports = new Set();
  const constructors = new Set();
  const handlers = new Set();
  const literals = new Set();
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      imports.add(node.moduleSpecifier.text);
    }
    if (ts.isNewExpression(node)) {
      const name = node.expression.getText(ast);
      if (name.startsWith("Api.")) constructors.add(name);
    }
    if (ts.isPropertyDeclaration(node) && node.name.getText(ast) === "cmdHandlers"
      && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
      for (const p of node.initializer.properties) {
        if (p.name) handlers.add(p.name.getText(ast));
      }
    }
    if (ts.isStringLiteral(node) && /\.(json|db)$/.test(node.text)) literals.add(node.text);
    ts.forEachChild(node, visit);
  };
  if (ast) visit(ast);
  return {
    file: path.relative(path.dirname(core), file),
    sha256: crypto.createHash("sha256").update(text).digest("hex"),
    analysis: parsed ? "typescript-ast" : "hash-only",
    imports: [...imports].sort(), apiConstructors: [...constructors].sort(),
    literalCommandKeys: [...handlers].sort(), dataPathLiterals: [...literals].sort(),
  };
}

function repositoryFiles(cwd) {
  return [...new Set(cp.execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    {cwd, encoding: "utf8"}).split("\0").filter(Boolean))].sort();
}

function isSource(file) {
  return /\.(ts|tsx|js|cjs|mjs|py|sh|html|css)$/.test(file) && !/\.(test|spec)\./.test(file);
}

function coreKind(file) {
  return /^src\/plugin\/[^/]+\.ts$/.test(file) ? "builtin" : "core-support";
}

function extensionKind(file) {
  if (/^outdated\/([^/]+)\/\1\.ts$/.test(file)) return "archived-extension";
  if (/^([^/]+)\/\1\.ts$/.test(file)) return "extension";
  return "extension-support";
}

const coreFiles = repositoryFiles(core).filter(file =>
  (/^(src|scripts)\//.test(file) || file === "ecosystem.config.cjs") && isSource(file));
const pluginFiles = repositoryFiles(plugins).filter(isSource);
const catalog = JSON.parse(fs.readFileSync(path.join(plugins, "plugins.json"), "utf8"));
const sources = [
  ...coreFiles.map(file => ({...inspect(path.join(core, file)), kind: coreKind(file)})),
  ...pluginFiles.map(file => {
    const kind = extensionKind(file);
    const name = path.basename(file, ".ts");
    return {
      ...inspect(path.join(plugins, file)), kind,
      catalogued: kind === "extension" && Object.hasOwn(catalog, name),
      productionPriority: kind === "extension" && installed.includes(name),
      vendored: file.includes("/vendor/"),
    };
  }),
];
const revision = cwd => cp.execFileSync("git", ["rev-parse", "HEAD"], {cwd, encoding: "utf8"}).trim();
const report = {
  schemaVersion: 2, generatedAt: new Date().toISOString(),
  scope: "All repository modules, including unindexed and archived extensions, core services and auxiliary sources; production installation determines priority only",
  limitations: [
    "Static AST inventory, not proof of runtime behavior or exhaustive RPC coverage",
    "Computed commands, helper RPC calls and dynamically constructed paths require manual review",
    "Does not inspect credentials, session values, database contents or live server",
    "Python, shell, HTML and CSS sources are hashed but not semantically analyzed",
    "Vendored implementations are dependency inputs, not independently counted plugins",
  ],
  revisions: {core: revision(core), plugins: revision(plugins)},
  counts: {
    builtins: sources.filter(s => s.kind === "builtin").length,
    extensions: sources.filter(s => s.kind === "extension").length,
    archivedExtensions: sources.filter(s => s.kind === "archived-extension").length,
    supportFiles: sources.filter(s => s.kind.endsWith("-support")).length,
  },
  catalog: {
    entries: Object.keys(catalog).length,
    missingSources: Object.keys(catalog).filter(name => !pluginFiles.includes(`${name}/${name}.ts`)).sort(),
    unindexedSources: sources.filter(s => s.kind === "extension" && !s.catalogued).map(s => s.file),
  },
  sources,
};
if (require.main === module) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
module.exports = {inspect, report};

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const esbuild = require("../node_modules/esbuild");

const core = path.resolve(__dirname, "..");

// A closed import map prevents test code from accessing live stores or clients.
function evaluate(source, filename, imports = {}, globals = {}) {
  const mod = {exports: {}};
  const code = esbuild.transformSync(source, {loader: "ts", format: "cjs", target: "es2022"}).code;
  vm.runInNewContext(code, {
    module: mod, exports: mod.exports, Buffer, URLSearchParams,
    process: {env: {}},
    require: name => {
      if (!Object.hasOwn(imports, name)) throw new Error(`Unmocked import ${name} in ${filename}`);
      return imports[name];
    },
    ...globals,
  }, {filename, timeout: 1000});
  return mod.exports;
}

function loadSource(relative, imports = {}, globals = {}) {
  const filename = path.join(core, relative);
  return evaluate(fs.readFileSync(filename, "utf8"), filename, imports, globals);
}

function loadFunctions(relative, names, globals = {}) {
  const filename = path.join(core, relative);
  const source = fs.readFileSync(filename, "utf8");
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const functions = names.map(name => {
    const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
    if (!node) throw new Error(`Function ${name} missing from ${relative}`);
    return node.getText(ast);
  });
  return evaluate(`${functions.join("\n")}\nmodule.exports = { ${names.join(", ")} };`, filename, {}, globals);
}

function loadBindings(relative, names, globals = {}) {
  const filename = path.join(core, relative);
  const source = fs.readFileSync(filename, 'utf8');
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const declarations = names.map(name => {
    for (const statement of ast.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      const declaration = statement.declarationList.declarations.find(d => ts.isIdentifier(d.name) && d.name.text === name);
      if (declaration) return `const ${declaration.getText(ast)};`;
    }
    throw new Error(`Binding ${name} missing from ${relative}`);
  });
  return evaluate(`${declarations.join('\n')}\nmodule.exports = { ${names.join(', ')} };`, filename, {}, globals);
}

module.exports = {loadSource, loadFunctions, loadBindings};

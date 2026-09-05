'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {report} = require('./inventory.cjs');
const registry = require('./migrations.json');
const workspace = path.resolve(__dirname, '../..');
const entries = report.sources.filter(source => !source.kind.endsWith('-support'));
const names = new Set(entries.map(entry => entry.file));
const statuses = new Set(['planned', 'in-progress', 'offline-verified', 'live-verified', 'accepted']);

function migrationStatus() {
  if (registry.schemaVersion !== 1) throw new Error('Unsupported migration registry');
  for (const [name, item] of Object.entries(registry.entries)) {
    if (!names.has(name)) throw new Error(`Migration entry is outside the inventory: ${name}`);
    if (!statuses.has(item.status)) throw new Error(`Unknown migration status: ${name}`);
    for (const file of [item.implementation, ...item.tests]) {
      if (typeof file !== 'string' || path.isAbsolute(file) || file.split('/').includes('..') ||
          !fs.statSync(path.join(workspace, file)).isFile()) throw new Error(`Missing migration evidence: ${name}`);
    }
    if (item.status === 'accepted' && item.pending.length) throw new Error(`Accepted migration still has pending work: ${name}`);
  }
  const modules = entries.map(source => ({
    source: source.file, sha256: source.sha256, kind: source.kind,
    productionPriority: source.productionPriority,
    status: 'planned', implementation: null, tests: [], coverage: [], pending: ['implementation and parity verification'],
    ...registry.entries[source.file],
  }));
  return {
    schemaVersion: 1, baseline: registry.baseline, observedRevisions: report.revisions,
    scope: {entrypoints: modules.length, builtins: report.counts.builtins, extensions: report.counts.extensions, archived: report.counts.archivedExtensions},
    counts: Object.fromEntries([...statuses].map(status => [status, modules.filter(item => item.status === status).length])),
    limitation: 'Registry tracks evidence and pending acceptance; file presence is not proof that a test or external service passed.',
    modules,
  };
}

if (require.main === module) process.stdout.write(JSON.stringify(migrationStatus(), null, 2) + '\n');
module.exports = {migrationStatus};

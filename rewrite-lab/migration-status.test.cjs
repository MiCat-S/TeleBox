'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {report} = require('./inventory.cjs');
const {migrationStatus} = require('./migration-status.cjs');

test('every inventoried module appears exactly once in the migration matrix', () => {
  const status = migrationStatus();
  const expected = report.sources.filter(source => !source.kind.endsWith('-support')).map(source => source.file).sort();
  assert.deepEqual(status.modules.map(module => module.source).sort(), expected);
  assert.equal(status.scope.entrypoints, status.scope.builtins + status.scope.extensions + status.scope.archived);
  assert.equal(status.modules.filter(module => module.productionPriority).length, 11);
  assert.equal(Object.values(status.counts).reduce((sum, count) => sum + count, 0), expected.length);
});

test('offline evidence does not claim live or resource acceptance', () => {
  const status = migrationStatus();
  const gt = status.modules.find(module => module.source === 'TeleBox-Plugins/gt/gt.ts');
  assert.equal(gt.status, 'offline-verified');
  assert.ok(gt.tests.length);
  assert.ok(gt.pending.some(item => item.includes('ai.translate')));
  assert.ok(gt.pending.some(item => item.includes('resource')));
  assert.equal(status.modules.find(module => module.source === 'TeleBox-Plugins/outdated/q/q.ts').status, 'planned');
});

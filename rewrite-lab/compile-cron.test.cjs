const test = require('node:test');
const assert = require('node:assert/strict');
const { compileCron } = require('./compile-cron.cjs');

test('compiled schedule preserves source and normalizes complete fields', () => {
  const source = '0 0 15 * 0-6';
  const result = compileCron(source, 'UTC');
  assert.equal(result.expression, source);
  assert.equal(result.zone, 'UTC');
  assert.equal(result.format, 1);
  assert.match(result.parser, /^node-cron\//);
  assert.equal(result.canonical, '0 0 0 15 * *');
  assert.equal(compileCron('0 0 * * 5-7', 'UTC').canonical, '0 0 0 * * 0,5,6');
  assert.equal(compileCron('0 0 * * 1-7/2', 'UTC').canonical, '0 0 0 * * 0,1,3,5');
  assert.equal(compileCron('0 0 1-31 * mon', 'UTC').canonical, '0 0 0 * * 1');
});

test('compilation requires an explicit valid timezone and cron', () => {
  assert.throws(() => compileCron('* * * * *'));
  assert.throws(() => compileCron('* * * * *', 'No/Such_Zone'));
  assert.throws(() => compileCron('*/0 * * * *', 'UTC'));
});

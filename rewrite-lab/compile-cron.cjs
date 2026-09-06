const { CronTime } = require('../node_modules/cron');
const { version } = require('../node_modules/cron/package.json');

// Run during migration using the baseline parser, not in the candidate service.
function compileCron(expression, zone) {
  if (typeof expression !== 'string' || typeof zone !== 'string' || !zone) {
    throw new TypeError('Explicit expression and timezone are required');
  }
  const parsed = new CronTime(expression, zone);
  const units = [
    ['second', 0, 59], ['minute', 0, 59], ['hour', 0, 23],
    ['dayOfMonth', 1, 31], ['month', 1, 12], ['dayOfWeek', 0, 6],
  ];
  const fields = units.map(([unit, low, high]) => {
    const values = Object.keys(parsed[unit]).map(Number).sort((a, b) => a - b);
    if (!values.length || values.some((n) => !Number.isInteger(n) || n < low || n > high)) {
      throw new Error(`Unexpected baseline field: ${unit}`);
    }
    return values.length === high - low + 1 ? '*' : values.join(',');
  });
  return { format: 1, parser: `node-cron/${version}`, expression, zone, canonical: fields.join(' ') };
}

module.exports = { compileCron };

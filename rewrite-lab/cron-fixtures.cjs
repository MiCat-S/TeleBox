const { CronTime } = require('../node_modules/cron');
const { compileCron } = require('./compile-cron.cjs');
const { Settings } = require('../node_modules/luxon');
const referenceTime = '2026-09-05T00:00:00Z';
// Luxon uses the current offset when resolving ambiguous wall-clock times.
// Freeze only this fixture subprocess, not the system clock or production.
Settings.now = () => Date.parse(referenceTime);
const wallOnly = process.argv.includes('--wall');

const fixtures = [
  ['nodeseek', '0 8 * * *', 'Asia/Shanghai', '2026-09-05T00:00:00Z'],
  ['sum-seconds', '*/15 * * * * *', 'Asia/Shanghai', '2026-09-05T00:00:07Z'],
  ['weekdays', '0 9 * * mon-fri', 'Asia/Shanghai', '2026-09-04T01:00:00Z'],
  ['month-day-or-weekday', '0 0 15 * mon', 'UTC', '2026-09-01T00:00:00Z'],
  ['full-week-range', '0 0 15 * 0-6', 'UTC', '2026-09-01T00:00:00Z'],
  ['sunday-seven', '0 0 * * 7', 'UTC', '2026-09-01T00:00:00Z'],
  ['sunday-range', '0 0 * * 5-7', 'UTC', '2026-09-04T00:00:00Z'],
  ['sunday-step', '0 0 * * 1-7/2', 'UTC', '2026-09-04T00:00:00Z'],
  ['full-dom-range', '0 0 1-31 * mon', 'UTC', '2026-09-01T00:00:00Z'],
  ['leap-day', '0 0 29 feb *', 'UTC', '2026-09-01T00:00:00Z'],
  ['spring-gap', '30 2 * * *', 'America/New_York', '2026-03-07T08:00:00Z'],
  ['fall-repeat', '30 1 * * *', 'America/New_York', '2026-11-01T04:00:00Z'],
  ['descriptor', '@weekly', 'UTC', '2026-09-01T00:00:00Z'],
  ['bad-step', '*/0 * * * *', 'UTC', '2026-09-01T00:00:00Z'],
  ['bad-hour', '0 24 * * *', 'UTC', '2026-09-01T00:00:00Z'],
];

if (wallOnly) fixtures.push(
  ['spring-seconds', '15 30 2 * * *', 'America/New_York', '2026-03-07T08:00:00Z'],
  ['sydney-gap', '30 2 * * *', 'Australia/Sydney', '2026-10-03T00:00:00Z'],
  ['sydney-repeat', '30 2 * * *', 'Australia/Sydney', '2026-04-04T00:00:00Z'],
  ['lord-howe-gap', '15 2 * * *', 'Australia/Lord_Howe', '2026-10-03T00:00:00Z'],
  ['lord-howe-repeat', '45 1 * * *', 'Australia/Lord_Howe', '2026-04-04T00:00:00Z'],
);

const results = fixtures.map(([name, expression, zone, start]) => {
  const row = { name, expression, zone, start, referenceTime, dates: [], error: null };
  try {
    const cron = new CronTime(expression, zone);
    row.compiled = compileCron(expression, zone);
    let cursor = new Date(start);
    for (let i = 0; i < 2; i++) {
      cursor = cron.getNextDateFrom(cursor, zone).toJSDate();
      row.dates.push(cursor.toISOString());
    }
  } catch (error) {
    row.error = error.message;
  }
  return row;
});
process.stdout.write(JSON.stringify(results));

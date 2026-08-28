const assert = require('node:assert/strict');
const test = require('node:test');
const { pacificDayKey, nextPacificMidnightMs, firstInstantOfPacificDay } = require('../gateway/pacific-time');

test('ordinary PDT day: still 27 Aug before midnight, next cut is 28 Aug 07:00Z', () => {
  const beforeMidnight = Date.parse('2026-08-28T06:30:00Z');
  assert.equal(pacificDayKey(beforeMidnight), '2026-08-27');
  assert.equal(nextPacificMidnightMs(beforeMidnight), Date.parse('2026-08-28T07:00:00Z'));

  const atMidnight = Date.parse('2026-08-28T07:00:00Z');
  assert.equal(pacificDayKey(atMidnight), '2026-08-28');
  assert.equal(nextPacificMidnightMs(atMidnight), Date.parse('2026-08-29T07:00:00Z'));
});

test('spring-forward 2026-03-08: 01:30 PST and 03:30 PDT are the same Pacific calendar day', () => {
  const beforeSkip = Date.parse('2026-03-08T09:30:00Z'); // 01:30 PST
  const afterSkip = Date.parse('2026-03-08T10:30:00Z'); // 03:30 PDT
  assert.equal(pacificDayKey(beforeSkip), '2026-03-08');
  assert.equal(pacificDayKey(afterSkip), '2026-03-08');
  assert.equal(firstInstantOfPacificDay('2026-03-08'), Date.parse('2026-03-08T08:00:00Z'));
  assert.equal(nextPacificMidnightMs(beforeSkip), Date.parse('2026-03-09T07:00:00Z'));
  assert.equal(nextPacificMidnightMs(afterSkip), Date.parse('2026-03-09T07:00:00Z'));
});

test('fall-back 2026-11-01: both overlapping 01:30 instants stay 2026-11-01', () => {
  const first0130 = Date.parse('2026-11-01T08:30:00Z'); // 01:30 PDT
  const second0130 = Date.parse('2026-11-01T09:30:00Z'); // 01:30 PST
  assert.equal(pacificDayKey(first0130), '2026-11-01');
  assert.equal(pacificDayKey(second0130), '2026-11-01');
  assert.equal(nextPacificMidnightMs(first0130), Date.parse('2026-11-02T08:00:00Z'));
  assert.equal(nextPacificMidnightMs(second0130), Date.parse('2026-11-02T08:00:00Z'));
});

test('Pacific day boundary: 23:59:59 and 00:00:00 differ by one calendar day', () => {
  const lastTick = Date.parse('2026-08-28T06:59:59Z'); // 23:59:59 PDT on 27 Aug
  const firstTick = Date.parse('2026-08-28T07:00:00Z'); // 00:00:00 PDT on 28 Aug
  assert.equal(pacificDayKey(lastTick), '2026-08-27');
  assert.equal(pacificDayKey(firstTick), '2026-08-28');
  assert.notEqual(pacificDayKey(lastTick), pacificDayKey(firstTick));
});

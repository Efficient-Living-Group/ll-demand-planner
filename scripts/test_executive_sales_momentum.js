#!/usr/bin/env node
const assert = require('assert');
const {
  plannerWeekKey,
  completedWeekKeys,
  percentageChange,
  summarizeSalesVolume
} = require('../lib/executive-sales');

const anchor = new Date('2026-07-23T12:00:00.000Z');
assert.strictEqual(plannerWeekKey(anchor), '2026-W30', 'current partial week must match the Shopify week bucket');
assert.deepStrictEqual(
  completedWeekKeys(anchor, 3),
  ['2026-W27', '2026-W28', '2026-W29'],
  'completed weeks must exclude the current partial week'
);
assert.strictEqual(percentageChange(120, 100), 20);
assert.strictEqual(percentageChange(80, 100), -20);
assert.strictEqual(percentageChange(10, 0), null, 'zero baselines must not fabricate an infinite percentage');

const salesByWeek = {
  '2026-W21': 70,
  '2026-W22': 80,
  '2026-W23': 90,
  '2026-W24': 100,
  '2026-W25': 110,
  '2026-W26': 120,
  '2026-W27': 130,
  '2026-W28': 140,
  '2026-W29': 154,
  '2026-W30': 44
};
const summary = summarizeSalesVolume(salesByWeek, anchor, 8);
assert.strictEqual(summary.completedWeeks.length, 8);
assert.strictEqual(summary.completedWeeks[0].week, '2026-W22');
assert.strictEqual(summary.latestWeek, '2026-W29');
assert.strictEqual(summary.latestWeekUnits, 154);
assert.strictEqual(summary.priorWeekUnits, 140);
assert.strictEqual(summary.changePct, 10);
assert.strictEqual(summary.average4Weeks, 125);
assert.strictEqual(summary.vs4WeekPct, 23.2);
assert.deepStrictEqual(summary.currentWeek, {
  week: '2026-W30',
  label: 'W30',
  units: 44,
  partial: true
});

console.log('Executive sales momentum tests passed.');

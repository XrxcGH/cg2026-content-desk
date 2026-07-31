import { test } from 'node:test';
import assert from 'node:assert/strict';
import { behindMinutes, medianCycleMs, projectNextStart } from './pace.ts';

const MIN = 60_000;

test('median cycle excludes breaks and glitches', () => {
  // 7, 7, 8 minute cycles with a lunch break (45m) and a double-fire (20s).
  const t0 = 1_000_000;
  const starts = [
    t0,
    t0 + 7 * MIN,
    t0 + 14 * MIN,
    t0 + 14 * MIN + 20_000,       // glitch: excluded (< 90s)
    t0 + 22 * MIN + 20_000,       // 8m cycle from the glitch entry
    t0 + 67 * MIN,                 // lunch: excluded (> 20m)
    t0 + 74 * MIN,                 // 7m
  ];
  const median = medianCycleMs(starts);
  assert.equal(median, 7 * MIN, 'median of [7, 7, 8, 7] minutes');
});

test('median is null until there are two starts worth of signal', () => {
  assert.equal(medianCycleMs([]), null);
  assert.equal(medianCycleMs([5_000_000]), null);
  assert.equal(medianCycleMs([0, 30 * MIN]), null, 'a single break is not a pace');
});

test('projection never points into the past (a stalled field walks forward)', () => {
  const last = 1_000_000;
  const cycle = 7 * MIN;
  assert.equal(projectNextStart(last, cycle, last + MIN), last + cycle, 'normal case');
  // Field stalled: 30 minutes since the last start; the estimate is "now".
  const now = last + 30 * MIN;
  assert.equal(projectNextStart(last, cycle, now), now);
  assert.equal(projectNextStart(null, cycle, now), null);
  assert.equal(projectNextStart(last, null, now), null);
});

test('behind-schedule math, both directions', () => {
  const sched = 2_000_000;
  assert.equal(behindMinutes(sched + 12 * MIN, sched), 12, 'running behind');
  assert.equal(behindMinutes(sched - 3 * MIN, sched), -3, 'ahead, which is rare but honest');
  assert.equal(behindMinutes(null, sched), null);
  assert.equal(behindMinutes(sched, null), null, 'no published times, no claim');
});

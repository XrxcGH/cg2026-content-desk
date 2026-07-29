import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clockDisplay, hubActiveAt, isLockdown, phaseAt } from './clock.ts';

test('phases follow the REBUILT timeline', () => {
  assert.equal(phaseAt(null), 'pre');
  assert.equal(phaseAt(-25), 'pre');
  assert.equal(phaseAt(-20), 'auto');
  assert.equal(phaseAt(-1), 'auto');
  assert.equal(phaseAt(0), 'transition');
  assert.equal(phaseAt(9.9), 'transition');
  assert.equal(phaseAt(10), 'shift1');
  assert.equal(phaseAt(34.9), 'shift1');
  assert.equal(phaseAt(35), 'shift2');
  assert.equal(phaseAt(60), 'shift3');
  assert.equal(phaseAt(85), 'shift4');
  assert.equal(phaseAt(110), 'endgame');
  assert.equal(phaseAt(140), 'post');
});

test('the clock counts down within each period', () => {
  assert.equal(clockDisplay(-20), '0:20');
  assert.equal(clockDisplay(-1), '0:01');
  assert.equal(clockDisplay(0), '2:20');
  assert.equal(clockDisplay(110), '0:30');
  assert.equal(clockDisplay(140), '0:00');
});

test('lockdown covers exactly the endgame', () => {
  assert.equal(isLockdown(109), false);
  assert.equal(isLockdown(110), true);
  assert.equal(isLockdown(139), true);
  assert.equal(isLockdown(140), false);
});

test('hub alternation matches Cheesy Arena, which is counterintuitive', () => {
  // Verified against Hub.isShiftActive in the 2026 source: it returns
  // !WonAuto for Shift1/Shift3 and WonAuto for Shift2/Shift4. Winning auto
  // buys the LATER shifts, not the immediate ones. Getting this backwards
  // puts the wrong alliance on the hub indicator for the whole event.
  assert.equal(hubActiveAt(20, 'red'), 'blue', 'shift 1 belongs to the auto loser');
  assert.equal(hubActiveAt(45, 'red'), 'red', 'shift 2 belongs to the auto winner');
  assert.equal(hubActiveAt(70, 'red'), 'blue', 'shift 3 belongs to the auto loser');
  assert.equal(hubActiveAt(95, 'red'), 'red', 'shift 4 belongs to the auto winner');

  // Mirrored when blue wins auto.
  assert.equal(hubActiveAt(20, 'blue'), 'red');
  assert.equal(hubActiveAt(45, 'blue'), 'blue');
});

test('both hubs are live outside the alliance shifts', () => {
  for (const c of [-10, 5, 120]) {
    assert.equal(hubActiveAt(c, 'red'), 'both', `matchClock ${c}`);
  }
  assert.equal(hubActiveAt(null, 'red'), 'none');
  assert.equal(hubActiveAt(200, 'red'), 'none');
});

test('a tied auto leaves nothing to alternate on', () => {
  assert.equal(hubActiveAt(20, null), 'both');
  assert.equal(hubActiveAt(45, null), 'both');
});

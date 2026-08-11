import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reduce } from './state.ts';
import { initialState, type DeskEvent, type DeskState } from './types.ts';

const T0 = 1_700_000_000_000;

const ev = (type: DeskEvent['type'], ts: number, payload: unknown = {}): DeskEvent => ({
  id: `t${ts}`, seq: 0, ts, matchClock: null, source: 'manual', confidence: 'authoritative',
  type, payload,
});

function started(): DeskState {
  let s = initialState();
  s = reduce(s, ev('match.loaded', T0, { id: 'q1', displayName: 'Q1', red: [], blue: [] }));
  s = reduce(s, ev('match.start', T0));
  return s;
}

test('shadow deltas attribute to the period the clock says', () => {
  let s = started();
  // 5s in: clock is -15, still auto.
  s = reduce(s, ev('score.delta', T0 + 5_000, { alliance: 'red', field: 'fuel', amount: 5 }));
  assert.equal(s.score.red.autoFuel, 5);
  assert.equal(s.score.red.teleopFuel, 0);

  // 40s in: clock is +20, teleop. Fuel and tower both split.
  s = reduce(s, ev('score.delta', T0 + 40_000, { alliance: 'red', field: 'fuel', amount: 7 }));
  s = reduce(s, ev('score.delta', T0 + 40_000, { alliance: 'red', field: 'tower', amount: 10 }));
  assert.equal(s.score.red.autoFuel, 5);
  assert.equal(s.score.red.teleopFuel, 7);
  assert.equal(s.score.red.teleopTower, 10);

  // The derived sums and total stay coherent with the parts.
  assert.equal(s.score.red.fuel, 12);
  assert.equal(s.score.red.tower, 10);
  assert.equal(s.score.red.total, 22);
});

test('realtime part snapshots settle sums, RPs, and the foul ledger', () => {
  let s = started();
  s = reduce(s, ev('score.realtime', T0 + 60_000, {
    red: { autoFuel: 4, teleopFuel: 98, autoTower: 15, teleopTower: 30, fouls: 0 },
    blue: { autoFuel: 9, teleopFuel: 80, autoTower: 0, teleopTower: 50, fouls: 12 },
  }));
  assert.equal(s.score.red.fuel, 102);
  assert.equal(s.score.red.rp.energized, true, '102 fuel crosses 100');
  assert.equal(s.score.blue.rp.traversal, true, '50 tower crosses 50');
  // Blue conceded 12 foul points. They belong to RED's total.
  assert.equal(s.score.red.total, 102 + 45 + 12);
  assert.equal(s.score.blue.total, 89 + 50);
});

test('after the buzzer the desk reads Final 0:00, never Pre-match 0:20', () => {
  let s = started();
  assert.equal(s.phase, 'auto');

  s = reduce(s, ev('match.end', T0 + 165_000));
  assert.equal(s.matchClock, null, 'clock stops');
  assert.equal(s.phase, 'post');
  assert.equal(s.clockDisplay, '0:00');
  assert.equal(s.hubActive, 'none');

  // The next match load resets the ambiguity for the new cycle.
  s = reduce(s, ev('match.loaded', T0 + 300_000, { id: 'q2', displayName: 'Q2', red: [], blue: [] }));
  assert.equal(s.phase, 'pre');
  assert.equal(s.clockDisplay, '0:20');
});
test('bonus RPs score against configured thresholds, not the shipped defaults', () => {
  let s = initialState();
  // An event that decides 100 fuel is too easy and moves the bar to 150.
  s = reduce(s, ev('game.thresholds', T0, { energizedFuel: 150 }));
  s = reduce(s, ev('score.realtime', T0 + 1, { red: { teleopFuel: 120 } }));

  assert.equal(s.score.red.fuel, 120);
  assert.equal(s.score.red.rp.energized, false,
    '120 clears the shipped default of 100 but not the configured 150');

  s = reduce(s, ev('score.delta', T0 + 2,
    { alliance: 'red', field: 'fuel', amount: 40 }));
  assert.equal(s.score.red.rp.energized, true, '160 clears 150');
});

test('changing a threshold mid-event re-scores what is already on the board', () => {
  let s = initialState();
  s = reduce(s, ev('score.realtime', T0, { blue: { teleopTower: 60 } }));
  assert.equal(s.score.blue.rp.traversal, true, 'clears the default 50');

  // A correction arrives after the numbers are already on air.
  s = reduce(s, ev('game.thresholds', T0 + 1, { traversalTower: 75 }));
  assert.equal(s.score.blue.rp.traversal, false,
    'the badge goes out at once rather than waiting for the next score packet');
  assert.equal(s.thresholds.traversalTower, 75);
  assert.equal(s.thresholds.energizedFuel, 100, 'a partial update leaves the rest alone');
});

test('a manual take holds through the match lifecycle', () => {
  let s = initialState();

  // Operator puts the arcade bumper up during a gap.
  s = reduce(s, ev('screen.change', T0, { screen: 'arcade' }));
  assert.equal(s.screen, 'arcade');
  assert.equal(s.screenHold, true);

  // Everything the field does next used to stomp it.
  s = reduce(s, ev('match.loaded', T0 + 1, { displayName: 'Q43', red: [], blue: [] }));
  assert.equal(s.screen, 'arcade', 'loading a match must not yank the screen back');
  s = reduce(s, ev('match.armed', T0 + 2));
  assert.equal(s.screen, 'arcade');
  s = reduce(s, ev('match.start', T0 + 3));
  assert.equal(s.screen, 'arcade');
  s = reduce(s, ev('match.score_posted', T0 + 4));
  assert.equal(s.screen, 'arcade');

  // The match data still landed; only the screen was left alone.
  assert.equal(s.match?.displayName, 'Q43');
  assert.equal(s.matchStartedAt, T0 + 3);
  assert.equal(s.scorePostedAt, T0 + 4);
});

test('Auto hands the screen back without changing what is on air', () => {
  let s = initialState();
  s = reduce(s, ev('screen.change', T0, { screen: 'analysis' }));
  s = reduce(s, ev('screen.change', T0 + 1, { screen: 'auto' }));

  assert.equal(s.screenHold, false, 'auto releases the hold');
  assert.equal(s.screen, 'analysis', 'and leaves what is on air alone until the next event');

  // Automatic switching resumes from here.
  s = reduce(s, ev('match.armed', T0 + 2));
  assert.equal(s.screen, 'match');
});

test('with no hold, the show still runs itself', () => {
  let s = initialState();
  s = reduce(s, ev('match.loaded', T0, { displayName: 'Q44', red: [], blue: [] }));
  assert.equal(s.screen, 'overview');
  s = reduce(s, ev('match.armed', T0 + 1));
  assert.equal(s.screen, 'match');
  s = reduce(s, ev('match.score_posted', T0 + 2));
  assert.equal(s.screen, 'score');
});

test('a cue screen change is automation: it never sets or breaks a hold', () => {
  let s = initialState();

  // No hold: the cue moves the screen and leaves automatic switching alive.
  s = reduce(s, { ...ev('screen.change', T0, { screen: 'overview' }), source: 'cue' });
  assert.equal(s.screen, 'overview');
  assert.equal(s.screenHold, false, 'a cue take must not freeze the lifecycle');
  s = reduce(s, ev('match.armed', T0 + 1));
  assert.equal(s.screen, 'match', 'automatic transitions still run after a cue change');

  // Operator holds: the cue loses.
  s = reduce(s, ev('screen.change', T0 + 2, { screen: 'arcade' }));
  s = reduce(s, { ...ev('screen.change', T0 + 3, { screen: 'score' }), source: 'cue' });
  assert.equal(s.screen, 'arcade', 'a cue never overrides an operator hold');
  assert.equal(s.screenHold, true);

  // And a cue cannot hand control back on the operator's behalf.
  s = reduce(s, { ...ev('screen.change', T0 + 4, { screen: 'auto' }), source: 'cue' });
  assert.equal(s.screenHold, true);
});

test('teleop start re-anchors the clock across the field pause', () => {
  let s = started();
  // The field pauses (here 2s) between auto and teleop, so teleop begins at
  // wall +22s even though the desk axis says +20. Without the re-anchor every
  // teleop boundary, including the synthesized buzzer, ran 2s early.
  s = reduce(s, ev('match.teleop_start', T0 + 22_000));
  assert.equal(s.matchClock, 0, 'matchClock is exactly 0 at the field teleop start');
  assert.equal(s.lastMatchStartedAt, T0, 'the true start survives for clip cutting');

  // 139s of teleop later the match is still live on the field's axis.
  s = reduce(s, ev('score.delta', T0 + 22_000 + 139_000, { alliance: 'red', field: 'fuel', amount: 1 }));
  assert.equal(s.phase, 'endgame', 'not post: the buzzer lands 140s after the REAL teleop start');
  assert.equal(s.score.red.teleopFuel, 1);
});

test('the re-anchor is ignored when no match is running', () => {
  const s = reduce(initialState(), ev('match.teleop_start', T0));
  assert.equal(s.matchStartedAt, null);
  assert.equal(s.matchClock, null);
});

test('a field timeout raises the delay card and prestart retires it', () => {
  let s = reduce(initialState(), ev('break.started', T0, { kind: 'timeout' }));
  assert.equal(s.status?.kind, 'delay');
  assert.equal(s.status?.message, 'Field timeout');

  // The field coming back is what ends a timeout; no operator action needed.
  s = reduce(s, ev('match.prestart', T0 + 60_000));
  assert.equal(s.status, null);
});

test('the automatic timeout card never overwrites the producer', () => {
  let s = reduce(initialState(), ev('status.show', T0,
    { kind: 'fault', message: 'Arena fault, back soon', backAt: null }));
  s = reduce(s, ev('break.started', T0 + 1000, { kind: 'timeout' }));
  assert.equal(s.status?.message, 'Arena fault, back soon', 'operator wording wins');

  // And prestart leaves the operator card alone too.
  s = reduce(s, ev('match.prestart', T0 + 2000));
  assert.equal(s.status?.kind, 'fault');
});

test('the live camera is tracked separately from the graphic', () => {
  // Screens follow the match on their own; the shot does not. Keeping them
  // separate is what lets the graphics stay right when a three-person crew is
  // late on a cut.
  let s = initialState();
  s = reduce(s, ev('screen.change', T0, { screen: 'match' }));
  s = reduce(s, ev('scene.change', T0 + 1, { scene: 'CG_REPLAY' }));
  assert.equal(s.screen, 'match');
  assert.equal(s.scene, 'CG_REPLAY');

  // An empty scene name clears rather than storing '', so a console can ask
  // "is anything known" without a falsy-string trap.
  s = reduce(s, ev('scene.change', T0 + 2, { scene: '' }));
  assert.equal(s.scene, null);
});

test('a safety message latches until it is explicitly cleared', () => {
  // The whole difference between this and a status card: nothing retires it.
  // Not a new match, not a score, not the next screen change.
  let s = initialState();
  s = reduce(s, ev('emergency.raise', T0, {
    kind: 'evacuate', message: 'Leave by the north doors', detail: 'Muster on the field',
  }));
  assert.equal(s.emergency?.kind, 'evacuate');
  assert.equal(s.emergency?.message, 'Leave by the north doors');

  s = reduce(s, ev('match.loaded', T0 + 1, { id: 'q1', displayName: 'Q1', red: [], blue: [] }));
  s = reduce(s, ev('match.start', T0 + 2));
  s = reduce(s, ev('match.score_posted', T0 + 3, {}));
  assert.ok(s.emergency, 'a whole match cycle must not clear a safety message');

  s = reduce(s, ev('emergency.clear', T0 + 4));
  assert.equal(s.emergency, null);
});

test('a safety message with no words is refused rather than shown blank', () => {
  const s = reduce(initialState(), ev('emergency.raise', T0, { message: '   ' }));
  assert.equal(s.emergency, null, 'a blank plate over the match would be worse than nothing');
});

test('accessibility services are listed only when the event actually has them', () => {
  // An event that lists nothing shows nothing. Inventing a service is worse
  // than silence: somebody walks across a building looking for a room that
  // does not exist.
  let s = initialState();
  assert.deepEqual(s.accessibility.services, []);

  s = reduce(s, ev('event.accessibility', T0, {
    services: [
      { label: 'Quiet room', detail: 'Room 114, past the pits' },
      { label: '', detail: 'orphaned detail' },
      { label: 'ASL interpretation', detail: 'Awards ceremony' },
    ],
    ask: 'Ask anyone in a purple shirt',
  }));
  assert.deepEqual(s.accessibility.services.map(x => x.label),
    ['Quiet room', 'ASL interpretation'],
    'an entry with no label is not a service anybody can act on');
  assert.equal(s.accessibility.ask, 'Ask anyone in a purple shirt');
});

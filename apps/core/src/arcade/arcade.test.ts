import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../bus.ts';
import { ArcadeStore } from './store.ts';
import { MK_POINTS, setWinner, standings, type ArcadePlayer, type GrandPrix } from './model.ts';

const racers = ['a', 'b', 'c', 'd'].map(id => ({ id, name: id.toUpperCase() }));
const gp = (races: string[][]): GrandPrix =>
  ({ game: 'mariokart', name: 'Pit Crew Cup', racers, races, raceCount: 4 });

test('grand prix points follow the MK8D table', () => {
  assert.deepEqual([...MK_POINTS].slice(0, 4), [15, 12, 10, 9]);

  const table = standings(gp([['a', 'b', 'c', 'd']]));
  assert.deepEqual(table.map(s => [s.player.id, s.points]), [
    ['a', 15], ['b', 12], ['c', 10], ['d', 9],
  ]);
});

test('points accumulate across races', () => {
  const table = standings(gp([
    ['a', 'b', 'c', 'd'],
    ['d', 'c', 'b', 'a'],
  ]));
  // a: 15 + 9 = 24, b: 12 + 10 = 22, c: 10 + 12 = 22, d: 9 + 15 = 24
  assert.deepEqual(
    table.map(s => [s.player.id, s.points]),
    [['a', 24], ['d', 24], ['b', 22], ['c', 22]],
  );
});

test('ties break on best single finish, as Mario Kart does', () => {
  // a: 1st then 4th  -> 15 + 9  = 24, best finish 1
  // b: 2nd then 2nd  -> 12 + 12 = 24, best finish 2
  // c: 3rd then 1st  -> 10 + 15 = 25
  // d: 4th then 3rd  ->  9 + 10 = 19
  const table = standings(gp([
    ['a', 'b', 'c', 'd'],
    ['c', 'b', 'd', 'a'],
  ]));

  assert.deepEqual(table.map(s => [s.player.id, s.points]), [
    ['c', 25], ['a', 24], ['b', 24], ['d', 19],
  ]);
  // a and b are level on 24; a placed 1st once and b never better than 2nd.
  assert.equal(table[1]?.player.id, 'a', 'best single finish wins the tie');
  assert.equal(table[2]?.player.id, 'b');
});

test('positions are recorded for the detail line', () => {
  const table = standings(gp([['c', 'a', 'b', 'd'], ['a', 'c', 'd', 'b']]));
  const a = table.find(s => s.player.id === 'a')!;
  assert.deepEqual(a.positions, [2, 1]);
});

test('an unknown racer id is ignored rather than crashing the overlay', () => {
  const table = standings(gp([['a', 'ghost', 'b']]));
  assert.equal(table.find(s => s.player.id === 'a')?.points, 15);
  assert.equal(table.length, 4, 'no phantom row is created');
});

test('a set is decided at best-of-three', () => {
  const players = [{ id: 'p1', name: 'One' }, { id: 'p2', name: 'Two' }];
  const base = {
    id: 's1', game: 'smash' as const, round: 'Winners Semifinal',
    players, state: 'live' as const, scoreConfidence: 'estimated' as const,
  };

  assert.equal(setWinner({ ...base, scores: [1, 1] }), null);
  assert.equal(setWinner({ ...base, scores: [2, 0] })?.id, 'p1');
  assert.equal(setWinner({ ...base, scores: [1, 2] })?.id, 'p2');
  // Best of five needs three.
  assert.equal(setWinner({ ...base, scores: [2, 1] }, 5), null);
  assert.equal(setWinner({ ...base, scores: [3, 1] }, 5)?.id, 'p1');
});

test('a free-for-all never auto-completes; a versus set still does', () => {
  const ffa = {
    id: 's1', game: 'pacman' as const, round: 'Party 1',
    players: ['a', 'b', 'c', 'd'].map(id => ({ id, name: id })),
    scores: [9, 2, 5, 2],
    state: 'live' as const, scoreConfidence: 'authoritative' as const,
  };
  // 9 is far past any best-of threshold, but with 4 players nobody "wins" a
  // set automatically: a Pac-Man party ends when the operator ends it.
  assert.equal(setWinner(ffa), null);

  const versus = { ...ffa, players: ffa.players.slice(0, 2), scores: [2, 0] };
  assert.equal(setWinner(versus)?.id, 'a');
});

test('a malformed race result is refused before it can poison the standings', () => {
  const store = new ArcadeStore(new EventBus());
  store.startGrandPrix('Pit Crew Cup', racers);
  // These once pushed first and threw later, which left every subsequent
  // snapshot throwing until the bad entry was popped by hand.
  assert.throws(() => store.recordRace('a' as unknown as string[]), /finishing order/);
  assert.throws(() => store.recordRace([1, 2] as unknown as string[]), /finishing order/);
  store.recordRace(['a', 'b', 'c', 'd']);
  assert.equal(store.snapshot.standings[0]?.points, 15, 'the store stays healthy');
  assert.throws(
    () => store.startGrandPrix('Bad', 'nope' as unknown as ArcadePlayer[]),
    /id and a name/);
});

test('a best-of-5 set completes at three wins, not two', () => {
  const store = new ArcadeStore(new EventBus());
  const players = [{ id: 'p1', name: 'One' }, { id: 'p2', name: 'Two' }];
  store.startSet({ game: 'smash', round: 'Grand Final', players, bestOf: 5 });
  store.score(0, 1);
  store.score(0, 1);
  assert.equal(store.snapshot.set?.state, 'live', 'two wins do not end a Bo5');
  store.score(0, 1);
  assert.equal(store.snapshot.set?.state, 'complete');

  assert.throws(
    () => store.startSet({ game: 'smash', round: 'Bad', players, bestOf: 4 }),
    /best of 3 or best of 5/);
  store.startSet({ game: 'smash', round: 'Winners Final', players });
  store.score(1, 1);
  store.score(1, 1);
  assert.equal(store.snapshot.set?.state, 'complete', 'the default is still best of 3');
});

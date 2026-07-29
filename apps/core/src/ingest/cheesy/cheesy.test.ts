import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertPathAllowed, assertSocketAllowed, ALLOWED_SOCKETS } from './client.ts';
import { fuelPoints, towerPoints, MatchState } from './protocol.ts';
import { CheesyAdapter } from './adapter.ts';
import { EventBus } from '../../bus.ts';
import type { DeskEvent } from '../../types.ts';

test('refuses sockets that can control the field', () => {
  // These have a read loop in Cheesy Arena and accept commands that abort a
  // match or corrupt scoring. They must be unreachable by construction.
  for (const path of [
    '/match_play/websocket',
    '/panels/scoring/red/websocket',
    '/panels/scoring/blue/websocket',
    '/panels/referee/websocket',
    '/alliance_selection/websocket',
    '/setup/settings/websocket',
  ]) {
    assert.throws(() => assertSocketAllowed(path), /Refusing to open/, path);
  }
});

test('permits only the listener sockets', () => {
  for (const path of ALLOWED_SOCKETS) {
    assert.doesNotThrow(() => assertSocketAllowed(path));
  }
});

test('refuses REST paths outside the read allowlist', () => {
  for (const path of ['/setup/db/clear/matches', '/setup/settings', '/match_play/match_load',
    '/reports/csv/rankings', '/api/../setup/settings']) {
    assert.throws(() => assertPathAllowed(path), /Refusing to request/, path);
  }
  for (const path of ['/api/rankings', '/api/alliances', '/api/matches/qualification',
    '/api/teams/846/avatar', '/api/bracket/svg']) {
    assert.doesNotThrow(() => assertPathAllowed(path), path);
  }
});

test('fuel and tower points combine auto and teleop', () => {
  const s = { AutoFuelPoints: 12, TeleopFuelPoints: 130, AutoTowerPoints: 15, TeleopTowerPoints: 50 };
  assert.equal(fuelPoints(s), 142);
  assert.equal(towerPoints(s), 65);
  assert.equal(fuelPoints(undefined), 0);
  assert.equal(towerPoints({}), 0);
});

test('synthesises score deltas from consecutive snapshots', () => {
  const bus = new EventBus();
  const seen: DeskEvent[] = [];
  bus.subscribe(ev => seen.push(ev));

  const adapter = new CheesyAdapter({ bus, host: '127.0.0.1:1', displayId: 'test' });

  adapter.ingest('realtimeScore', {
    Red: { ScoreSummary: { TeleopFuelPoints: 10, FoulPoints: 0 } },
    Blue: { ScoreSummary: { TeleopFuelPoints: 4, FoulPoints: 0 } },
  });
  adapter.ingest('realtimeScore', {
    Red: { ScoreSummary: { TeleopFuelPoints: 16, TeleopTowerPoints: 30, FoulPoints: 0 } },
    Blue: { ScoreSummary: { TeleopFuelPoints: 4, FoulPoints: 0 } },
  });

  const deltas = seen.filter(e => e.type === 'score.delta')
    .map(e => e.payload as { alliance: string; field: string; amount: number });

  // First snapshot is the baseline from zero; second yields +6 fuel and +30 tower.
  assert.deepEqual(deltas, [
    { alliance: 'red', field: 'fuel', amount: 10 },
    { alliance: 'blue', field: 'fuel', amount: 4 },
    { alliance: 'red', field: 'fuel', amount: 6 },
    { alliance: 'red', field: 'tower', amount: 30 },
  ]);
});

test('never emits a negative delta on a score correction', () => {
  const bus = new EventBus();
  const seen: DeskEvent[] = [];
  bus.subscribe(ev => seen.push(ev));
  const adapter = new CheesyAdapter({ bus, host: '127.0.0.1:1', displayId: 'test' });

  adapter.ingest('realtimeScore', { Red: { ScoreSummary: { TeleopFuelPoints: 40 } } });
  seen.length = 0;
  // A referee correction takes points away. That is not a highlight, and a
  // marker here would send the replay operator to nothing.
  adapter.ingest('realtimeScore', { Red: { ScoreSummary: { TeleopFuelPoints: 25 } } });

  assert.equal(seen.filter(e => e.type === 'score.delta').length, 0);
});

test('foul points land on the conceding side of the ledger', () => {
  const bus = new EventBus();
  const adapter = new CheesyAdapter({ bus, host: '127.0.0.1:1', displayId: 'test' });

  // Cheesy credits FoulPoints TO an alliance. Our reducer computes
  // total = fuel + tower + opponent.fouls, so red's 15 foul points must be
  // recorded as blue conceding them, or both totals come out wrong.
  adapter.ingest('realtimeScore', {
    Red: { ScoreSummary: { TeleopFuelPoints: 100, FoulPoints: 15 } },
    Blue: { ScoreSummary: { TeleopFuelPoints: 90, FoulPoints: 0 } },
  });

  assert.equal(bus.state.score.red.total, 115, 'red = 100 fuel + 15 conceded by blue');
  assert.equal(bus.state.score.blue.total, 90);
});

test('match start fires once, and only a real end counts', () => {
  const bus = new EventBus();
  const seen: string[] = [];
  bus.subscribe(ev => seen.push(ev.type));
  const adapter = new CheesyAdapter({ bus, host: '127.0.0.1:1', displayId: 'test' });

  adapter.ingest('matchTime', { MatchState: MatchState.StartMatch });
  adapter.ingest('matchTime', { MatchState: MatchState.AutoPeriod });
  adapter.ingest('matchTime', { MatchState: MatchState.TeleopPeriod });
  adapter.ingest('matchTime', { MatchState: MatchState.PostMatch });

  assert.equal(seen.filter(t => t === 'match.start').length, 1);
  assert.equal(seen.filter(t => t === 'match.end').length, 1);

  // Coming back from a timeout must not look like another match ending.
  seen.length = 0;
  adapter.ingest('matchTime', { MatchState: MatchState.TimeoutActive });
  adapter.ingest('matchTime', { MatchState: MatchState.PostTimeout });
  adapter.ingest('matchTime', { MatchState: MatchState.PostMatch });
  assert.equal(seen.filter(t => t === 'match.end').length, 0);
});

test('maps a loaded match into teams and a display name', () => {
  const bus = new EventBus();
  const adapter = new CheesyAdapter({ bus, host: '127.0.0.1:1', displayId: 'test' });

  adapter.ingest('matchLoad', {
    Match: { Id: 42, LongName: 'Qualification 42', Red1: 846, Red2: 1868, Red3: 253,
             Blue1: 100, Blue2: 115, Blue3: 670 },
    Teams: {
      R1: { Id: 846, Nickname: 'The Funky Monkeys' },
      R2: { Id: 1868, Nickname: 'Space Cookies' },
      R3: { Id: 253, Nickname: 'Boba Bots' },
      B1: { Id: 100, Nickname: 'The Wildhats' },
      B2: { Id: 115, Nickname: 'MVRT' },
      B3: { Id: 670, Nickname: 'Homestead Robotics' },
    },
  });

  assert.equal(bus.state.match?.displayName, 'Qualification 42');
  assert.deepEqual(bus.state.match?.red.map(t => t.number), [846, 1868, 253]);
  assert.equal(bus.state.match?.blue[2]?.name, 'Homestead Robotics');
});

test('the field decides the auto winner, on fuel alone', () => {
  const bus = new EventBus();
  const adapter = new CheesyAdapter({ bus, host: '127.0.0.1:1', displayId: 'test' });

  adapter.ingest('matchLoad', { Match: { Id: 1, LongName: 'Qualification 1' } });
  adapter.ingest('matchTime', { MatchState: MatchState.AutoPeriod });
  // Red climbs for 15 auto points but scores no fuel. Cheesy decides auto on
  // AUTO FUEL COUNT, so this is a tied auto despite red leading on points.
  adapter.ingest('realtimeScore', {
    MatchState: MatchState.AutoPeriod,
    Red: { ScoreSummary: { AutoTowerPoints: 15, AutoFuelPoints: 0 } },
    Blue: { ScoreSummary: { AutoFuelPoints: 0 } },
  });
  adapter.ingest('realtimeScore', {
    MatchState: MatchState.TeleopPeriod,
    Red: { ScoreSummary: { AutoTowerPoints: 15, AutoFuelPoints: 0 } },
    Blue: { ScoreSummary: { AutoFuelPoints: 0 } },
  });

  // Null, not "red". On a tie Cheesy flips a coin, so there is nothing to
  // derive — and `autoWinnerKnown` stops the local heuristic overwriting it.
  assert.equal(bus.state.autoWinner, null);
  assert.equal(bus.state.autoWinnerKnown, true);
});

test('auto fuel, not points, picks the winner', () => {
  const bus = new EventBus();
  const adapter = new CheesyAdapter({ bus, host: '127.0.0.1:1', displayId: 'test' });

  adapter.ingest('matchLoad', { Match: { Id: 1, LongName: 'Qualification 1' } });
  adapter.ingest('matchTime', { MatchState: MatchState.AutoPeriod });
  adapter.ingest('realtimeScore', {
    MatchState: MatchState.AutoPeriod,
    Red: { ScoreSummary: { AutoTowerPoints: 30, AutoFuelPoints: 4 } },
    Blue: { ScoreSummary: { AutoFuelPoints: 9 } },
  });
  adapter.ingest('realtimeScore', {
    MatchState: MatchState.TeleopPeriod,
    Red: { ScoreSummary: { AutoTowerPoints: 30, AutoFuelPoints: 4 } },
    Blue: { ScoreSummary: { AutoFuelPoints: 9 } },
  });

  // Red leads on auto points 34-9 and still loses auto.
  assert.equal(bus.state.autoWinner, 'blue');
});

test('hub state from the field beats inference', () => {
  const bus = new EventBus();
  const adapter = new CheesyAdapter({ bus, host: '127.0.0.1:1', displayId: 'test' });

  adapter.ingest('realtimeScore', {
    MatchState: MatchState.TeleopPeriod,
    Red: { ActiveRemainingSec: 12, ScoreSummary: {} },
    Blue: { ActiveRemainingSec: 0, ScoreSummary: {} },
  });
  assert.equal(bus.state.hubAuthoritative, 'red');
  assert.equal(bus.state.hubActive, 'red');

  adapter.ingest('realtimeScore', {
    MatchState: MatchState.TeleopPeriod,
    Red: { ActiveRemainingSec: 0, ScoreSummary: {} },
    Blue: { ActiveRemainingSec: 20, ScoreSummary: {} },
  });
  assert.equal(bus.state.hubActive, 'blue');

  // Between matches there is no live hub, so we fall back to inference.
  adapter.ingest('realtimeScore', {
    MatchState: MatchState.PostMatch,
    Red: { ScoreSummary: {} }, Blue: { ScoreSummary: {} },
  });
  assert.equal(bus.state.hubAuthoritative, null);
});

test('reports robots that have lost their driver station link', () => {
  const bus = new EventBus();
  const seen: DeskEvent[] = [];
  bus.subscribe(ev => seen.push(ev));
  const adapter = new CheesyAdapter({ bus, host: '127.0.0.1:1', displayId: 'test' });

  adapter.ingest('arenaStatus', {
    AllianceStations: {
      R1: { Team: { Id: 846 }, Ds: { RobotLinked: true } },
      R2: { Team: { Id: 1868 }, Ds: { RobotLinked: false } },
      R3: { Team: { Id: 253 }, Ds: { RobotLinked: false }, Bypass: true },
      B1: { Team: null, Ds: null },
    },
  });

  const status = seen.filter(e => e.type === 'arena.status').at(-1)?.payload as { down: number[] };
  // 1868 is genuinely down; 253 is bypassed on purpose and must not be flagged.
  assert.deepEqual(status.down, [1868]);
});


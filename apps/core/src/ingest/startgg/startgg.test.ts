import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../../bus.ts';
import { ArcadeStore } from '../../arcade/store.ts';
import { StartggAdapter, mapSets, parseEntrant, type EventSetsResponse } from './adapter.ts';
import { StartggClient } from './client.ts';

test('entrant names parse into the FRC-team crossover', () => {
  // Sponsor-prefix convention: a pure number in the sponsor slot is a team.
  assert.deepEqual(parseEntrant('846 | Ana', 'e1'), { id: 'e1', name: 'Ana', team: 846 });
  assert.deepEqual(parseEntrant('1868 - Ben', 'e2'), { id: 'e2', name: 'Ben', team: 1868 });
  assert.deepEqual(parseEntrant('Cy 254', 'e3'), { id: 'e3', name: 'Cy', team: 254 });
  // A real sponsor tag is NOT a team, and a bare gamertag stays whole.
  assert.deepEqual(parseEntrant('C9 | Mango', 'e4'), { id: 'e4', name: 'C9 | Mango' });
  assert.deepEqual(parseEntrant('Dee', 'e5'), { id: 'e5', name: 'Dee' });
});

const FIXTURE: EventSetsResponse = {
  event: {
    name: 'Smash Singles',
    sets: {
      pageInfo: { totalPages: 1 },
      nodes: [
        {
          id: 111, state: 2, fullRoundText: 'Winners Semifinal',
          slots: [
            { entrant: { id: 9, name: '846 | Ana', initialSeedNum: 1 } },
            { entrant: { id: 10, name: 'Dee', initialSeedNum: 8 } },
          ],
        },
        {
          id: 112, state: 1, fullRoundText: 'Winners Final',
          // Second slot undecided ("winner of 111") arrives as a null entrant.
          slots: [{ entrant: { id: 11, name: 'Cy 254' } }, { entrant: null }],
        },
        {
          id: 113, state: 3, fullRoundText: 'Losers Round 1',
          slots: [
            { entrant: { id: 12, name: 'Ben' } },
            { entrant: { id: 13, name: 'Eve' } },
          ],
        },
        // A set with no decided entrants at all is noise; it must be dropped.
        { id: 114, state: 1, fullRoundText: 'Grand Final', slots: [{ entrant: null }, { entrant: null }] },
      ],
    },
  },
};

test('sets map to scoreless bracket metadata', () => {
  const sets = mapSets(FIXTURE);

  assert.equal(sets.length, 3, 'the empty Grand Final placeholder is dropped');
  assert.deepEqual(sets[0], {
    id: '111', round: 'Winners Semifinal', state: 'live',
    players: [
      { id: '9', name: 'Ana', team: 846, seed: 1 },
      { id: '10', name: 'Dee', seed: 8 },
    ],
  });
  // Half-decided set keeps its one known entrant.
  assert.equal(sets[1]?.state, 'upcoming');
  assert.deepEqual(sets[1]?.players, [{ id: '11', name: 'Cy', team: 254 }]);
  assert.equal(sets[2]?.state, 'complete');

  // The contract that matters: nothing here carries a score.
  for (const s of sets) assert.ok(!('scores' in s));
});

test('unknown set states degrade to upcoming rather than crashing', () => {
  const sets = mapSets({
    event: { sets: { nodes: [{ id: 1, state: 6, fullRoundText: 'Called', slots: [{ entrant: { id: 1, name: 'A' } }] }] } },
  });
  assert.equal(sets[0]?.state, 'upcoming');
  assert.deepEqual(mapSets({}), []);
  assert.deepEqual(mapSets({ event: null }), []);
});

test('the adapter feeds the store without touching the live set', async () => {
  const bus = new EventBus();
  const arcade = new ArcadeStore(bus);

  // Operator has a live set going, score confirmed by hand.
  arcade.startSet({
    game: 'smash', round: 'Winners Semifinal',
    players: [{ id: 'p1', name: 'Ana' }, { id: 'p2', name: 'Dee' }],
  });
  arcade.score(0, 1);

  const fetchFn = (async () => new Response(JSON.stringify({ data: FIXTURE }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  })) as unknown as typeof fetch;

  const seen: string[] = [];
  bus.subscribe(ev => seen.push(`${ev.type}:${ev.source}`));

  const adapter = new StartggAdapter({
    arcade, token: 't', eventSlug: 'tournament/x/event/y',
    client: new StartggClient({ token: 't', fetchFn }),
  });
  await adapter.poll();

  const snap = arcade.snapshot;
  assert.equal(snap.bracket.length, 3);
  assert.equal(snap.bracket[0]?.players[0]?.team, 846);
  // The live set and its operator-confirmed score are untouched.
  assert.equal(snap.set?.scores[0], 1);
  assert.equal(snap.set?.scoreConfidence, 'authoritative');
  assert.deepEqual(seen.filter(s => s.startsWith('arcade.bracket_updated')),
    ['arcade.bracket_updated:startgg']);
});

test('a failing poll leaves the last good bracket in place', async () => {
  const bus = new EventBus();
  const arcade = new ArcadeStore(bus);
  arcade.setBracket([{ id: '1', round: 'Winners Final', state: 'upcoming', players: [{ id: 'e', name: 'A' }] }]);

  const fetchFn = (async () => new Response('{}', { status: 500 })) as unknown as typeof fetch;
  const adapter = new StartggAdapter({
    arcade, token: 't', eventSlug: 'tournament/x/event/y',
    client: new StartggClient({ token: 't', fetchFn }),
  });
  await adapter.poll();   // must not throw

  assert.equal(arcade.snapshot.bracket.length, 1, 'stale beats empty during a break');
});

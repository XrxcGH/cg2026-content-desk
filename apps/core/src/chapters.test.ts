import assert from 'node:assert/strict';
import test from 'node:test';

import { chapterText, chaptersFrom, timecode } from './chapters.ts';
import { eventId, type DeskEvent } from './types.ts';

const T0 = Date.UTC(2026, 9, 17, 16, 0, 0);

const ev = (type: string, atMs: number, payload: unknown = {}): DeskEvent => ({
  id: eventId(),
  ts: T0 + atMs,
  matchClock: null,
  source: 'cheesy',
  confidence: 'authoritative',
  type: type as DeskEvent['type'],
  payload,
});

const match = (atMs: number, displayName: string): DeskEvent[] => [
  ev('match.loaded', atMs - 60_000, { displayName, red: [], blue: [] }),
  ev('match.start', atMs),
];

test('timecode drops the hour until there is one, and pads correctly', () => {
  assert.equal(timecode(0), '0:00');
  assert.equal(timecode(9), '0:09');
  assert.equal(timecode(75), '1:15');
  assert.equal(timecode(3600), '1:00:00');
  assert.equal(timecode(3725), '1:02:05');
  assert.equal(timecode(-5), '0:00');
});

test('every match becomes a chapter, named and backed up onto the countdown', () => {
  const log = [
    ...match(10 * 60_000, 'Qualification 41'),
    ...match(13 * 60_000, 'Qualification 42'),
    ...match(16 * 60_000, 'Qualification 43'),
  ];
  const chapters = chaptersFrom(log, T0);

  assert.equal(chapters[0]!.atSec, 0, 'YouTube requires a chapter at 0:00');
  assert.deepEqual(chapters.slice(1), [
    { atSec: 10 * 60 - 15, title: 'Qualification 41' },
    { atSec: 13 * 60 - 15, title: 'Qualification 42' },
    { atSec: 16 * 60 - 15, title: 'Qualification 43' },
  ]);
});

test('matches played before the recording started are left out, not clamped to zero', () => {
  const log = [
    ...match(-20 * 60_000, 'Qualification 40'),   // before the stream went live
    ...match(10 * 60_000, 'Qualification 41'),
    ...match(13 * 60_000, 'Qualification 42'),
  ];
  const chapters = chaptersFrom(log, T0);

  assert.equal(chapters.filter(c => c.atSec === 0).length, 1);
  assert.ok(!chapters.some(c => c.title === 'Qualification 40'));
});

test('chapters closer together than ten seconds are dropped, because they void the list', () => {
  const log = [
    ...match(5_000, 'Qualification 41'),          // lead-in lands it at 0:00
    ...match(10 * 60_000, 'Qualification 42'),   // lands at 9:45 after the lead-in
    ev('award.presented', 588_000, { name: 'Chairmans' }),   // 3s later
    ...match(20 * 60_000, 'Qualification 43'),
  ];
  const chapters = chaptersFrom(log, T0);

  for (let i = 1; i < chapters.length; i++) {
    assert.ok(chapters[i]!.atSec - chapters[i - 1]!.atSec >= 10,
      `chapter ${i} is too close to the one before it`);
  }
  assert.ok(!chapters.some(c => c.title === 'Chairmans'),
    'an award three seconds after a match start would void the whole list');
  assert.ok(!chapters.some(c => c.title === 'Qualification 41'),
    'the lead-in pulled it onto 0:00, where it collides with the opener');
});

test('alliance selection lands once, no matter how many picks republish it', () => {
  const log = [
    ...match(10 * 60_000, 'Qualification 43'),
    ev('alliance_selection.update', 30 * 60_000, { alliances: [] }),
    ev('alliance_selection.update', 31 * 60_000, { alliances: [] }),
    ev('alliance_selection.update', 32 * 60_000, { alliances: [] }),
  ];
  const chapters = chaptersFrom(log, T0);
  assert.equal(chapters.filter(c => c.title === 'Alliance selection').length, 1);
  assert.equal(chapters.find(c => c.title === 'Alliance selection')?.atSec, 30 * 60);
});

test('a replayed match keeps its own chapter even though the title repeats', () => {
  // Qualification 43 is aborted right after starting, then run again in full
  // ten minutes later. Cheesy reloads the same match, so the title repeats,
  // but the re-run is the one worth jumping to, not the aborted attempt.
  const log = [
    ...match(10 * 60_000, 'Qualification 43'),
    ...match(20 * 60_000, 'Qualification 43'),
  ];
  const chapters = chaptersFrom(log, T0);

  assert.equal(chapters.filter(c => c.title === 'Qualification 43').length, 2,
    'both the aborted attempt and the real re-run get a chapter');
  assert.deepEqual(chapters.map(c => c.atSec), [0, 10 * 60 - 15, 20 * 60 - 15]);
});

test('text is paste-ready, ascending, and empty when there is too little to work', () => {
  const log = [
    ...match(10 * 60_000, 'Qualification 41'),
    ...match(70 * 60_000, 'Qualification 42'),
  ];
  const text = chapterText(chaptersFrom(log, T0, { openingTitle: 'CalGames 2026 Saturday' }));

  assert.equal(text.split('\n')[0], '0:00 CalGames 2026 Saturday');
  assert.ok(text.includes('9:45 Qualification 41'));
  assert.ok(text.includes('1:09:45 Qualification 42'), 'crosses the hour correctly');

  assert.equal(chapterText([{ atSec: 0, title: 'Only one' }]), '',
    'a list YouTube would silently ignore comes back empty instead');
});

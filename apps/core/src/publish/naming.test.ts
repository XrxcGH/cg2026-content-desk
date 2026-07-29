import { test } from 'node:test';
import assert from 'node:assert/strict';
import { description, identify, streamTitle, videoTitle } from './naming.ts';

test('qualification naming matches the official channel', () => {
  for (const input of ['Qualification 1', 'Qual 1', 'Q1', 'qm1', 'qualification #1']) {
    assert.deepEqual(identify(input), { name: 'Qualification 1', key: 'qm1' }, input);
  }
  assert.deepEqual(identify('Qualification 42'), { name: 'Qualification 42', key: 'qm42' });
});

test('playoff matches get the (Rn) suffix and sf keys', () => {
  assert.deepEqual(identify('Match 1 (R1)'), { name: 'Match 1 (R1)', key: 'sf1m1' });
  assert.deepEqual(identify('Playoff 1'), { name: 'Match 1 (R1)', key: 'sf1m1' });
  assert.deepEqual(identify('Match 5'), { name: 'Match 5 (R2)', key: 'sf5m1' });
  assert.deepEqual(identify('Match 13'), { name: 'Match 13 (R7)', key: 'sf13m1' });
});

test('finals and the tiebreaker', () => {
  assert.deepEqual(identify('Final 1'), { name: 'Final 1', key: 'f1m1' });
  assert.deepEqual(identify('Finals 2'), { name: 'Final 2', key: 'f1m2' });
  assert.deepEqual(identify('Final Tiebreaker'), { name: 'Final Tiebreaker', key: 'f1m3' });
  // A third final IS the tiebreaker, however it arrives.
  assert.deepEqual(identify('Final 3'), { name: 'Final Tiebreaker', key: 'f1m3' });
  assert.deepEqual(identify('Final Two'), { name: 'Final 2', key: 'f1m2' });
});

test('practice matches are never publishable', () => {
  assert.equal(identify('Practice 3').key, null);
});

test('titles carry the event suffix', () => {
  assert.equal(videoTitle('Qualification 1', 'CalGames'), 'Qualification 1 - CalGames');
  assert.equal(videoTitle('Final Tiebreaker', 'CalGames'), 'Final Tiebreaker - CalGames');
  assert.equal(streamTitle(2026, 'CalGames', 1), '2026 CalGames - Day 1');
});

test('description matches the official layout', () => {
  const out = description({
    title: 'Final Tiebreaker - CalGames',
    red: { teams: [6238, 1323, 254], score: 552 },
    blue: { teams: [6665, 1678, 9470], score: 527 },
    resultsUrl: 'https://frc-events.firstinspires.org/2026/cacg',
    credit: 'Uploaded by the CalGames Content Desk',
    copyright: '(c) 2026 Western Region Robotics Forum',
  });

  assert.equal(out, [
    'Final Tiebreaker - CalGames',
    'Red (Teams 6238, 1323, 254) - 552',
    'Blue (Teams 6665, 1678, 9470) - 527',
    'https://frc-events.firstinspires.org/2026/cacg',
    '',
    'Uploaded by the CalGames Content Desk',
    '(c) 2026 Western Region Robotics Forum',
  ].join('\n'));
});

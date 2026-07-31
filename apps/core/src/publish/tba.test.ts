import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TbaClient, assertAllowed, signature } from './tba.ts';

test('signature matches TBA\'s published test vector', () => {
  // Straight from the Trusted APIv1 docs. If this ever fails, every request
  // this client makes will 401, and the error will look like bad credentials.
  const secret = 'ExqeZK3Gbo9v95YnqmsiADzESo9HNgyhIOYSMyRpqJqYv13EazNRaDIPPJuOXrQp';
  const path = '/api/trusted/v1/event/2014casj/matches/delete';
  const body = '["qm1"]';

  assert.equal(signature(secret, path, body), 'ca5c3e5c1b0e7132e4af13f805eca0be');
});

test('refuses every endpoint outside the video allowlist', () => {
  // Cheesy Arena owns match data on TBA. These endpoints require the FULL
  // dataset, so calling one would delete every result not included, which is
  // why this is a hard guard rather than a code-review convention.
  for (const op of ['matches/update', 'matches/delete', 'rankings/update', 'awards/update',
    'alliance_selections/update', 'team_list/update', 'info/update']) {
    assert.throws(() => assertAllowed(op), /Refusing to call TBA/, `${op} must be rejected`);
  }
});

test('permits the four video and webcast endpoints', () => {
  for (const op of ['match_videos/add', 'match_videos/delete', 'media/add', 'webcasts/update']) {
    assert.doesNotThrow(() => assertAllowed(op));
  }
});

test('unconfigured client reports itself as such', () => {
  assert.equal(new TbaClient({ authId: '', authSecret: '' }, '2026cacg').configured, false);
  assert.equal(new TbaClient({ authId: 'a', authSecret: 'b' }, '').configured, false);
  assert.equal(new TbaClient({ authId: 'a', authSecret: 'b' }, '2026cacg').configured, true);
});

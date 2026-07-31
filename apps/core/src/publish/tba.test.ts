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

test('refuses every endpoint outside the allowlist', () => {
  // Cheesy Arena owns match data on TBA. These endpoints require the FULL
  // dataset, so calling one would delete every result not included, which is
  // why this is a hard guard rather than a code-review convention.
  for (const op of ['matches/update', 'matches/delete', 'rankings/update', 'awards/update',
    'alliance_selections/update', 'team_list/update']) {
    assert.throws(() => assertAllowed(op), /Refusing to call TBA/, `${op} must be rejected`);
  }
  // These two were once on the allowlist but do not exist in TBA's route
  // table: a call would be signed, sent, and 404 upstream.
  for (const op of ['webcasts/update', 'match_videos/delete']) {
    assert.throws(() => assertAllowed(op), /Refusing to call TBA/, `${op} must be rejected`);
  }
});

test('permits the three endpoints this desk uses', () => {
  for (const op of ['match_videos/add', 'media/add', 'info/update']) {
    assert.doesNotThrow(() => assertAllowed(op));
  }
});

test('request bodies match what TBA actually parses', async () => {
  const calls: { path: string; method: string | undefined; body: unknown }[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ path: new URL(String(url)).pathname, method: init?.method, body: init?.body });
    return new Response('{}', { status: 200 });
  }) as typeof fetch;

  try {
    const client = new TbaClient({ authId: 'id', authSecret: 'secret' }, '2026cacg');
    await client.addMatchVideo('qm42', 'ytmatch');
    await client.addEventMedia('ytmedia');
    await client.setWebcasts(['https://youtube.com/watch?v=live1']);

    // match_videos/add takes a partial map of match key to id.
    assert.equal(calls[0]?.path, '/api/trusted/v1/event/2026cacg/match_videos/add');
    assert.equal(calls[0]?.body, '{"qm42":"ytmatch"}');
    // media/add takes bare id strings. The old {type, foreign_key} object
    // shape failed TBA's List[str] validation, so every link attempt 400ed.
    assert.equal(calls[1]?.path, '/api/trusted/v1/event/2026cacg/media/add');
    assert.equal(calls[1]?.body, '["ytmedia"]');
    // Webcasts ride on info/update, and the list replaces the stored one.
    assert.equal(calls[2]?.path, '/api/trusted/v1/event/2026cacg/info/update');
    assert.equal(calls[2]?.body, '{"webcasts":[{"url":"https://youtube.com/watch?v=live1"}]}');
    // The Trusted API is POST only.
    assert.ok(calls.every(c => c.method === 'POST'), 'every request must be a POST');
  } finally {
    globalThis.fetch = orig;
  }
});

test('unconfigured client reports itself as such', () => {
  assert.equal(new TbaClient({ authId: '', authSecret: '' }, '2026cacg').configured, false);
  assert.equal(new TbaClient({ authId: 'a', authSecret: 'b' }, '').configured, false);
  assert.equal(new TbaClient({ authId: 'a', authSecret: 'b' }, '2026cacg').configured, true);
});

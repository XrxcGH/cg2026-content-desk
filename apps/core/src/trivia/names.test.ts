import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../bus.ts';
import { TriviaStore } from './store.ts';
import { normalizeName, screenName } from './names.ts';

test('ordinary names are left alone', () => {
  // The expensive failure mode is not letting something through, it is
  // rejecting real people and teaching the room the game is broken.
  for (const name of [
    'Ana', 'Priya R', '846 Ben', "O'Brien", 'Jose-Luis', 'xX_Dan_Xx',
    'Cass', 'Scunthorpe', 'Dickinson', 'Hancock', 'Shitake Mushroom Fan',
  ]) {
    const v = screenName(name);
    assert.equal(v.ok, true, `${name} should be allowed: ${v.reason ?? ''}`);
  }
});

test('the obvious ones are refused', () => {
  for (const name of ['fuck', 'FUCK', 'a fucking name', 'bitch']) {
    assert.equal(screenName(name).ok, false, `${name} should be refused`);
  }
});

test('leet and padding do not get around it, which is the whole technique', () => {
  for (const name of ['sh1t', 'b!tch', 'f.u.c.k', 'fuuuuck', 'F U C K', 'SH!T']) {
    assert.equal(screenName(name).ok, false, `${name} should be refused`);
  }
});

test('the refusal never quotes the word back', () => {
  // Printing it in an error message on a shared phone is the same problem one
  // step removed.
  const v = screenName('fuck');
  assert.equal(v.ok, false);
  assert.doesNotMatch(v.reason ?? '', /fuck/i);
});

test('impersonating event staff is refused too', () => {
  assert.equal(screenName('Head Ref').ok, false);
  assert.equal(screenName('admin').ok, false);
  assert.equal(screenName('Adminah').ok, true, 'only the whole word, not a prefix');
});

test('a name of pure punctuation is refused rather than rendering blank', () => {
  assert.equal(screenName('...').ok, false);
  assert.equal(screenName('   ').ok, false);
});

test('the documented limit: a vowel swap gets through', () => {
  // "f0ck" folds to "fock", and closing that needs vowel-equivalence rules
  // that would start rejecting real names. Pinned so the trade is a decision
  // somebody made rather than a gap somebody missed. The host can kick it.
  assert.equal(screenName('f0ck').ok, true);
});

test('normalization folds lookalikes and runs', () => {
  assert.equal(normalizeName('F.U.C.K'), 'fuck');
  assert.equal(normalizeName('a55hole'), 'asshole');
  assert.equal(normalizeName('fuuuuuck'), 'fuuck', 'runs collapse to two, not one');
  assert.equal(screenName('fuuuuuck').ok, false, 'but the squashed form is still checked');
});

test('a refused name never costs a real player their slot', () => {
  // Screening runs with the other validation, BEFORE eviction: a phone posting
  // names it knows will be refused must not be able to empty a full room.
  const store = new TriviaStore(new EventBus(), []);
  const ana = store.join('Ana').playerId;
  for (let i = 0; i < 20; i++) {
    assert.throws(() => store.join('fuck'), /different name/i);
  }
  assert.equal(store.snapshot().players, 1);
  assert.ok(store.playView(ana).me, 'the real player is still here');
});

test('the host can take a name off the big screen in one action', () => {
  // The filter is a doorstop, not a guarantee, so removal has to be possible
  // while the thing is up there.
  const store = new TriviaStore(new EventBus(), []);
  store.join('Ana', 846);
  store.join('Something Rude');
  assert.equal(store.snapshot().players, 2);

  assert.deepEqual(store.kick('something rude'), { removed: 1 },
    'matched case-insensitively, because the host is reading a screen');
  assert.equal(store.snapshot().players, 1);
  assert.deepEqual(store.snapshot().standings.map(r => r.name), ['Ana']);

  assert.deepEqual(store.kick('nobody'), { removed: 0 });
  assert.throws(() => store.kick('  '), /Name the player/);
});

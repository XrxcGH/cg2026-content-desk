import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { CueEngine, defaultCues } from './engine.ts';
import { sign } from './obs.ts';
import { EventBus } from '../bus.ts';
import type { DeskEvent } from '../types.ts';

const loadMatch = (bus: EventBus): void => {
  bus.emit({
    type: 'match.loaded', source: 'cheesy',
    payload: { id: 'q42', displayName: 'Qualification 42', red: [], blue: [] },
  });
};

test('cues do nothing until their autopilot is switched on', () => {
  const bus = new EventBus();
  const engine = new CueEngine(bus, null);
  engine.attach();

  const scenes: DeskEvent[] = [];
  bus.subscribe(ev => { if (ev.type === 'scene.change') scenes.push(ev); });

  loadMatch(bus);

  assert.equal(scenes.length, 0, 'nothing should fire while off');
  const onDeck = engine.status.find(c => c.id === 'on-deck')!;
  // The producer needs to see it would have been right before trusting it.
  assert.equal(onDeck.wouldHaveFired, 1);
  assert.equal(onDeck.firedAt, null);
});

test('an armed cue fires and switches the scene', async () => {
  const bus = new EventBus();
  const engine = new CueEngine(bus, null);
  engine.attach();
  engine.setAutopilot('on-deck', true);

  const scenes: string[] = [];
  bus.subscribe(ev => {
    if (ev.type === 'scene.change') scenes.push((ev.payload as { scene: string }).scene);
  });

  loadMatch(bus);

  // Graphics switch synchronously; the scene cut is awaited, so `firedAt` is
  // only stamped once the cue's async run resolves.
  assert.deepEqual(scenes, ['CG_INTRO']);
  assert.equal(bus.state.screen, 'overview');

  await new Promise(r => setImmediate(r));
  assert.notEqual(engine.status.find(c => c.id === 'on-deck')!.firedAt, null);
});

test('autopilot is per-cue, not global', () => {
  const bus = new EventBus();
  const engine = new CueEngine(bus, null);
  engine.attach();
  engine.setAutopilot('live', true);          // trust this one only

  const scenes: string[] = [];
  bus.subscribe(ev => {
    if (ev.type === 'scene.change') scenes.push((ev.payload as { scene: string }).scene);
  });

  loadMatch(bus);                              // on-deck: off
  bus.emit({ type: 'match.start', source: 'cheesy' });

  assert.deepEqual(scenes, ['CG_MATCH'], 'only the armed cue should have acted');
});

test('cue-emitted events never re-trigger cues', () => {
  const bus = new EventBus();
  const engine = new CueEngine(bus, null);
  engine.attach();
  engine.setAll(true);

  let sceneChanges = 0;
  bus.subscribe(ev => { if (ev.type === 'scene.change') sceneChanges++; });

  loadMatch(bus);

  // on-deck emits screen.change and scene.change with source 'cue'. If those
  // fed back in, this would loop until the stack blew.
  assert.equal(sceneChanges, 1);
});

test('autopilot never cuts away from a live match; operators still can', async () => {
  const bus = new EventBus();
  const engine = new CueEngine(bus, null, {
    cues: [
      ...defaultCues(),
      // A hypothetical autopilot cue that would cut to the arcade mid-match.
      { id: 'rogue', name: 'Rogue', does: 'cuts away mid-match',
        when: ev => ev.type === 'graphic.show',
        run: async ctx => { await ctx.scene('arcade'); } },
    ],
  });
  engine.attach();
  engine.setAll(true);

  const scenes: string[] = [];
  bus.subscribe(ev => {
    if (ev.type === 'scene.change') scenes.push((ev.payload as { scene: string }).scene);
  });

  loadMatch(bus);
  bus.emit({ type: 'match.start', source: 'cheesy' });
  scenes.length = 0;

  // Autopilot tries to leave the field while the match is live: held.
  bus.emit({ type: 'graphic.show', source: 'cheesy', payload: {} });
  assert.deepEqual(scenes, [], 'wide-shot lock holds autopilot cuts');

  // The replay console (operator-driven) still wins mid-match.
  bus.emit({ type: 'replay.play', source: 'replay', payload: {} });
  assert.deepEqual(scenes, ['CG_REPLAY'], 'operator-driven events bypass the lock');

  // After the buzzer the lock releases.
  bus.emit({ type: 'match.end', source: 'cheesy' });
  scenes.length = 0;
  bus.emit({ type: 'graphic.show', source: 'cheesy', payload: {} });
  assert.deepEqual(scenes, ['CG_ARCADE'], 'lock lifts once the match ends');
});

test('a cue can be fired by hand while its autopilot is off', async () => {
  const bus = new EventBus();
  const engine = new CueEngine(bus, null);
  engine.attach();

  const scenes: string[] = [];
  bus.subscribe(ev => {
    if (ev.type === 'scene.change') scenes.push((ev.payload as { scene: string }).scene);
  });

  assert.equal(await engine.fire('result'), true);
  assert.deepEqual(scenes, ['CG_SCORE']);
  assert.equal(await engine.fire('nonexistent'), false);
});

test('missing OBS degrades rather than fails', async () => {
  const bus = new EventBus();
  // obs = null is the "switcher operator is driving manually" case. Graphics
  // must still switch; only the camera cut is lost.
  const engine = new CueEngine(bus, null);
  engine.attach();
  engine.setAll(true);

  bus.emit({ type: 'match.score_posted', source: 'cheesy' });

  assert.equal(bus.state.screen, 'score');
  assert.equal(engine.status.find(c => c.id === 'result')!.lastError, null);
});

test('a throwing cue is recorded and does not stop the others', () => {
  const bus = new EventBus();
  const engine = new CueEngine(bus, null, {
    cues: [
      { id: 'bad', name: 'Bad', does: 'throws',
        when: ev => ev.type === 'match.start',
        run: () => { throw new Error('boom'); } },
      ...defaultCues().filter(c => c.id === 'live'),
    ],
  });
  engine.attach();
  engine.setAll(true);

  bus.emit({ type: 'match.start', source: 'cheesy' });

  assert.equal(engine.status.find(c => c.id === 'bad')!.lastError, 'boom');
  assert.equal(bus.state.screen, 'match', 'the healthy cue still ran');
});

test('obs-websocket v5 auth follows the documented four steps', () => {
  // obs-websocket's protocol.md publishes the password, salt and challenge but
  // NOT the expected output; it defers to the client libraries. So rather
  // than assert a constant we cannot source, walk the four documented steps
  // independently and compare. This catches the failure modes that actually
  // happen: wrong digest, hex instead of base64, and reversed concatenation.
  const password = 'supersecretpassword';
  const salt = 'lM1GncleQOaCu9lT1yeUZhFYnqhsLLP1G5lAGo3ixaI=';
  const challenge = '+IxH4CnCiqpX1rM9scsNynZzbOe4KhDeYcTNS3PDaeY=';

  const b64secret = createHash('sha256').update(password + salt).digest('base64');
  const expected = createHash('sha256').update(b64secret + challenge).digest('base64');

  assert.equal(sign(password, salt, challenge), expected);

  // Order matters and is easy to get backwards; prove the inputs aren't
  // interchangeable.
  assert.notEqual(sign(password, challenge, salt), expected);
  assert.match(sign(password, salt, challenge), /^[A-Za-z0-9+/]{43}=$/, 'base64 sha256');
});

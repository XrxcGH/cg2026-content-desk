import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from './bus.ts';
import { EVENT_SCHEMA_VERSION, type DeskEvent } from './types.ts';

test('every event carries the envelope version and a monotonic seq', () => {
  const bus = new EventBus();
  const a = bus.emit({ type: 'graphic.show', payload: { graphic: 'x' } });
  const b = bus.emit({ type: 'graphic.hide' });

  assert.equal(a.schemaVersion, EVENT_SCHEMA_VERSION);
  assert.equal(a.seq, 1, 'seq starts at 1, so 0 reads as "not from a bus"');
  assert.equal(b.seq, 2);
  assert.ok(b.seq > a.seq, 'seq is what answers "did I miss anything"');
});

test('seq counts clock-driven events too, or a gap check would lie', () => {
  const bus = new EventBus();
  const seen: DeskEvent[] = [];
  bus.subscribe(ev => seen.push(ev));

  bus.emit({ type: 'match.loaded', payload: { id: 'q1', displayName: 'Q1', red: [], blue: [] } });
  bus.emit({ type: 'match.start' });
  // Drive the ticker past the auto boundary: those events come from advance(),
  // not from a caller, and a client counting seq must see them numbered too.
  bus.advance(Date.now() + 25_000);

  const seqs = seen.map(e => e.seq);
  assert.deepEqual(seqs, seqs.map((_, i) => i + 1),
    'no gaps and no repeats across caller-emitted and clock-emitted events');
});

test('a replayed log is renumbered on this process rather than keeping old seqs', () => {
  // Replay re-emits through emit(), so the numbers belong to the run that is
  // replaying. That is deliberate: seq answers "did THIS connection miss
  // anything", and a log's own numbering would collide with live events.
  const bus = new EventBus();
  const first = bus.emit({ type: 'graphic.show' });
  assert.equal(first.seq, 1);
  const second = bus.emit({ type: 'graphic.show' });
  assert.equal(second.seq, 2);
  assert.notEqual(first.id, second.id, 'ids stay unique regardless');
});

test('the ring can answer "what happened after seq N"', () => {
  const bus = new EventBus();
  for (let i = 0; i < 5; i++) bus.emit({ type: 'graphic.show', payload: { i } });
  const after = bus.recent.filter(e => e.seq > 3);
  assert.deepEqual(after.map(e => e.seq), [4, 5]);
});

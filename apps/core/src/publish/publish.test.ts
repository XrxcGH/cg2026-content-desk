import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULTS } from '../config.ts';
import type { EventBus } from '../bus.ts';
import { SEGMENTS, segmentDescription, segmentName } from './naming.ts';
import { PublishQueue, QC_BOUNDS, qcHold } from './queue.ts';

test('a known segment id gets the standard name, anything else stands as written', () => {
  assert.equal(segmentName('selection'), SEGMENTS.selection);
  assert.equal(segmentName('awards'), 'Awards Ceremony');
  assert.equal(segmentName("  FIRST Impact Award  "), "FIRST Impact Award");
});

test('a segment description carries no alliances and no score', () => {
  const text = segmentDescription({
    title: 'Alliance Selection - CalGames',
    note: 'Alliance 1: 254, 846, 1678',
    resultsUrl: 'https://example.org/results',
    credit: 'Uploaded by the CalGames Content Desk',
    copyright: '(c) 2026 Western Region Robotics Forum',
  });

  assert.equal(text.split('\n')[0], 'Alliance Selection - CalGames');
  assert.ok(text.includes('Alliance 1: 254, 846, 1678'));
  assert.ok(!/\bRed \(Teams/.test(text));
  assert.ok(!/\bBlue \(Teams/.test(text));
});

test('QC bounds differ by kind, so a ceremony is not held for being long', () => {
  // The failure this exists to catch: a truncated match video.
  assert.ok(qcHold('match', 11), 'an 11 second match cut must be held');
  assert.ok(qcHold('match', 1800), 'a 30 minute match cut must be held');
  assert.equal(qcHold('match', 210), null, 'a normal match passes');

  // A 40 minute awards ceremony is exactly right, and the match bounds
  // would have held every single one of them.
  assert.equal(qcHold('segment', 40 * 60), null);
  assert.ok(qcHold('segment', 5), 'a five second ceremony is still wrong');
  assert.ok(qcHold('segment', 3 * 3600), 'three hours means the operator forgot to stop');
});

test('every publish kind has bounds, so no kind can skip the check', () => {
  for (const [kind, bounds] of Object.entries(QC_BOUNDS)) {
    assert.ok(bounds.minSec > 0, `${kind} has no lower bound`);
    assert.ok(bounds.maxSec > bounds.minSec, `${kind} bounds are inverted`);
  }
});

test('the hold reason tells the operator what to do about it', () => {
  const reason = qcHold('match', 11)!;
  assert.match(reason, /11s/);
  assert.match(reason, /60-900s/);
  assert.match(reason, /release/i);
});

test('release marks items released and the flag survives a restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pubq-'));
  // enabled=false keeps the worker inert, so nothing touches the network.
  const cfg = structuredClone(DEFAULTS);
  cfg.publish.enabled = false;
  cfg.publish.mode = 'deferred';
  const bus = { emit: () => {} } as unknown as EventBus;

  try {
    const q = new PublishQueue(root, cfg, bus, null);
    await q.load();
    const item = await q.add({
      kind: 'segment', label: 'Awards Ceremony', sourceId: 'program',
      ranges: [{ fromMs: 0, toMs: 120_000 }], matchKey: null,
      meta: { title: 'Awards Ceremony - CalGames', description: '' },
    }, 'QC hold: test');
    // A flagged item must enter the queue already held. Holding it a moment
    // after adding left a window where a running worker picked it up.
    assert.equal(item.state, 'held');
    item.clipPath = join(root, 'clip.mp4');

    assert.equal(await q.release(), 1);
    assert.equal(item.state, 'cut');
    assert.equal(item.released, true,
      'without the durable flag the cut branch re-parks the item on the spot');

    // Let the kicked worker settle before reading the file back, so the
    // restart below sees whatever it last persisted.
    await new Promise(r => setTimeout(r, 400));

    // Restart. The go-ahead must come back from disk, or an overnight crash
    // would silently re-park everything the operator already released.
    const q2 = new PublishQueue(root, cfg, bus, null);
    await q2.load();
    assert.equal(q2.items[0]?.released, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

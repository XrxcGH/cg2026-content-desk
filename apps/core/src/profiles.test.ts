import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProfileBook } from './profiles.ts';
import { reduce } from './state.ts';
import { initialState, type DeskEvent, type DeskState, type PanelState } from './types.ts';

const scratch = async (): Promise<string> => mkdtemp(join(tmpdir(), 'cg-profiles-'));

test('the book remembers anyone put on air, once', async () => {
  const dir = await scratch();
  try {
    const book = new ProfileBook(dir);
    await book.load();

    const first = await book.resolve([
      { name: 'Priya Raman', role: 'Analyst' },
      { name: 'Marcus Webb', role: 'Play-by-play' },
    ]);
    assert.equal(first.length, 2);
    assert.equal(book.list.length, 2);

    // The same two people again must not mint two more profiles: the whole
    // point is that the second segment is a checklist.
    await book.resolve([
      { name: 'Priya Raman', role: 'Analyst' },
      { name: 'Marcus Webb', role: 'Play-by-play' },
    ]);
    assert.equal(book.list.length, 2);
    assert.equal(book.list.find(p => p.name === 'Priya Raman')?.uses, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the same name on a different team is a different person', async () => {
  const dir = await scratch();
  try {
    const book = new ProfileBook(dir);
    await book.resolve([{ name: 'Alex', role: 'Drive coach', team: 254 }]);
    await book.resolve([{ name: 'Alex', role: 'Drive coach', team: 1678 }]);
    assert.equal(book.list.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a role typed at the desk wins: the same person changes hats', async () => {
  const dir = await scratch();
  try {
    const book = new ProfileBook(dir);
    const [made] = await book.resolve([{ name: 'Dana Okafor', role: 'Analyst' }]);
    await book.resolve([{ id: made!.id, name: 'Dana Okafor', role: 'Drive coach' }]);
    assert.equal(book.get(made!.id)?.role, 'Drive coach');
    assert.equal(book.list.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the book survives a restart, most-recently-used first', async () => {
  const dir = await scratch();
  try {
    const first = new ProfileBook(dir);
    await first.resolve([{ name: 'Older', role: 'Analyst' }]);
    await new Promise(r => setTimeout(r, 5));
    await first.resolve([{ name: 'Newer', role: 'Host' }]);

    const reopened = new ProfileBook(dir);
    await reopened.load();
    assert.deepEqual(reopened.list.map(p => p.name), ['Newer', 'Older']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The panel on the state snapshot
// ---------------------------------------------------------------------------

const ev = (type: string, payload: unknown): DeskEvent => ({
  id: 'x', seq: 0, ts: Date.now(), matchClock: null,
  source: 'manual', confidence: 'authoritative',
  type: type as DeskEvent['type'], payload,
});

const panelOf = (s: DeskState): PanelState | null => s.panel;

test('panel.show keeps the order it was given: seat one is screen left', () => {
  const after = reduce(initialState(), ev('panel.show', {
    title: 'Match preview',
    people: [
      { name: 'A', role: 'Analyst' },
      { name: 'B', role: 'Play-by-play' },
      { name: 'C', role: 'Drive coach', team: 254 },
    ],
  }));
  assert.deepEqual(panelOf(after)?.people.map(p => p.name), ['A', 'B', 'C']);
  assert.equal(panelOf(after)?.people[2]?.team, 254);
  assert.equal(panelOf(after)?.title, 'Match preview');
});

test('a nameless entry is dropped, and an empty panel is a hide', () => {
  const blank = reduce(initialState(), ev('panel.show', { people: [{ name: '  ' }] }));
  assert.equal(panelOf(blank), null, 'a panel of nobody must not leave a plate on air');

  const up = reduce(initialState(), ev('panel.show', { people: [{ name: 'A', role: 'Analyst' }] }));
  assert.equal(panelOf(up)?.people.length, 1);
  assert.equal(panelOf(reduce(up, ev('panel.hide', {}))), null);
});

test('a junk team number becomes null rather than reaching the graphic', () => {
  const after = reduce(initialState(), ev('panel.show', {
    people: [{ name: 'A', role: 'Analyst', team: 'not a number' }],
  }));
  assert.equal(panelOf(after)?.people[0]?.team, null);
});

test('the panel title falls back rather than rendering an empty band', () => {
  const after = reduce(initialState(), ev('panel.show', { people: [{ name: 'A' }] }));
  assert.equal(panelOf(after)?.title, 'Analysis desk');
});

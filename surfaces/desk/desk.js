/**
 * Desk console. The P0 ship criterion: a producer, a switcher op and an
 * analyst can run a full match from here with every integration dead.
 *
 * Keyboard-first, because the producer is watching program, not their hands.
 */

import { connect, clockDisplay, phaseAt, PHASE_LABEL, startTicker } from '/shared/desk-client.js';

const $ = id => document.getElementById(id);
const desk = connect('desk');

// ---- connection ------------------------------------------------------------
desk.on('link', up => {
  $('dot').dataset.up = String(up);
  $('linkText').textContent = up ? 'core connected' : 'reconnecting…';
});

// ---- live readout ----------------------------------------------------------
desk.on('state', s => {
  $('nRed').textContent = s.score.red.total;
  $('nBlue').textContent = s.score.blue.total;
  $('nMatch').textContent = s.match
    ? `${s.match.displayName} · screen: ${s.screen} · ${s.confidence}`
    : 'No match loaded';
  $('nRedTeams').textContent = (s.match?.red ?? []).map(t => t.number).join(' · ') || '—';
  $('nBlueTeams').textContent = (s.match?.blue ?? []).map(t => t.number).join(' · ') || '—';
});

startTicker(() => {
  const c = desk.matchClock;
  $('nClock').textContent = clockDisplay(c);
  $('nPhase').textContent = PHASE_LABEL[phaseAt(c)] ?? '';
});

// ---- event log -------------------------------------------------------------
desk.on('desk', ev => {
  const row = document.createElement('div');
  const t = new Date(ev.ts).toLocaleTimeString('en-US', { hour12: false });
  row.innerHTML = `<span class="t">${t}</span><span><span class="ty">${ev.type}</span> ` +
    `<span style="opacity:.6">${ev.source}</span></span>`;
  $('log').prepend(row);
  while ($('log').children.length > 120) $('log').lastChild.remove();
});

// ---- actions ---------------------------------------------------------------
const emit = (type, payload) => desk.emit({ type, payload });

for (const b of document.querySelectorAll('[data-emit]')) {
  b.onclick = () => emit(b.dataset.emit);
}
for (const b of document.querySelectorAll('[data-screen]')) {
  b.onclick = () => emit('screen.change', { screen: b.dataset.screen });
}
for (const b of document.querySelectorAll('[data-score]')) {
  b.onclick = () => score(b.dataset.score);
}

/** Shadow scoring publishes at `estimated` — the overlay renders it outlined. */
function score(spec) {
  const [alliance, field, amount] = spec.split(':');
  desk.emit({
    type: 'score.delta',
    confidence: 'estimated',
    payload: { alliance, field, amount: Number(amount) },
  });
}

function showThird(pinned) {
  emit('lower_third.show', {
    line1: $('t1').value || $('t1').placeholder,
    line2: $('t2').value || $('t2').placeholder,
    pinned,
  });
}
$('thirdShow').onclick = () => showThird(false);
$('thirdPin').onclick = () => showThird(true);
$('thirdHide').onclick = () => emit('lower_third.hide');

const teamList = str => str.trim().split(/\s+/).filter(Boolean)
  .map(n => ({ number: Number(n), name: '' }));

$('loadMatch').onclick = () => {
  emit('match.loaded', {
    id: `m${Date.now()}`,
    displayName: $('mName').value || 'Match',
    red: teamList($('mRed').value),
    blue: teamList($('mBlue').value),
  });
};

// ---- telestrator -----------------------------------------------------------
const teleFrame = (frame) => emit('telestrator.frame', {
  analyst: $('analyst').value || $('analyst').placeholder,
  frame,
});
$('teleSend').onclick = () => teleFrame($('frame').value || null);
$('teleLive').onclick = () => teleFrame(desk.state?.telestrator?.frame ?? null);
$('teleClear').onclick = () => emit('telestrator.clear');
$('teleHide').onclick = () => emit('telestrator.hide');

// ---- replay markers --------------------------------------------------------
$('mark').onclick = () => mark();

function mark() {
  // Back-date by 2s: by the time a human presses the button, the moment has
  // already passed.
  const at = (desk.matchClock ?? 0) - 2;
  desk.emit({ type: 'replay.marker', payload: { kind: 'manual', matchClock: at } });
  const line = document.createElement('div');
  line.textContent = `▲ manual · ${clockDisplay(at)} (${at.toFixed(1)}s)`;
  $('markers').prepend(line);
  while ($('markers').children.length > 12) $('markers').lastChild.remove();
}

// ---- keyboard --------------------------------------------------------------
const KEYS = {
  '1': () => emit('match.preview'),
  '2': () => emit('match.prestart'),
  '3': () => emit('match.start'),
  '4': () => emit('match.end'),
  '5': () => emit('match.score_posted'),
  '0': () => emit('match.aborted'),
  'b': () => emit('screen.change', { screen: 'blank' }),
  't': () => showThird(false),
  'y': () => emit('lower_third.hide'),
  'q': () => score('red:fuel:1'),
  'w': () => score('red:fuel:5'),
  'e': () => score('red:tower:10'),
  'a': () => score('blue:fuel:1'),
  's': () => score('blue:fuel:5'),
  'd': () => score('blue:tower:10'),
  ' ': () => mark(),
};

addEventListener('keydown', e => {
  // Never steal keys from a field the operator is typing in.
  if (e.target.matches('input, select, textarea')) return;
  const fn = KEYS[e.key.toLowerCase()];
  if (!fn) return;
  e.preventDefault();
  fn();
});

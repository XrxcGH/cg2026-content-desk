/**
 * Desk console. The P0 ship criterion: a producer, a switcher op and an
 * analyst can run a full match from here with every integration dead.
 *
 * Keyboard-first, because the producer is watching program, not their hands.
 */

import {
  connect, clockDisplay, clockDisplayFor, phaseFor, PHASE_LABEL, startTicker,
} from '/shared/desk-client.js';

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
  // Keep the manual-take dropdown honest about what program is showing, but
  // never yank it out from under an operator who is mid-choice.
  if (document.activeElement !== $('screenSel')
      && [...$('screenSel').options].some(o => o.value === s.screen)) {
    $('screenSel').value = s.screen;
  }
  $('nMatch').textContent = s.match
    ? `${s.match.displayName} · screen: ${s.screen} · ${s.confidence}`
    : 'No match loaded';
  $('nRedTeams').textContent = (s.match?.red ?? []).map(t => t.number).join(' · ') || '-';
  $('nBlueTeams').textContent = (s.match?.blue ?? []).map(t => t.number).join(' · ') || '-';
});

startTicker(() => {
  const c = desk.matchClock;
  $('nClock').textContent = clockDisplayFor(desk.state, c);
  $('nPhase').textContent = PHASE_LABEL[phaseFor(desk.state, c)] ?? '';
});

// ---- event log -------------------------------------------------------------
// Built with textContent, never innerHTML: type and source arrive over the WS
// from any client on the production LAN and must render as text, not markup.
desk.on('desk', ev => {
  const row = document.createElement('li');
  const t = document.createElement('span');
  t.className = 't';
  t.textContent = new Date(ev.ts).toLocaleTimeString('en-US', { hour12: false });
  const what = document.createElement('span');
  const ty = document.createElement('span');
  ty.className = 'ty';
  ty.textContent = ev.type;
  const src = document.createElement('span');
  src.style.opacity = '.6';
  src.textContent = ` ${ev.source}`;
  what.append(ty, src);
  row.append(t, what);
  $('log').prepend(row);
  while ($('log').children.length > 120) $('log').lastChild.remove();
});

// ---- actions ---------------------------------------------------------------
const emit = (type, payload) => desk.emit({ type, payload });

for (const b of document.querySelectorAll('[data-emit]')) {
  b.onclick = () => emit(b.dataset.emit);
}
for (const b of document.querySelectorAll('[data-score]')) {
  b.onclick = () => score(b.dataset.score);
}

// Manual screen take. The lifecycle buttons drive screens on their own; this
// is the override for everything else: analysis segments, the arcade bumper,
// or recovering from a state the automation didn't expect.
$('screenTake').onclick = () => emit('screen.change', { screen: $('screenSel').value });

// ---- status card -----------------------------------------------------------
// One press puts the "why we're waiting" card up; minutes are optional.
function showStatus(kind, message) {
  const min = Number($('statusMin').value);
  emit('status.show', {
    kind, message,
    backAt: min > 0 ? Date.now() + min * 60_000 : null,
  });
}
for (const b of document.querySelectorAll('[data-status]')) {
  b.onclick = () => {
    const [kind, message] = b.dataset.status.split(/:(.+)/);
    showStatus(kind, message);
  };
}
$('statusShowCustom').onclick = () => {
  const message = $('statusCustom').value.trim();
  if (message) showStatus('custom', message);
};
$('statusClear').onclick = () => { emit('status.hide'); $('statusMin').value = ''; };

/** Shadow scoring publishes at `estimated`. The overlay renders it outlined. */
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
  '2': () => emit('match.armed'),
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

// ---- publish a segment -----------------------------------------------------
// Alliance selection and the ceremonies are the parts of the day teams ask for
// and nobody records. Nothing on the bus knows when a ceremony began, so the
// operator marks both ends by hand.
let segFrom = null;

$('segStart').onclick = () => {
  segFrom = Date.now();
  $('segQueue').disabled = false;
  $('segState').textContent = `Marking since ${new Date(segFrom).toLocaleTimeString()}.`;
};

$('segQueue').onclick = async () => {
  if (segFrom === null) return;
  const segment = $('segKind').value;
  $('segQueue').disabled = true;
  try {
    const res = await fetch('/api/publish/segment', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ segment, fromMs: segFrom, toMs: Date.now() }),
    });
    const item = await res.json();
    if (!res.ok) throw new Error(item.error ?? `HTTP ${res.status}`);
    $('segState').textContent = item.state === 'held'
      ? `${item.label} queued and held: ${item.error}`
      : `${item.label} queued.`;
    segFrom = null;
  } catch (err) {
    $('segState').textContent = err.message;
    $('segQueue').disabled = false;
  }
};

// ---- day VOD chapters ------------------------------------------------------
$('chapMake').onclick = async () => {
  const params = new URLSearchParams();
  // A bare time means today: the stream and the desk are always the same day.
  if ($('chapStart').value) {
    const [h, m, s] = $('chapStart').value.split(':').map(Number);
    const d = new Date();
    d.setHours(h ?? 0, m ?? 0, s ?? 0, 0);
    params.set('startedAt', String(d.getTime()));
  }
  try {
    const res = await fetch(`/api/chapters?${params}`);
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    $('chapText').style.display = body.usable ? 'block' : 'none';
    $('chapText').value = body.text;
    $('chapState').textContent = body.usable
      ? `${body.chapters.length} chapters from ${new Date(body.startedAt).toLocaleTimeString()}. Select all and copy.`
      : 'Not enough yet. YouTube ignores a list under three chapters, so this stays empty until there are.';
  } catch (err) {
    $('chapText').style.display = 'none';
    $('chapState').textContent = err.message;
  }
};

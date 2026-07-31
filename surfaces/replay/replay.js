/**
 * Replay console.
 *
 * The timeline is the MATCH CLOCK, phase-segmented, not a raw video scrubber.
 * The operator thinks in "endgame", not "18:42:07", and every marker is already
 * placed, so the job is choosing rather than hunting.
 */

import { connect, startTicker, clockDisplay, REBUILT } from '/shared/desk-client.js';

const $ = id => document.getElementById(id);
const desk = connect('replay');

const T0 = REBUILT.AUTO_START;          // -20
const T1 = REBUILT.MATCH_END;           // 140
const SPAN = T1 - T0;                   // 160s of match clock

const PHASES = [
  ['auto', 'Auto', T0, 0],
  ['transition', 'Trans', 0, REBUILT.TRANSITION_END],
  ['shift1', 'Shift 1', 10, 35], ['shift2', 'Shift 2', 35, 60],
  ['shift3', 'Shift 3', 60, 85], ['shift4', 'Shift 4', 85, 110],
  ['endgame', 'Endgame', REBUILT.ENDGAME_START, T1],
];

$('phases').innerHTML = PHASES.map(([id, label, a, b]) =>
  `<div data-p="${id}" style="flex:${b - a}">${label}</div>`).join('');

const TICK_CLOCKS = [-20, 0, 30, 60, 90, 120, 140];
// The first and last labels are anchored to the track's own edges (see CSS):
// centering them, like the ones in between, would hang half the label past
// the end of the timeline.
$('ticks').innerHTML = TICK_CLOCKS.map((c, i) => {
  const edge = i === 0 ? ' data-align="start"' : i === TICK_CLOCKS.length - 1 ? ' data-align="end"' : '';
  return `<span style="left:${pct(c)}%"${edge}>${clockDisplay(c)}</span>`;
}).join('');

function pct(clock) { return ((clock - T0) / SPAN) * 100; }

// ---- state ----------------------------------------------------------------
let markers = [];
let inClock = null;
let outClock = null;
let lastClip = null;

/** Match clock -> wall ms. Exact, because match start is a logged timestamp. */
function wallAt(clock) {
  const started = desk.state?.matchStartedAt ?? desk.state?.lastMatchStartedAt;
  return started ? started + (clock - T0) * 1000 : null;
}

function setBounds(a, b) {
  inClock = Math.max(T0, Math.min(T1, a));
  outClock = Math.max(inClock + 1, Math.min(T1 + 20, b));
  paintSelection();
}

function paintSelection() {
  const sel = $('sel');
  if (inClock === null) { sel.style.display = 'none'; $('bounds').textContent = 'in - · out - · -'; return; }
  sel.style.display = 'block';
  sel.style.left = `${pct(inClock)}%`;
  sel.style.width = `${Math.max(0.4, pct(outClock) - pct(inClock))}%`;
  $('bounds').textContent =
    `in ${clockDisplay(inClock)} · out ${clockDisplay(outClock)} · ${(outClock - inClock).toFixed(1)}s`;
}

// ---- timeline interaction --------------------------------------------------
$('track').addEventListener('pointerdown', e => {
  const r = $('track').getBoundingClientRect();
  const clock = T0 + ((e.clientX - r.left) / r.width) * SPAN;
  setBounds(clock, clock + 10);
});

function paintMarkers() {
  const track = $('track');
  for (const el of document.querySelectorAll('.mk')) el.remove();
  for (const m of markers) {
    if (m.matchClock === null || m.matchClock === undefined) continue;
    const el = document.createElement('div');
    el.className = 'mk';
    el.dataset.pri = String(m.priority ?? 2);
    if (m.alliance) el.dataset.a = m.alliance;
    el.dataset.label = m.label;
    el.style.left = `${pct(m.matchClock)}%`;
    // Keyboard-reachable: an operator tabbing through the page (or a screen
    // reader) can jump to a marker the same way a mouse click does.
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
    el.setAttribute('aria-label', `Frame ${m.label} at ${clockDisplay(m.matchClock)}`);
    // Frame the marker: enough lead-in to see the build-up, enough tail to see
    // the result. A human hits the button late, so the marker itself already
    // sits 2s back (see the desk console).
    const frameMarker = () => setBounds(m.matchClock - 6, m.matchClock + 4);
    el.onclick = ev => { ev.stopPropagation(); frameMarker(); };
    el.addEventListener('keydown', ev => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      ev.preventDefault();
      // Stop this Enter from also reaching the page-level shortcut (Enter = Cut
      // clip): the marker's own Enter means "frame this marker", not "cut now".
      ev.stopPropagation();
      frameMarker();
    });
    track.parentElement.appendChild(el);
  }

  $('markers').innerHTML = markers.length
    ? [...markers].reverse().map(m =>
        `<div style="padding:4px 0;border-bottom:1px solid var(--surface-sunken)">
           <b>${m.label}</b>
           <span class="mono"> ${m.matchClock === null ? '-' : clockDisplay(m.matchClock)}</span>
         </div>`).join('')
    : '<i>None yet. They appear as the match runs.</i>';
}

async function loadMarkers() {
  try {
    markers = await fetch('/api/markers').then(r => r.json());
    paintMarkers();
  } catch { /* transient */ }
}

// ---- sources ---------------------------------------------------------------
async function loadSources() {
  try {
    const rec = await fetch('/api/recorder').then(r => r.json());
    $('encoder').textContent = rec.available ? `encoder: ${rec.encoder}` : 'recording unavailable';
    $('src').innerHTML = rec.sources.length
      ? rec.sources.map(s => `<option value="${s.id}">${s.label}${s.running ? '' : ' (down)'}</option>`).join('')
      : '<option value="program">program</option>';
  } catch {
    $('src').innerHTML = '<option value="program">program</option>';
  }
}

// ---- actions ---------------------------------------------------------------
const say = (msg, isErr = false) => {
  const el = $('status');
  el.textContent = msg;
  el.toggleAttribute('data-err', isErr);
};

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? 'Request failed');
  return json;
}

async function cut() {
  if (inClock === null) return say('Pick an in-point on the timeline first.', true);
  const fromMs = wallAt(inClock), toMs = wallAt(outClock);
  if (!fromMs) return say('No match start recorded yet: nothing to map the clock onto.', true);

  say('Cutting…');
  try {
    const clip = await post('/api/clips', {
      sourceId: $('src').value,
      ranges: [{ fromMs, toMs }],
      speed: Number($('speed').value),
      label: `${desk.state?.match?.displayName ?? 'clip'}-${clockDisplay(inClock).replace(':', '')}`,
    });
    showClip(clip);
    say(`Ready · ${clip.seconds.toFixed(1)}s`);
  } catch (err) { say(err.message, true); }
}

async function cutMatch() {
  say('Cutting full match video…');
  try {
    const clip = await post('/api/clips/match', { sourceId: $('src').value });
    showClip(clip);
    say(`Match video ready · ${clip.seconds.toFixed(1)}s · ${clip.parts} part(s)` +
      (clip.parts > 1 ? ' (referee delay cut out)' : ''));
  } catch (err) { say(err.message, true); }
}

function showClip(clip) {
  lastClip = clip;
  $('preview').src = clip.url;
  $('clipsEmpty')?.remove();
  const row = document.createElement('div');
  row.innerHTML = `<a href="${clip.url}" target="_blank">${clip.label}</a>` +
    `<span class="mono">${clip.seconds.toFixed(1)}s${clip.speed !== 1 ? ` ${clip.speed}×` : ''}</span>`;
  $('clips').prepend(row);
  while ($('clips').children.length > 12) $('clips').lastChild.remove();
}

async function sendFrame() {
  if (!lastClip) return say('Cut a clip first, then pause on the frame you want.', true);
  // The frame the operator is actually looking at, mapped back to wall clock.
  const atMs = lastClip.ranges[0].fromMs + ($('preview').currentTime * 1000 * (lastClip.speed ?? 1));
  say('Sending frame…');
  try {
    await post('/api/frame', { sourceId: lastClip.sourceId, atMs: Math.round(atMs) });
    say('Frame sent to the analyst.');
  } catch (err) { say(err.message, true); }
}

function take() {
  if (!lastClip) return say('Nothing cut yet.', true);
  desk.emit({ type: 'replay.play', payload: lastClip });
  say('Sent to program.');
}

$('cut').onclick = cut;
$('cutMatch').onclick = cutMatch;
$('send').onclick = sendFrame;
$('take').onclick = take;

for (const b of document.querySelectorAll('[data-nudge]')) {
  b.onclick = () => {
    const [edge, delta] = b.dataset.nudge.split(':');
    if (inClock === null) return;
    if (edge === 'in') setBounds(inClock + Number(delta), outClock);
    else setBounds(inClock, outClock + Number(delta));
  };
}

addEventListener('keydown', e => {
  if (e.target.matches('input, select, textarea, video')) return;
  if (e.key === 'Enter') { e.preventDefault(); cut(); }
  if (e.key.toLowerCase() === 'f') { e.preventDefault(); sendFrame(); }
  if (e.key.toLowerCase() === 't') { e.preventDefault(); take(); }
});

// ---- live wiring -----------------------------------------------------------
desk.on('link', up => {
  $('dot').dataset.up = String(up);
  $('linkText').textContent = up ? 'linked' : 'reconnecting…';
  if (up) { loadSources(); loadMarkers(); }
});

desk.on('state', s => {
  $('matchName').textContent = s.match?.displayName ?? 'No match loaded';
});

desk.on('replay.marker', () => loadMarkers());
desk.on('match.loaded', () => { markers = []; paintMarkers(); setBounds(T0, T0 + 10); });

// Playhead follows the live match.
startTicker(() => {
  const c = desk.matchClock;
  const head = $('playhead');
  if (c === null || c < T0 || c > T1) { head.style.display = 'none'; return; }
  head.style.display = 'block';
  head.style.left = `${pct(c)}%`;
});

loadSources();
loadMarkers();
paintSelection();

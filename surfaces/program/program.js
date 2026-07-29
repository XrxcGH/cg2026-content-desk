/**
 * Program overlay — the whole broadcast graphic in one Browser Source.
 *
 * Screens switch on `state.screen`, so the switcher operator never has to
 * change sources mid-show. One URL in OBS, all weekend.
 */

import {
  connect, applyDisplayMode, roll, restart, startTicker,
  clockDisplay, hubActiveAt, phaseAt, PHASE_LABEL, REBUILT,
} from '/shared/desk-client.js';

applyDisplayMode();
const $ = id => document.getElementById(id);
const desk = connect('program');

// ---- stage fitting --------------------------------------------------------
const stage = $('stage');
const fit = () => {
  const s = Math.min(innerWidth / 1920, innerHeight / 1080);
  stage.style.transform = `translate(-50%, -50%) scale(${s})`;
};
addEventListener('resize', fit); fit();

// ---- screens --------------------------------------------------------------
const SCREENS = ['overview', 'match', 'score', 'blank'];
let currentScreen = null;

function showScreen(name) {
  if (!SCREENS.includes(name)) name = 'blank';
  if (name === currentScreen) return;
  const first = currentScreen === null;
  currentScreen = name;

  const paint = () => {
    for (const s of SCREENS) $(`scr-${s}`).toggleAttribute('data-active', s === name);
  };

  if (first) { paint(); return; }
  // Gold Sweep: swap behind the bar at its midpoint.
  restart($('sweep'));
  const half = parseFloat(getComputedStyle(document.documentElement)
    .getPropertyValue('--dur-sweep')) / 2 || 240;
  setTimeout(paint, half);
}

// ---- alliance overview ----------------------------------------------------
function robotCard(team, i) {
  const media = desk.mediaFor(team.number);
  const art = media
    ? `<div class="robot-art"><img src="${media.src}" alt=""></div>`
    // Fallback must look deliberate — most teams won't have a photo.
    : `<div class="robot-art"><div class="robot-art--fallback"><span class="num">${team.number}</span></div></div>`;
  return `<div class="robot reveal reveal--up" style="--i:${i}">
    ${art}
    <div class="robot-shadow"></div>
    <div class="robot-num num">${team.number}</div>
    <div class="robot-name">${escapeHtml(team.name ?? '')}</div>
  </div>`;
}

function buildOverview(match) {
  if (!match) return;
  $('ovLabel').textContent = match.displayName ?? '';
  $('redRobots').innerHTML = (match.red ?? []).map(robotCard).join('');
  $('blueRobots').innerHTML = (match.blue ?? []).map(robotCard).join('');
}

// ---- score bar ------------------------------------------------------------
const RP_KEYS = ['energized', 'supercharged', 'traversal'];
for (const side of ['red', 'blue']) {
  $(`${side}Pips`).innerHTML = RP_KEYS
    .map(k => `<span class="pip" data-rp="${k}" title="${k}"></span>`).join('');
}

function paintScore(state) {
  const est = state.confidence === 'estimated';
  for (const side of ['red', 'blue']) {
    const s = state.score[side];
    roll($(`${side}Fuel`), s.fuel);
    roll($(`${side}Tower`), s.tower);
    roll($(`${side}Total`), s.total);
    $(`${side}Total`).dataset.est = String(est);
    const pips = $(`${side}Pips`).children;
    RP_KEYS.forEach((k, i) => { pips[i].dataset.earned = String(!!s.rp[k]); });
  }
}

function paintTeams(match) {
  if (!match) return;
  $('redTeams').innerHTML = (match.red ?? []).map(t => t.number).join('<br>');
  $('blueTeams').innerHTML = (match.blue ?? []).map(t => t.number).join('<br>');
}

function paintFinal(state) {
  const r = state.score.red.total, b = state.score.blue.total;
  $('finalRed').textContent = r;
  $('finalBlue').textContent = b;
  $('finalRedLabel').classList.toggle('final-win', r > b);
  $('finalBlueLabel').classList.toggle('final-win', b > r);
}

// ---- lower third ----------------------------------------------------------
let thirdTimer = null;
function paintThird(lt) {
  const el = $('third');
  clearTimeout(thirdTimer);

  if (!lt) {
    if (!el.hasAttribute('data-show')) return;
    el.className = 'lower-third third--exit';
    const out = parseFloat(getComputedStyle(document.documentElement)
      .getPropertyValue('--dur-out')) || 260;
    setTimeout(() => el.removeAttribute('data-show'), out);
    return;
  }

  $('thirdT1').textContent = lt.line1 ?? '';
  $('thirdT2').textContent = lt.line2 ?? '';
  el.setAttribute('data-show', '');
  el.className = 'lower-third third';

  // Nothing stays up forever waiting on an operator who is busy.
  if (!lt.pinned) {
    const dwell = parseFloat(getComputedStyle(document.documentElement)
      .getPropertyValue('--dwell')) || 8000;
    thirdTimer = setTimeout(() => paintThird(null), dwell);
  }
}

// ---- local clock, derived every frame -------------------------------------
startTicker(() => {
  const st = desk.state;
  if (!st) return;

  const c = desk.matchClock;
  $('clock').textContent = clockDisplay(c);
  const phase = phaseAt(c);
  $('phase').textContent = PHASE_LABEL[phase] ?? phase;

  const hub = hubActiveAt(c, st.autoWinner, st.hubAuthoritative);
  $('hub').dataset.on = hub;
  $('hubText').textContent = hub === 'both' ? 'Both hubs live'
    : hub === 'none' ? '' : `${hub} hub live`;

  // Endgame: suppress decorative motion, keep score and clock running.
  document.documentElement.toggleAttribute('data-lockdown',
    c !== null && c >= REBUILT.ENDGAME_START && c < REBUILT.MATCH_END);
});

// ---- wiring ---------------------------------------------------------------
let lastMatchId = null;

desk.on('state', state => {
  if (state.match?.id !== lastMatchId) {
    lastMatchId = state.match?.id ?? null;
    buildOverview(state.match);
    paintTeams(state.match);
  }
  paintScore(state);
  if (state.screen === 'score') paintFinal(state);
  paintThird(state.lowerThird);
  showScreen(state.screen);
});

// Media can land after the overview was built — rebuild so a photo uploaded
// on Sunday morning appears without anyone reloading the Browser Source.
desk.on('ready', () => { buildOverview(desk.state?.match); });

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

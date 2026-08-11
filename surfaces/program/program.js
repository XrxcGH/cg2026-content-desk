/**
 * Program overlay: the whole broadcast graphic in one Browser Source.
 *
 * Screens switch on `state.screen`, so the switcher operator never has to
 * change sources mid-show. One URL in OBS, all weekend.
 */

import {
  connect, applyDisplayMode, fitStage, roll, restart, startTicker,
  clockDisplayFor, hubActiveAt, phaseFor, PHASE_LABEL, REBUILT,
} from '/shared/desk-client.js';
import { rpStrip } from '/shared/rp.js';
import { allianceRoster } from '/shared/alliance.js';

const params = applyDisplayMode();
// ?mode=clean is the second-stream variant: minimal score bar and clock over a
// static full-field camera, locked to the match layout. No screen switching,
// no lower thirds, no status cards. See docs/11 "The second stream".
const CLEAN = params.get('mode') === 'clean';
const $ = id => document.getElementById(id);
const desk = connect(CLEAN ? 'program-clean' : 'program');

// ---- stage fitting --------------------------------------------------------
fitStage($('stage'));

// ---- screens --------------------------------------------------------------
const SCREENS = [
  'overview', 'match', 'score', 'analysis', 'arcade', 'selection', 'explain', 'blank',
];
let currentScreen = null;

function showScreen(name) {
  if (!SCREENS.includes(name)) name = 'blank';
  if (name === currentScreen) return;
  const first = currentScreen === null;
  currentScreen = name;

  const paint = () => {
    for (const s of SCREENS) $(`scr-${s}`).toggleAttribute('data-active', s === name);
  };

  // The explainer only advances while it is the live screen. Nothing is more
  // confusing than a loop that jumps mid-card because it kept counting.
  runExplainer(name === 'explain');

  if (first) { paint(); return; }
  // Gold Sweep: swap behind the bar at its midpoint.
  restart($('sweep'));
  const half = parseFloat(getComputedStyle(document.documentElement)
    .getPropertyValue('--dur-sweep')) / 2 || 240;
  setTimeout(paint, half);
}

// ---- explainer loop -------------------------------------------------------
/**
 * For the parent who arrived twenty minutes ago.
 *
 * The most repeated newcomer complaint is that nobody ever says what the
 * numbers mean: you can watch a full match without learning what fuel is, or
 * why the alliance that scored fewer points is celebrating. These run in the
 * gaps, one idea per card, in the same words the announcer uses.
 *
 * Deliberately not a glossary dump. Six cards, twelve seconds each, so a card
 * is readable from the back of the gym and the loop comes round often enough
 * that nobody has to catch it from the start.
 */
const EXPLAINERS = [
  {
    chip: 'How to watch',
    title: 'Two alliances, three teams each',
    // Red and blue stay unemphasized on purpose: the accent here is gold, and
    // gold on the words "red" and "blue" reads as a third alliance color.
    body: 'Six robots on the field, red against blue, three teams a side. '
      + 'The teams were paired at random for this match, so today\'s opponent is '
      + 'tomorrow\'s teammate.',
  },
  {
    chip: 'The clock',
    title: 'Twenty seconds on their own',
    body: 'Every match opens with <b>autonomous</b>: no drivers, just code the students '
      + 'wrote. Then the drivers pick up the controls for the rest of it.',
  },
  {
    chip: 'Scoring',
    title: 'Fuel and tower',
    body: '<b>Fuel</b> is the scoring game piece, and it only counts while your hub is '
      + 'live. <b>Tower</b> points come from climbing at the end. Both are on the bar '
      + 'at the bottom of the screen.',
  },
  {
    chip: 'Scoring',
    title: 'Only one hub is live at a time',
    body: 'The hubs alternate through the match. Scoring into a hub that is not lit '
      + 'earns <b>nothing</b>. Watch which alliance the field is favoring right now.',
  },
  {
    chip: 'Why they cheer',
    title: 'Winning is not the only prize',
    body: 'Alliances also chase <b>ranking points</b> for hitting targets. That is why '
      + 'a team that just lost might still be celebrating. The badges on the score bar '
      + 'show how close each one is.',
  },
  {
    chip: 'Come say hi',
    title: 'The pits are open',
    body: 'Every robot here was built by students in about six weeks. They are happy to '
      + 'show you how it works, and the pits are open all day.',
  },
];

const EXPLAINER_MS = 12_000;
let explainerAt = 0;
let explainerTimer = null;

function paintExplainer() {
  const card = EXPLAINERS[explainerAt % EXPLAINERS.length];
  $('expChip').textContent = card.chip;
  $('expTitle').textContent = card.title;
  $('expBody').innerHTML = card.body;
  $('expDots').innerHTML = EXPLAINERS
    .map((_, i) => `<span${i === explainerAt % EXPLAINERS.length ? ' data-on' : ''}></span>`).join('');
}

function runExplainer(on) {
  clearInterval(explainerTimer);
  explainerTimer = null;
  if (!on) return;
  paintExplainer();
  explainerTimer = setInterval(() => { explainerAt++; paintExplainer(); }, EXPLAINER_MS);
}

// ---- alliance selection ---------------------------------------------------
/**
 * The board, straight from the field. Cheesy Arena republishes the whole thing
 * on every pick, so this redraws wholesale rather than trying to animate
 * individual slots: a pick that lands during a redraw would be lost.
 *
 * Empty slots stay visible as gold rules. Watching them fill is the segment.
 */
function paintSelection(sel) {
  if (!sel) return;

  // CalGames picks four per alliance and never calls a backup, so a complete
  // alliance is a captain plus three, and the board shows four slots from the
  // start. Sized off the longest alliance rather than a constant, so a
  // three-pick event still draws a full board instead of a trailing gap.
  const size = Math.max(4, ...sel.alliances.map(a => a.teams.length));

  $('selBoard').innerHTML = sel.alliances.map(a => {
    const picks = a.teams.slice(0, size);
    const slots = Math.max(0, size - picks.length);
    return `<div class="sel-al" style="--n:${size}">
      <div class="sel-al-seed num">${a.id}</div>
      <div class="sel-al-teams">
        ${picks.map((t, i) => `<span class="sel-al-team num"${i === 0 ? ' data-captain' : ''}>${t}</span>`).join('')}
        ${'<span class="sel-al-slot"></span>'.repeat(slots)}
      </div>
    </div>`;
  }).join('');

  // Room-scale legibility beats completeness: the teams near the top of the
  // pool are the ones about to be called, and the rest are a scroll nobody
  // can read from the back of the gym anyway.
  const pool = sel.ranked.slice(0, 24);
  $('selPool').innerHTML = pool.map(r =>
    `<div class="sel-pool-team"${r.picked ? ' data-picked' : ''}>
      <span class="sel-pool-rank">${r.rank}</span>
      <span class="sel-pool-num num">${r.team}</span>
    </div>`).join('');

  $('selClock').hidden = !sel.showTimer;
}

/**
 * Tick the pick clock between messages. The field sends a fresh value once a
 * second, so interpolating from the last one keeps the countdown smooth if a
 * message is late.
 *
 * Only for a couple of seconds, though. If updates stop, the timer was paused
 * or selection moved on, and running our own clock down to a triumphant 0:00
 * would be inventing a deadline the field never called. Past the grace window
 * it freezes exactly where the interpolation stood.
 */
const SELECTION_GRACE_MS = 2500;

// Frames are aged from LOCAL receipt time, never against sel.updatedAt: that
// stamp is the desk server's clock, and an OBS box or pit monitor a minute
// off shifts the on-air countdown by its full skew (behind, it also defeats
// the grace check, so the freeze never engages). Receipt time asks no two
// clocks to agree. The state handler below resets it per fresh frame.
let selSeenAt = 0;
let selStamp = null;

function paintSelectionClock(sel) {
  if (!sel?.showTimer) return;
  // Clamped, not switched: falling back to the raw field value after the
  // grace window visibly replayed the last two seconds on air.
  const age = Math.min(Date.now() - selSeenAt, SELECTION_GRACE_MS);
  const left = Math.max(0, Math.ceil(sel.timeRemainingSec - age / 1000));
  $('selClockNum').textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  $('selClock').toggleAttribute('data-low', left <= 10);
}

// ---- alliance overview ----------------------------------------------------
/**
 * One team, laid out across rather than down.
 *
 * Stacking robots as columns gave each name about 186px and long ones had to
 * shrink to fit. As a row the name gets the whole width beside the plate,
 * roughly 500px, so "Homestead Robotics" sets at full size and a four-team
 * playoff alliance costs height (which there is) instead of width (which there
 * is not).
 *
 * Two shapes, because most teams at an off-season have no photo:
 *   with a photo    plate, then number over name
 *   without a photo the plate carries the number in gold, and the name gets
 *                   the text column to itself at a larger size
 * Either way the number appears exactly once and every name starts at the
 * same x, so a mixed alliance still reads as one list.
 */
function robotCard(team, i) {
  const media = desk.mediaFor(team.number);
  const len = String(team.number).length;
  const art = media
    ? `<div class="robot-art"><img src="${media.src}" alt=""></div>`
    // Fallback must look deliberate, since most teams won't have a photo.
    : `<div class="robot-art"><div class="robot-art--fallback"><span class="num" data-len="${len}">${team.number}</span></div></div>`;
  return `<div class="robot reveal reveal--up" data-photo="${!!media}" style="--i:${i}">
    ${art}
    <div class="robot-id">
      <div class="robot-num num" data-len="${len}">${team.number}</div>
      <div class="robot-name">${escapeHtml(team.name ?? '')}</div>
    </div>
  </div>`;
}

function buildOverview(match) {
  if (!match) return;
  $('ovLabel').textContent = match.displayName ?? '';
  // Row count follows the alliance. Rows share the side's height, so a fourth
  // team makes each row shorter rather than making every name narrower. Both
  // sides take the larger count, so the two halves stay level even when one
  // alliance is short a robot.
  const n = Math.max(1, (match.red ?? []).length, (match.blue ?? []).length);
  // Three-team qualification rows are taller, so the plate can afford to be
  // wider; a four-team playoff tightens it to keep the name column honest.
  // Type grows into the width the row layout freed up. Three-team rows are
  // taller and wider, so they carry the larger step; four still clears the
  // old column layout comfortably.
  const plate = n >= 4 ? '168px' : '200px';
  const nameSize = n >= 4 ? '44px' : '54px';
  const numSize = n >= 4 ? '76px' : '92px';
  for (const id of ['redRobots', 'blueRobots']) {
    $(id).style.setProperty('--n', n);
    $(id).style.setProperty('--plate', plate);
    $(id).style.setProperty('--name-size', nameSize);
    $(id).style.setProperty('--num-size', numSize);
  }
  $('redRobots').innerHTML = (match.red ?? []).map(robotCard).join('');
  $('blueRobots').innerHTML = (match.blue ?? []).map(robotCard).join('');
}

// ---- score bar ------------------------------------------------------------
// Badges, not bare pips: the icon says which bonus, the numeral says the
// threshold, so a viewer arriving mid-match can read the goal off the bar.
// Thresholds come from config and arrive with the first state frame, so the
// strips are rebuilt when they change rather than baked in at load. Rebuilding
// clears the earned flags, so this always runs before the score repaints.
let rpKey = null;

function paintRpStrips(thresholds) {
  const key = JSON.stringify(thresholds ?? null);
  if (key === rpKey) return;
  rpKey = key;
  for (const el of [$('redPips'), $('bluePips'), $('finalRedRp'), $('finalBlueRp')]) {
    el.innerHTML = rpStrip(thresholds);
  }
}

paintRpStrips();

function paintRp(container, rp) {
  for (const badge of container.children) {
    badge.dataset.earned = String(!!rp[badge.dataset.rp]);
  }
}

function paintScore(state) {
  const est = state.confidence === 'estimated';
  for (const side of ['red', 'blue']) {
    const s = state.score[side];
    roll($(`${side}Fuel`), s.fuel);
    roll($(`${side}Tower`), s.tower);
    roll($(`${side}Total`), s.total);
    $(`${side}Total`).dataset.est = String(est);
    paintRp($(`${side}Pips`), s.rp);
  }
}

function paintTeams(match) {
  if (!match) return;
  // A fourth team adds a fourth line inside a fixed-height bar, so the stack
  // tightens rather than growing past it. Three lines keep the full size.
  const n = Math.max((match.red ?? []).length, (match.blue ?? []).length);
  for (const id of ['redTeams', 'blueTeams']) $(id).dataset.rows = String(n);
  $('redTeams').innerHTML = (match.red ?? []).map(t => t.number).join('<br>');
  $('blueTeams').innerHTML = (match.blue ?? []).map(t => t.number).join('<br>');
}

// Where the points came from: fuel and tower by period, plus the points the
// OPPONENT's fouls handed over (which is how fouls enter this side's total).
function paintBreak(el, s, opponentFouls) {
  el.innerHTML = `
    <span></span><span class="fb-h">Fuel</span><span class="fb-h">Tower</span>
    <span class="fb-l">Auto</span><span class="fb-n">${s.autoFuel ?? 0}</span><span class="fb-n">${s.autoTower ?? 0}</span>
    <span class="fb-l">Teleop</span><span class="fb-n">${s.teleopFuel ?? 0}</span><span class="fb-n">${s.teleopTower ?? 0}</span>
    <span class="fb-l">Opponent fouls</span><span class="fb-n fb-span">+${opponentFouls ?? 0}</span>`;
}

function paintFinal(state) {
  const r = state.score.red.total, b = state.score.blue.total;
  // score[side].fouls = points that side CONCEDED, so they land in the other total.
  paintBreak($('finalRedBreak'), state.score.red, state.score.blue.fouls);
  paintBreak($('finalBlueBreak'), state.score.blue, state.score.red.fouls);
  // The escaped nbsp holds the line box like the markup fallback &nbsp; does;
  // a plain space collapses and the final-score header jumps.
  $('finalMatchName').textContent = state.match?.displayName ?? '\u00a0';
  $('finalRed').textContent = r;
  $('finalBlue').textContent = b;
  // Shadow-scored totals render OUTLINED here too, same contract as the score
  // bar: the final screen is the one everyone screenshots, and it must never
  // dress a desk-typed guess up as an official result.
  const est = String(state.confidence === 'estimated');
  $('finalRed').dataset.est = est;
  $('finalBlue').dataset.est = est;
  // The whole alliance, not just the three on the field: in a playoff the
  // fourth pick won this match too, and the social card already names them.
  // The on-air final screen and the card must agree.
  $('finalRedTeams').textContent = allianceRoster(state, 'red').map(t => t.number).join(' · ');
  $('finalBlueTeams').textContent = allianceRoster(state, 'blue').map(t => t.number).join(' · ');
  paintRp($('finalRedRp'), state.score.red.rp);
  paintRp($('finalBlueRp'), state.score.blue.rp);

  $('finalRedSide').toggleAttribute('data-won', r > b);
  $('finalBlueSide').toggleAttribute('data-won', b > r);
  $('finalRedVerdict').textContent = r > b ? 'Winner' : r === b ? 'Tie' : '';
  $('finalBlueVerdict').textContent = b > r ? 'Winner' : r === b ? 'Tie' : '';
}

// ---- status card ----------------------------------------------------------
const STATUS_KIND = {
  delay: 'Field delay', review: 'Under review', fault: 'Arena fault',
  replay: 'Match replay', custom: 'Announcement',
};

function paintStatus(status) {
  const card = $('statusCard');
  if (!status) { card.hidden = true; return; }
  const back = status.backAt
    ? ` (back ~${new Date(status.backAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })})`
    : '';
  $('statusKind').textContent = STATUS_KIND[status.kind] ?? 'Update';
  $('statusMsg').textContent = `${status.message}${back}`;
  card.hidden = false;
}

// ---- lower third ----------------------------------------------------------
/**
 * The show EVENT drives the entrance; state frames only reconcile.
 *
 * The reducer keeps lowerThird set until an explicit hide, and every bus
 * event fans out with full state, so painting the entrance from state frames
 * had two on-air failure modes: any event cadence under the dwell (realtime
 * scoring alone is ~1Hz) re-armed the timer forever, and once the dwell did
 * fire, the next state frame slid the retired third straight back in,
 * looping it on and off air until an operator hid it by hand.
 */
let thirdTimer = null;
let thirdKey = null;       // JSON of the third currently or last shown
let thirdExpired = false;  // dwell retired it; state frames must not resurrect it

function hideThird() {
  const el = $('third');
  clearTimeout(thirdTimer);
  if (!el.hasAttribute('data-show')) return;
  el.className = 'lower-third third--exit';
  const out = parseFloat(getComputedStyle(document.documentElement)
    .getPropertyValue('--dur-out')) || 260;
  // Tracked in thirdTimer so a show landing mid-exit cancels it: a stray
  // timeout here would strip data-show out from under the fresh entrance.
  thirdTimer = setTimeout(() => el.removeAttribute('data-show'), out);
}

function showThird(lt) {
  const el = $('third');
  clearTimeout(thirdTimer);
  thirdKey = JSON.stringify(lt);
  thirdExpired = false;

  $('thirdT1').textContent = lt.line1 ?? '';
  $('thirdT2').textContent = lt.line2 ?? '';
  el.setAttribute('data-show', '');
  el.className = 'lower-third third';

  // Nothing stays up forever waiting on an operator who is busy.
  if (!lt.pinned) {
    const dwell = parseFloat(getComputedStyle(document.documentElement)
      .getPropertyValue('--dwell')) || 8000;
    thirdTimer = setTimeout(() => { thirdExpired = true; hideThird(); }, dwell);
  }
}

function paintThird(lt) {
  if (!lt) {
    thirdKey = null;
    thirdExpired = false;
    hideThird();
    return;
  }
  // Seen already: either on air (leave the dwell alone) or retired (stay
  // retired until a fresh show event or a different payload).
  if (JSON.stringify(lt) === thirdKey) return;
  // Unseen with no show event: the snapshot after a (re)connect.
  showThird(lt);
}

// ---- local clock, derived every frame -------------------------------------
startTicker(() => {
  const st = desk.state;
  if (!st) return;

  const c = desk.matchClock;
  $('clock').textContent = clockDisplayFor(st, c);
  const phase = phaseFor(st, c);
  $('phase').textContent = PHASE_LABEL[phase] ?? phase;

  const hub = phase === 'post' && !st.hubAuthoritative
    ? 'none'
    : hubActiveAt(c, st.autoWinner, st.hubAuthoritative);
  $('hub').dataset.on = hub;
  $('hubText').textContent = hub === 'both' ? 'Both hubs live'
    : hub === 'none' ? '' : `${hub} hub live`;

  // Endgame: suppress decorative motion, keep score and clock running.
  const endgame = c !== null && c >= REBUILT.ENDGAME_START && c < REBUILT.MATCH_END;
  document.documentElement.toggleAttribute('data-lockdown', endgame);

  // Alert Pulse: the gold band pulses three times as endgame opens, then
  // holds steady. The class is added once per entry (cg-pulse runs 3
  // iterations on its own); re-adding it every tick would restart the
  // animation at 10Hz and it would never visibly pulse.
  const bar = $('endgameBar');
  if (endgame && bar.hidden) {
    bar.hidden = false;
    bar.classList.add('pulse');
  } else if (!endgame && !bar.hidden) {
    bar.hidden = true;
    bar.classList.remove('pulse');
  }

  if (currentScreen === 'selection') paintSelectionClock(st.selection);
});

// ---- wiring ---------------------------------------------------------------
let lastMatchId = null;

desk.on('state', state => {
  if (state.match?.id !== lastMatchId) {
    lastMatchId = state.match?.id ?? null;
    buildOverview(state.match);
    paintTeams(state.match);
  }
  paintRpStrips(state.thresholds);
  paintScore(state);
  if (state.screen === 'score') paintFinal(state);
  if (state.selection && state.selection.updatedAt !== selStamp) {
    selStamp = state.selection.updatedAt;
    selSeenAt = Date.now();
  }
  if (state.selection) paintSelection(state.selection);
  paintThird(CLEAN ? null : state.lowerThird);
  paintStatus(CLEAN ? null : state.status);
  showScreen(CLEAN ? 'match' : state.screen);
});

// The event, not the state frame, is the authority for a fresh entrance: an
// operator deliberately re-showing identical text emits an identical payload,
// which the keyed state path in paintThird correctly swallows. Read the
// payload back off state so the key always matches later state frames.
desk.on('lower_third.show', () => {
  if (!CLEAN && desk.state?.lowerThird) showThird(desk.state.lowerThird);
});

// Media can land after the overview was built. Rebuild so a photo uploaded
// on Sunday morning appears without anyone reloading the Browser Source.
desk.on('ready', () => { buildOverview(desk.state?.match); });

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

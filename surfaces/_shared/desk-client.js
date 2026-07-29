/**
 * Shared surface client. Every browser surface imports this and nothing else.
 *
 * Two ideas worth knowing:
 *
 * 1. The clock is derived LOCALLY every frame from `state.matchStartedAt`,
 *    not pushed. The countdown stays smooth through a network hiccup and we
 *    don't spend bandwidth on a number the client can compute.
 *
 * 2. Reconnect is aggressive and silent. A surface is a Browser Source in OBS
 *    that nobody is looking at until it is on air — it must heal itself
 *    without anyone noticing, and never show an error state on the broadcast.
 */

export const REBUILT = {
  AUTO_START: -20, TELEOP_START: 0, TRANSITION_END: 10,
  SHIFT_SECONDS: 25, SHIFT_COUNT: 4, ENDGAME_START: 110, MATCH_END: 140,
  RP_ENERGIZED_FUEL: 100, RP_SUPERCHARGED_FUEL: 360, RP_TRAVERSAL_TOWER: 50,
};

export const PHASE_LABEL = {
  pre: 'Pre-match', auto: 'Auto', transition: 'Transition',
  shift1: 'Shift 1', shift2: 'Shift 2', shift3: 'Shift 3', shift4: 'Shift 4',
  endgame: 'End game', post: 'Final',
};

export function phaseAt(c) {
  if (c === null || c < REBUILT.AUTO_START) return 'pre';
  if (c < REBUILT.TELEOP_START) return 'auto';
  if (c < REBUILT.TRANSITION_END) return 'transition';
  if (c < REBUILT.ENDGAME_START) {
    const n = Math.floor((c - REBUILT.TRANSITION_END) / REBUILT.SHIFT_SECONDS) + 1;
    return `shift${Math.min(n, REBUILT.SHIFT_COUNT)}`;
  }
  if (c < REBUILT.MATCH_END) return 'endgame';
  return 'post';
}

export function hubActiveAt(c, autoWinner) {
  const phase = phaseAt(c);
  if (phase === 'pre' || phase === 'post') return 'none';
  if (phase === 'auto' || phase === 'transition' || phase === 'endgame') return 'both';
  if (!autoWinner) return 'both';
  const shift = Number(phase.slice(-1));
  return shift % 2 === 1 ? autoWinner : (autoWinner === 'red' ? 'blue' : 'red');
}

export function clockDisplay(c) {
  if (c === null) return '0:20';
  const remaining = c < REBUILT.TELEOP_START ? -c : REBUILT.MATCH_END - c;
  const s = Math.max(0, Math.ceil(remaining));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

class DeskClient extends EventTarget {
  state = null;
  media = {};
  connected = false;
  /** Server clock minus ours. Small, but it makes the countdown honest. */
  #skew = 0;
  #ws = null;
  #backoff = 250;
  #name;

  constructor(name) {
    super();
    this.#name = name;
    this.#connect();
  }

  #connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws?surface=${this.#name}`);
    this.#ws = ws;

    ws.onopen = () => {
      this.connected = true;
      this.#backoff = 250;
      this.dispatchEvent(new CustomEvent('link', { detail: true }));
    };

    ws.onmessage = e => {
      const msg = JSON.parse(e.data);
      if (msg.t === 'snapshot') {
        this.media = msg.media ?? {};
        this.#apply(msg.state);
        this.dispatchEvent(new CustomEvent('ready'));
      } else if (msg.t === 'event') {
        this.#apply(msg.state);
        this.dispatchEvent(new CustomEvent('desk', { detail: msg.ev }));
        this.dispatchEvent(new CustomEvent(msg.ev.type, { detail: msg.ev }));
      } else if (msg.t === 'relay') {
        this.dispatchEvent(new CustomEvent(`relay:${msg.channel}`, { detail: msg.data }));
      }
    };

    ws.onclose = () => {
      this.connected = false;
      this.dispatchEvent(new CustomEvent('link', { detail: false }));
      setTimeout(() => this.#connect(), this.#backoff);
      this.#backoff = Math.min(this.#backoff * 2, 5000);
    };
    ws.onerror = () => ws.close();
  }

  #apply(state) {
    if (state.updatedAt) this.#skew = state.updatedAt - Date.now();
    this.state = state;
    this.dispatchEvent(new CustomEvent('state', { detail: state }));
  }

  /** Live match clock, computed here rather than pushed. */
  get matchClock() {
    const started = this.state?.matchStartedAt;
    if (!started) return this.state?.matchClock ?? null;
    return (Date.now() + this.#skew - started) / 1000 + REBUILT.AUTO_START;
  }

  emit(init) {
    if (this.#ws?.readyState === WebSocket.OPEN) {
      this.#ws.send(JSON.stringify({ t: 'emit', init }));
    }
  }

  /**
   * Ephemeral broadcast that bypasses the event bus and the log. For data
   * that arrives at pointer rate and is worthless a second later — telestrator
   * strokes, scrub positions. Never use it for anything the archive needs.
   */
  relay(channel, data) {
    if (this.#ws?.readyState === WebSocket.OPEN) {
      this.#ws.send(JSON.stringify({ t: 'relay', channel, data }));
    }
  }

  on(type, fn) { this.addEventListener(type, e => fn(e.detail)); return this; }

  /** Robot cutout for a team, or null so callers hit the fallback plinth. */
  mediaFor(team) { return this.media[team] ?? null; }
}

/**
 * Reads ?key= and ?scale= onto <html>, so one URL configures a surface for
 * OBS alpha vs. a Blackmagic luma key, and for stream vs. venue legibility.
 */
export function applyDisplayMode() {
  const p = new URLSearchParams(location.search);
  const root = document.documentElement;
  root.dataset.key = p.get('key') || 'alpha';
  root.dataset.scale = p.get('scale') || 'stream';
  if (p.get('surface')) root.dataset.surface = p.get('surface');
  return p;
}

/**
 * Number Roll. Counts to the new value with tabular figures so nothing
 * reflows — at 140px the changing digit shapes are visible across a gym even
 * when the exact value isn't.
 *
 * Jumps straight to the value while hidden: requestAnimationFrame does not
 * fire in a backgrounded page, so an animated roll started while hidden would
 * strand the element on a stale number. Nobody is watching a hidden source, so
 * the animation is worthless there — but the correct value is not.
 */
export function roll(el, to, ms = 600) {
  const from = Number(el.dataset.v ?? 0);
  if (from === to) return;
  el.dataset.v = String(to);

  if (document.hidden) { el.textContent = String(to); return; }

  const t0 = performance.now();
  const step = now => {
    const p = Math.min(1, (now - t0) / ms);
    el.textContent = String(Math.round(from + (to - from) * (1 - (1 - p) ** 3)));
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/**
 * Per-frame paint loop with a backstop.
 *
 * OBS throttles — and with "shutdown source when not visible" effectively
 * pauses — Browser Sources that aren't on a live scene, and rAF stops firing
 * entirely in a hidden page. A clock driven by rAF alone freezes at whatever
 * it read when the source went off-scene, then snaps forward when it returns.
 * On a scoreboard that is very visible.
 *
 * So: rAF while visible, a 250ms interval as the backstop (browsers clamp
 * background timers to ~1s, which is fine because nobody can see it), and an
 * immediate repaint the moment the page becomes visible again.
 */
export function startTicker(fn) {
  let raf = 0;
  const paint = () => { try { fn(); } catch (err) { console.error('[ticker]', err); } };

  const frame = () => { paint(); raf = requestAnimationFrame(frame); };
  const backstop = setInterval(() => { if (document.hidden) paint(); }, 250);

  document.addEventListener('visibilitychange', () => {
    cancelAnimationFrame(raf);
    paint();
    if (!document.hidden) raf = requestAnimationFrame(frame);
  });

  paint();
  if (!document.hidden) raf = requestAnimationFrame(frame);

  return () => { cancelAnimationFrame(raf); clearInterval(backstop); };
}

/** Re-trigger a CSS animation that may already have run. */
export function restart(el, attr = 'data-run') {
  el.removeAttribute(attr);
  void el.offsetWidth;
  el.setAttribute(attr, '');
}

export const connect = name => new DeskClient(name);

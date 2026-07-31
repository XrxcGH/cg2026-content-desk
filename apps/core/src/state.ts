/**
 * Snapshot reducer. Pure: (state, event) -> state.
 *
 * Pure matters here: it's what lets us replay an NDJSON log from Friday's
 * practice matches and get byte-identical state, which is how graphics get
 * built and tested in March with no field.
 */

import { clockDisplay, clockFrom, hubActiveAt, isLockdown, phaseAt } from './clock.ts';
import {
  emptyAllianceScore, REBUILT,
  type Alliance, type AllianceScore, type DeskEvent, type DeskState, type RpThresholds,
} from './types.ts';

/** Sums, totals, and bonus RPs are always derived, never trusted from the
 *  wire. The auto/teleop parts are the source of truth; fuel and tower are
 *  their sums. */
function settle(s: AllianceScore, opponentFouls: number, t: RpThresholds): AllianceScore {
  const fuel = s.autoFuel + s.teleopFuel;
  const tower = s.autoTower + s.teleopTower;
  return {
    ...s,
    fuel,
    tower,
    total: fuel + tower + opponentFouls,
    // Scored against the live thresholds, never the defaults in REBUILT: an
    // off-season event can move these, and a badge that lights at a number
    // nobody is playing to is worse than no badge.
    rp: {
      energized: fuel >= t.energizedFuel,
      supercharged: fuel >= t.superchargedFuel,
      traversal: tower >= t.traversalTower,
    },
  };
}

function withScore(state: DeskState, side: Alliance, patch: Partial<AllianceScore>): DeskState {
  const other: Alliance = side === 'red' ? 'blue' : 'red';
  const merged = { ...state.score[side], ...patch };
  return {
    ...state,
    score: {
      [side]: settle(merged, state.score[other].fouls, state.thresholds),
      [other]: settle(state.score[other], merged.fouls, state.thresholds),
    } as Record<Alliance, AllianceScore>,
  };
}

/** Re-score both alliances, for when the thresholds themselves change. */
function rescore(state: DeskState): DeskState {
  return {
    ...state,
    score: {
      red: settle(state.score.red, state.score.blue.fouls, state.thresholds),
      blue: settle(state.score.blue, state.score.red.fouls, state.thresholds),
    },
  };
}

/** Recompute everything that follows from the clock. */
function retime(state: DeskState, now: number): DeskState {
  const c = clockFrom(state.matchStartedAt, now);
  // A null clock is ambiguous: before the first match it means pre-match, but
  // after the buzzer (match.end clears matchStartedAt to stop the clock) it
  // means the match is OVER. Showing "Pre-match 0:20" over a finished match
  // confused everyone; matchEndedAt is the tiebreaker, and match.loaded
  // clears it for the next cycle.
  const ended = c === null && state.matchEndedAt !== null;
  return {
    ...state,
    matchClock: c,
    phase: ended ? 'post' : phaseAt(c),
    clockDisplay: ended ? '0:00' : clockDisplay(c),
    // The field's own answer wins; inference is the desk-only fallback.
    hubActive: state.hubAuthoritative ?? (ended ? 'none' : hubActiveAt(c, state.autoWinner)),
    lockdown: isLockdown(c),
  };
}

/**
 * Apply an automatic screen change, unless an operator is holding the screen.
 * Every other part of the event still lands; only the screen is left alone.
 */
const auto = (state: DeskState, screen: string): string =>
  state.screenHold ? state.screen : screen;

export function reduce(state: DeskState, ev: DeskEvent): DeskState {
  const next = ((): DeskState => {
    switch (ev.type) {
      case 'match.loaded': {
        const p = ev.payload as DeskState['match'];
        return {
          ...state,
          match: p,
          matchStartedAt: null,
          lastMatchStartedAt: null,
          matchEndedAt: null,
          scorePostedAt: null,
          autoWinner: null,
          autoWinnerKnown: false,
          hubAuthoritative: null,
          score: { red: emptyAllianceScore(), blue: emptyAllianceScore() },
          confidence: ev.confidence,
          screen: auto(state, 'overview'),
        };
      }

      case 'match.preview':
        return { ...state, screen: auto(state, 'overview') };

      // Field reset between matches. Deliberately no screen change: the next
      // match's `match.loaded` owns the transition back to the overview.
      // Prestart is also how a timeout visibly ends (TimeoutActive returns
      // through PreMatch), so it retires the automatic timeout card. Only
      // that one: an operator card carries the producer's wording and stays
      // until they clear it themselves.
      case 'match.prestart':
        return state.status?.message === 'Field timeout'
          ? { ...state, status: null }
          : state;

      // The field is armed and ready: every robot linked, scorekeeper about to
      // hand it to the announcer. Flip to the score bar NOW, so the graphic is
      // already in place when the countdown starts, never mid-"3, 2, 1".
      case 'match.armed':
        return { ...state, screen: auto(state, 'match') };

      case 'match.start':
        return { ...state, matchStartedAt: ev.ts, lastMatchStartedAt: ev.ts, screen: auto(state, 'match') };

      case 'match.auto_end': {
        // HEURISTIC, and only used when running desk-only. Cheesy Arena decides
        // the auto winner on AUTO FUEL ALONE (`redWonAuto = redAutoFuel >
        // blueAutoFuel`), tower climbs do not count, so an alliance can score
        // 15 auto points from a climb and still lose auto. We don't track auto
        // fuel separately here, so this compares totals and can disagree.
        //
        // When the Cheesy bridge is up the adapter emits the real answer via
        // `hub.state`, and `hubAuthoritative` overrides all of this anyway.
        if (state.autoWinnerKnown) return state;        // never override the field
        const { red, blue } = state.score;
        const winner: Alliance | null =
          red.total > blue.total ? 'red' : blue.total > red.total ? 'blue' : null;
        return { ...state, autoWinner: winner };
      }

      // Cheesy Arena pauses between auto and teleop, and the pause length is
      // not fixed, so a clock anchored only at match.start ran ahead of the
      // field for the whole teleop: shifts, endgame, and the synthesized
      // buzzer all fired early by the pause length, and the field's real
      // match.end then landed as a duplicate. The field bridge emits this at
      // the teleop transition; re-anchoring puts matchClock at exactly 0
      // there, on the field's own axis. lastMatchStartedAt keeps the true
      // wall-clock start for clip cutting. Desk-only operation never sees
      // this event and the clock simply stays contiguous.
      case 'match.teleop_start':
        return state.matchStartedAt === null ? state
          : { ...state, matchStartedAt: ev.ts + REBUILT.AUTO_START * 1000 };

      case 'match.aborted':
        return { ...state, matchStartedAt: null, screen: auto(state, 'match') };

      // Keep matchStartedAt so the clip cutter can still map the match onto
      // wall clock after the buzzer. The clock itself stops via matchEndedAt.
      case 'match.end':
        return { ...state, matchEndedAt: ev.ts, matchStartedAt: null };

      case 'match.score_posted':
        return { ...state, scorePostedAt: ev.ts, screen: auto(state, 'score'), confidence: ev.confidence };

      // A full snapshot can restore authority: it replaces every number.
      case 'score.realtime': {
        const p = ev.payload as Partial<Record<Alliance, Partial<AllianceScore>>>;
        let s = { ...state, confidence: ev.confidence };
        if (p.red) s = withScore(s, 'red', p.red);
        if (p.blue) s = withScore(s, 'blue', p.blue);
        return s;
      }

      // A delta cannot. Once a shadow-scored guess is folded into the total,
      // the total contains a guess, and it stays `estimated` until an
      // authoritative snapshot overwrites the whole thing. This is what makes
      // the outlined-numeral treatment on air honest rather than decorative.
      case 'score.delta': {
        const p = ev.payload as { alliance: Alliance; field: 'fuel' | 'tower' | 'fouls'; amount: number };
        const cur = state.score[p.alliance];
        // Attribute the delta to a period by the clock AT THE EVENT'S OWN
        // TIME: state.matchClock is only retimed after each event lands, so
        // reading it here would use the previous event's clock. A shadow-scored
        // "+5 fuel" during auto is auto fuel; the breakdown stays honest even
        // when the whole match is typed by hand.
        const at = clockFrom(state.matchStartedAt, ev.ts);
        const inAuto = at !== null && at < 0;
        const part = p.field === 'fouls' ? 'fouls' as const
          : p.field === 'fuel' ? (inAuto ? 'autoFuel' as const : 'teleopFuel' as const)
          : (inAuto ? 'autoTower' as const : 'teleopTower' as const);
        const scored = withScore(state, p.alliance, { [part]: cur[part] + p.amount });
        return ev.confidence === 'estimated'
          ? { ...scored, confidence: 'estimated' }
          : scored;
      }

      case 'hub.state': {
        const p = ev.payload as {
          autoWinner?: Alliance | null;
          active?: Alliance | 'both' | 'none' | null;
        };
        return {
          ...state,
          ...(p.autoWinner !== undefined
            ? { autoWinner: p.autoWinner, autoWinnerKnown: true }
            : {}),
          ...(p.active !== undefined ? { hubAuthoritative: p.active } : {}),
        };
      }

      case 'lower_third.show':
        return { ...state, lowerThird: ev.payload as DeskState['lowerThird'] };

      case 'lower_third.hide':
        return { ...state, lowerThird: null };

      // Strokes themselves never come through here. They're relayed off-bus
      // at pointer rate (see server.ts). What lands on the bus is the durable
      // part: who's drawing, what frame they're drawing on, and whether the
      // render surface is live.
      case 'telestrator.frame': {
        const p = ev.payload as Partial<DeskState['telestrator']>;
        return { ...state, telestrator: { ...state.telestrator, ...p, hidden: false } };
      }

      case 'telestrator.hide':
        return { ...state, telestrator: { ...state.telestrator, hidden: true } };

      /**
       * A take from an operator, or the release back to automatic.
       *
       * "auto" is not a screen: it hands control back and leaves whatever is
       * on air alone until the next lifecycle event moves it.
       */
      case 'screen.change': {
        const wanted = (ev.payload as { screen: string }).screen;
        // Automation rides the same event as the operator, so the source is
        // all that separates a cue from a take. A cue must respect a manual
        // hold and never set or release one: treating cue changes as takes
        // froze automatic screen switching the moment any screen cue armed.
        if (ev.source === 'cue') {
          return wanted === 'auto' ? state : { ...state, screen: auto(state, wanted) };
        }
        if (wanted === 'auto') return { ...state, screenHold: false };
        return { ...state, screen: wanted, screenHold: true };
      }

      case 'rankings.updated': {
        const p = ev.payload as { rankings?: DeskState['rankings']; highestPlayedMatch?: string };
        return {
          ...state,
          rankings: p.rankings ?? state.rankings,
          highestPlayedMatch: p.highestPlayedMatch ?? state.highestPlayedMatch,
        };
      }

      case 'queue.updated': {
        const p = ev.payload as { upcoming?: DeskState['upcoming'] };
        return { ...state, upcoming: p.upcoming ?? state.upcoming };
      }

      case 'arena.status':
        return { ...state, connected: { ...state.connected, ...(ev.payload as object) } };

      case 'pace.updated':
        return { ...state, pace: ev.payload as DeskState['pace'] };

      case 'status.show':
        return { ...state, status: ev.payload as DeskState['status'] };

      case 'status.hide':
        return { ...state, status: null };

      // A field timeout raises the delay card on its own, so the stoppage is
      // explained even if nobody at the desk reacts. Never over an
      // operator-set card: the producer's wording wins. It clears itself when
      // the field moves on, via the match lifecycle cases below clearing
      // status only when it was this automatic card (marked by its message).
      case 'break.started':
        return state.status !== null ? state
          : { ...state, status: { kind: 'delay', message: 'Field timeout', backAt: null } };

      // Thresholds arrive from config at boot. Re-scoring immediately means a
      // mid-event correction repaints every badge instead of waiting for the
      // next score packet to happen along.
      case 'game.thresholds': {
        const p = ev.payload as Partial<RpThresholds> | null;
        if (!p) return state;
        return rescore({
          ...state,
          thresholds: { ...state.thresholds, ...p },
        });
      }

      /**
       * Selection republishes the whole board on every pick and once a second
       * while the clock runs, so this replaces rather than merges. The field
       * is the only writer; nothing here ever edits an alliance.
       */
      case 'alliance_selection.update': {
        const p = ev.payload as DeskState['selection'];
        return p ? { ...state, selection: { ...p, updatedAt: ev.ts } } : state;
      }

      default:
        return state;
    }
  })();

  return { ...retime(next, ev.ts), updatedAt: ev.ts };
}

/** Called by the server ticker so phase transitions land without an event. */
export const tick = (state: DeskState, now = Date.now()): DeskState => retime(state, now);

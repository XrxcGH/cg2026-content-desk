/**
 * Snapshot reducer. Pure: (state, event) -> state.
 *
 * Pure matters here — it's what lets us replay an NDJSON log from Friday's
 * practice matches and get byte-identical state, which is how graphics get
 * built and tested in March with no field.
 */

import { clockDisplay, clockFrom, hubActiveAt, isLockdown, phaseAt } from './clock.ts';
import {
  REBUILT, emptyAllianceScore,
  type Alliance, type AllianceScore, type DeskEvent, type DeskState,
} from './types.ts';

/** Totals and bonus RPs are always derived, never trusted from the wire. */
function settle(s: AllianceScore, opponentFouls: number): AllianceScore {
  return {
    ...s,
    total: s.fuel + s.tower + opponentFouls,
    rp: {
      energized: s.fuel >= REBUILT.RP_ENERGIZED_FUEL,
      supercharged: s.fuel >= REBUILT.RP_SUPERCHARGED_FUEL,
      traversal: s.tower >= REBUILT.RP_TRAVERSAL_TOWER,
    },
  };
}

function withScore(state: DeskState, side: Alliance, patch: Partial<AllianceScore>): DeskState {
  const other: Alliance = side === 'red' ? 'blue' : 'red';
  const merged = { ...state.score[side], ...patch };
  return {
    ...state,
    score: {
      [side]: settle(merged, state.score[other].fouls),
      [other]: settle(state.score[other], merged.fouls),
    } as Record<Alliance, AllianceScore>,
  };
}

/** Recompute everything that follows from the clock. */
function retime(state: DeskState, now: number): DeskState {
  const c = clockFrom(state.matchStartedAt, now);
  return {
    ...state,
    matchClock: c,
    phase: phaseAt(c),
    clockDisplay: clockDisplay(c),
    hubActive: hubActiveAt(c, state.autoWinner),
    lockdown: isLockdown(c),
  };
}

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
          score: { red: emptyAllianceScore(), blue: emptyAllianceScore() },
          confidence: ev.confidence,
          screen: 'overview',
        };
      }

      case 'match.preview':
        return { ...state, screen: 'overview' };

      case 'match.prestart':
      case 'match.armed':
        return { ...state, screen: 'match' };

      case 'match.start':
        return { ...state, matchStartedAt: ev.ts, lastMatchStartedAt: ev.ts, screen: 'match' };

      case 'match.auto_end': {
        // Whoever led at the buzzer owns the odd shifts. Ties leave it null,
        // which renders as "both hubs live" rather than a guess.
        const { red, blue } = state.score;
        const winner: Alliance | null =
          red.total > blue.total ? 'red' : blue.total > red.total ? 'blue' : null;
        return { ...state, autoWinner: winner };
      }

      case 'match.aborted':
        return { ...state, matchStartedAt: null, screen: 'match' };

      // Keep matchStartedAt so the clip cutter can still map the match onto
      // wall clock after the buzzer. The clock itself stops via matchEndedAt.
      case 'match.end':
        return { ...state, matchEndedAt: ev.ts, matchStartedAt: null };

      case 'match.score_posted':
        return { ...state, scorePostedAt: ev.ts, screen: 'score', confidence: ev.confidence };

      // A full snapshot can restore authority — it replaces every number.
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
        const scored = withScore(state, p.alliance, { [p.field]: cur[p.field] + p.amount });
        return ev.confidence === 'estimated'
          ? { ...scored, confidence: 'estimated' }
          : scored;
      }

      case 'hub.state':
        return { ...state, autoWinner: (ev.payload as { autoWinner: Alliance | null }).autoWinner };

      case 'lower_third.show':
        return { ...state, lowerThird: ev.payload as DeskState['lowerThird'] };

      case 'lower_third.hide':
        return { ...state, lowerThird: null };

      // Strokes themselves never come through here — they're relayed off-bus
      // at pointer rate (see server.ts). What lands on the bus is the durable
      // part: who's drawing, what frame they're drawing on, and whether the
      // render surface is live.
      case 'telestrator.frame': {
        const p = ev.payload as Partial<DeskState['telestrator']>;
        return { ...state, telestrator: { ...state.telestrator, ...p, hidden: false } };
      }

      case 'telestrator.hide':
        return { ...state, telestrator: { ...state.telestrator, hidden: true } };

      case 'screen.change':
        return { ...state, screen: (ev.payload as { screen: string }).screen };

      case 'arena.status':
        return { ...state, connected: { ...state.connected, ...(ev.payload as object) } };

      default:
        return state;
    }
  })();

  return { ...retime(next, ev.ts), updatedAt: ev.ts };
}

/** Called by the server ticker so phase transitions land without an event. */
export const tick = (state: DeskState, now = Date.now()): DeskState => retime(state, now);

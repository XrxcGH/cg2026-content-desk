/**
 * Match clock. The single continuous axis everything keys off — replay
 * scrubbing, auto markers, post-match cards. See docs/02-architecture.md.
 *
 *   -20 .. 0    AUTO
 *     0 .. 10   Transition Shift
 *    10 .. 110  Shifts 1-4 (25s each)
 *   110 .. 140  End Game
 */

import { REBUILT, type Alliance, type Phase } from './types.ts';

export function phaseAt(c: number | null): Phase {
  if (c === null || c < REBUILT.AUTO_START) return 'pre';
  if (c < REBUILT.TELEOP_START) return 'auto';
  if (c < REBUILT.TRANSITION_END) return 'transition';
  if (c < REBUILT.ENDGAME_START) {
    const n = Math.floor((c - REBUILT.TRANSITION_END) / REBUILT.SHIFT_SECONDS) + 1;
    return `shift${Math.min(n, REBUILT.SHIFT_COUNT)}` as Phase;
  }
  if (c < REBUILT.MATCH_END) return 'endgame';
  return 'post';
}

export const PHASE_LABEL: Record<Phase, string> = {
  pre: 'Pre-match', auto: 'Auto', transition: 'Transition',
  shift1: 'Shift 1', shift2: 'Shift 2', shift3: 'Shift 3', shift4: 'Shift 4',
  endgame: 'End game', post: 'Final',
};

/**
 * Both hubs are active in AUTO, the Transition Shift, and End Game. During
 * Shifts 1-4 they alternate, with the auto winner's hub live on odd shifts.
 * Unknown auto winner means we can't say — 'both' is the safe display.
 */
export function hubActiveAt(c: number | null, autoWinner: Alliance | null): Alliance | 'both' | 'none' {
  const phase = phaseAt(c);
  if (phase === 'pre' || phase === 'post') return 'none';
  if (phase === 'auto' || phase === 'transition' || phase === 'endgame') return 'both';
  if (!autoWinner) return 'both';

  const shift = Number(phase.slice(-1));
  const other: Alliance = autoWinner === 'red' ? 'blue' : 'red';
  return shift % 2 === 1 ? autoWinner : other;
}

/**
 * The countdown as the audience sees it: auto counts 0:20 -> 0:00, then
 * teleop restarts at 2:20. Not the same as the internal axis.
 */
export function clockDisplay(c: number | null): string {
  if (c === null) return '0:20';
  const remaining = c < REBUILT.TELEOP_START ? -c : REBUILT.MATCH_END - c;
  const s = Math.max(0, Math.ceil(remaining));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Endgame suppresses decorative motion but not the score or clock. */
export const isLockdown = (c: number | null): boolean =>
  c !== null && c >= REBUILT.ENDGAME_START && c < REBUILT.MATCH_END;

/** Derive matchClock from a wall-clock match start. */
export const clockFrom = (startedAt: number | null, now = Date.now()): number | null =>
  startedAt === null ? null : (now - startedAt) / 1000 + REBUILT.AUTO_START;
